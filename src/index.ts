/**
 * GitHub Action entrypoint.
 *
 * Reads the config file, validates it, and converges Railway infrastructure.
 * If new resources are provisioned (databases), the config is updated with
 * Railway-assigned IDs and committed back to the repo.
 */

import { resolve } from 'node:path';

import * as core from '@actions/core';
import { exec } from '@actions/exec';

import { loadConfig, saveConfig } from './config.js';
import { converge } from './converge.js';

async function installRailwayCli(): Promise<void> {
  core.startGroup('Installing Railway CLI');
  await exec('npm', ['install', '-g', '@railway/cli']);
  core.endGroup();
}

/**
 * Commit updated config file back to the repo so Railway-assigned
 * resource IDs are persisted for subsequent deploys.
 */
async function commitConfigChanges(configPath: string): Promise<void> {
  core.startGroup('Committing config changes');

  await exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  await exec('git', ['add', configPath]);
  await exec('git', ['commit', '-m', 'chore: save Railway resource IDs to deploy config']);
  await exec('git', ['push']);

  core.endGroup();
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true });
    const configInput = core.getInput('config');
    const configPath = configInput !== '' ? configInput : 'railway-deploy.jsonc';

    // Set the token for the Railway CLI
    core.exportVariable('RAILWAY_API_TOKEN', token);
    // Mask it from logs
    core.setSecret(token);

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

    const result = await converge(config, repoRoot);

    // Save and commit config if Railway-assigned IDs were added
    if (result.configChanged) {
      core.info('Config changed — saving Railway resource IDs...');
      saveConfig(fullConfigPath, config);
      await commitConfigChanges(configPath);
    }

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
