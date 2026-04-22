/**
 * GitHub Action entrypoint.
 *
 * Reads the config file, validates it, and converges Railway infrastructure.
 * If new resources are provisioned, the config is updated with
 * Railway-assigned IDs and committed back to the repo immediately.
 */

import { resolve } from 'node:path';

import * as core from '@actions/core';
import { exec } from '@actions/exec';

import { loadConfig } from './config.js';
import { converge } from './converge.js';

async function installRailwayCli(): Promise<void> {
  core.startGroup('Installing Railway CLI');
  await exec('npm', ['install', '-g', '@railway/cli']);
  core.endGroup();
}

/**
 * Verify that git push will work before creating any resources.
 */
async function verifyGitPushAccess(): Promise<void> {
  core.startGroup('Verifying git push access');

  const { getExecOutput } = await import('@actions/exec');
  const pushResult = await getExecOutput('git', ['push', '--dry-run'], {
    silent: true,
    ignoreReturnCode: true,
  });

  if (pushResult.exitCode !== 0) {
    throw new Error(
      'Git push access is required but not available. ' +
        'Add "permissions: contents: write" to your workflow file.'
    );
  }

  core.info('Git push access verified');

  await exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

  core.endGroup();
}

/**
 * Commit a file and push to the repo.
 */
async function commitAndPush(configPath: string, message: string): Promise<void> {
  await exec('git', ['add', configPath]);
  await exec('git', ['commit', '-m', message]);
  await exec('git', ['push']);
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true });
    const workspaceId = core.getInput('workspace', { required: true });
    const configInput = core.getInput('config');
    const configPath = configInput !== '' ? configInput : 'railway-deploy.jsonc';

    // Set the token for the Railway CLI (used only by `railway up`)
    core.exportVariable('RAILWAY_API_TOKEN', token);
    // Mask it from logs
    core.setSecret(token);

    // Verify push access before doing anything destructive
    await verifyGitPushAccess();

    // Only needed for `railway up`
    await installRailwayCli();

    const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const fullConfigPath = resolve(repoRoot, configPath);

    core.info(`Loading config from ${fullConfigPath}`);
    const config = loadConfig(fullConfigPath);
    core.info(`Config version: ${config.version}`);
    core.info(`Project: ${config.project.name}`);
    const dbNames = config.databases.map((d) => d.name).join(', ');
    const svcNames = config.services.map((s) => s.name).join(', ');
    core.info(`Databases: ${dbNames !== '' ? dbNames : 'none'}`);
    core.info(`Services: ${svcNames !== '' ? svcNames : 'none'}`);

    const result = await converge(
      config,
      workspaceId,
      repoRoot,
      fullConfigPath,
      (message: string) => commitAndPush(configPath, message)
    );

    // Set outputs for each service URL (keyed by service name)
    for (const svc of result.services) {
      core.setOutput(`${svc.name}_url`, svc.url);
    }

    // Convenience: if there's exactly one service, also set a generic `service_url`
    const firstService = result.services[0];
    if (result.services.length === 1 && firstService != null) {
      core.setOutput('service_url', firstService.url);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

void run();
