/**
 * Infrastructure convergence logic.
 *
 * Reads the desired state from the config and converges Railway
 * infrastructure to match. Every operation is idempotent — running
 * this multiple times produces the same result.
 *
 * All resources follow the same pattern:
 *   - No railwayId → create with desired name, save ID, commit & push
 *   - Has railwayId → verify it exists, rename if name doesn't match
 */

import * as core from '@actions/core';

import type { Config } from './config.js';
import { saveConfig } from './config.js';
import {
  createDatabase,
  createProject,
  createService,
  deploy,
  ensureDomain,
  getProductionEnvironmentId,
  getProject,
  getServices,
  renameProject,
  renameService,
  setVariable,
} from './railway.js';

function requireId(name: string, railwayId: string | undefined): string {
  if (railwayId == null) {
    throw new Error(`Expected railwayId for '${name}' to be set by this point`);
  }
  return railwayId;
}

export interface ConvergeResult {
  services: Array<{ name: string; url: string }>;
}

export async function converge(
  config: Config,
  workspaceId: string,
  repoRoot: string,
  configPath: string,
  commitAndPush: (message: string) => Promise<void>
): Promise<ConvergeResult> {
  // Step 1: Converge project
  core.startGroup(`Converging project '${config.project.name}'`);

  if (config.project.railwayId == null) {
    core.info(`Creating project '${config.project.name}'...`);
    const project = await createProject(config.project.name, workspaceId);
    config.project.railwayId = project.id;
    core.info(`Created project: ${project.id}`);
    saveConfig(configPath, config);
    await commitAndPush(`chore: save Railway ID for project '${config.project.name}'`);
  } else {
    const project = await getProject(config.project.railwayId);
    if (project == null) {
      throw new Error(
        `Project '${config.project.name}' has railwayId '${config.project.railwayId}' ` +
          `but no matching project exists in Railway. Remove the railwayId to re-create it.`
      );
    }
    if (project.name !== config.project.name) {
      core.info(`Renaming project '${project.name}' → '${config.project.name}'...`);
      await renameProject(config.project.railwayId, config.project.name);
    } else {
      core.info(`Project '${config.project.name}' exists (${config.project.railwayId})`);
    }
  }

  const projectId = config.project.railwayId;
  const environmentId = await getProductionEnvironmentId(projectId);
  core.endGroup();

  // Step 2: Check for unrecognized services
  core.startGroup('Checking for unrecognized services');

  const allServices = await getServices(projectId);
  const knownIds = new Set([
    ...config.databases.filter((d) => d.railwayId != null).map((d) => d.railwayId),
    ...config.services.filter((s) => s.railwayId != null).map((s) => s.railwayId),
  ]);

  const unrecognized = allServices.filter((s) => !knownIds.has(s.id));

  if (unrecognized.length > 0) {
    const list = unrecognized
      .map(
        (s) =>
          `  - ${s.name} (${s.id})\n    https://railway.com/project/${projectId}/service/${s.id}`
      )
      .join('\n');
    throw new Error(
      `Unrecognized services found in Railway that are not in the deploy config:\n${list}\n\n` +
        `This can happen if a previous deploy created a resource but failed before saving its ID.\n` +
        `Either add the railwayId to your config to adopt it, or delete it from the Railway dashboard.`
    );
  }

  core.info(`All ${allServices.length} services in Railway are accounted for`);
  core.endGroup();

  // Step 3: Converge databases
  core.startGroup('Converging databases');

  for (const db of config.databases) {
    if (db.railwayId == null) {
      core.info(`Provisioning ${db.type} database '${db.name}'...`);
      const created = await createDatabase(projectId, environmentId, db.type, db.name);
      db.railwayId = created.id;
      core.info(`Created database '${db.name}': ${created.id}`);
      saveConfig(configPath, config);
      await commitAndPush(`chore: save Railway ID for database '${db.name}'`);
    } else {
      const existing = allServices.find((s) => s.id === db.railwayId);
      if (existing == null) {
        throw new Error(
          `Database '${db.name}' has railwayId '${db.railwayId}' but no matching service exists in Railway. ` +
            `It may have been deleted. Remove the railwayId from the config to re-create it.`
        );
      }
      if (existing.name !== db.name) {
        core.info(`Renaming database '${existing.name}' → '${db.name}'...`);
        await renameService(db.railwayId, db.name);
      } else {
        core.info(`Database '${db.name}' already provisioned (${db.railwayId})`);
      }
    }
  }

  core.endGroup();

  // Step 4: Converge services
  core.startGroup('Converging services');

  for (const svc of config.services) {
    if (svc.railwayId == null) {
      core.info(`Creating service '${svc.name}'...`);
      const created = await createService(projectId, svc.name);
      svc.railwayId = created.id;
      core.info(`Created service '${svc.name}': ${created.id}`);
      saveConfig(configPath, config);
      await commitAndPush(`chore: save Railway ID for service '${svc.name}'`);
    } else {
      const existing = allServices.find((s) => s.id === svc.railwayId);
      if (existing == null) {
        throw new Error(
          `Service '${svc.name}' has railwayId '${svc.railwayId}' but no matching service exists in Railway. ` +
            `It may have been deleted. Remove the railwayId to re-create it.`
        );
      }
      if (existing.name !== svc.name) {
        core.info(`Renaming service '${existing.name}' → '${svc.name}'...`);
        await renameService(svc.railwayId, svc.name);
      } else {
        core.info(`Service '${svc.name}' already exists (${svc.railwayId})`);
      }
    }
  }

  core.endGroup();

  // Step 5: Set variables
  core.startGroup('Setting variables');

  for (const svc of config.services) {
    if (svc.variables == null) {
      continue;
    }

    core.info(`Variables for service '${svc.name}':`);

    for (const [key, value] of Object.entries(svc.variables)) {
      core.info(`  ${key}=${value}`);
      await setVariable(projectId, environmentId, requireId(svc.name, svc.railwayId), key, value);
    }
  }

  core.endGroup();

  // Step 6: Deploy services
  core.startGroup('Deploying services');

  for (const svc of config.services) {
    core.info(`Deploying '${svc.name}' from ${repoRoot}...`);
    await deploy(projectId, environmentId, requireId(svc.name, svc.railwayId), repoRoot);
  }

  core.endGroup();

  // Step 7: Ensure public domains and collect URLs
  core.startGroup('Ensuring service domains');

  const services: ConvergeResult['services'] = [];

  for (const svc of config.services) {
    const url = await ensureDomain(projectId, environmentId, requireId(svc.name, svc.railwayId));
    core.info(`Service '${svc.name}' URL: ${url}`);
    services.push({ name: svc.name, url });
  }

  core.endGroup();

  core.info('Deployment complete!');
  return { services };
}
