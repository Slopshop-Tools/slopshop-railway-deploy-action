/**
 * Infrastructure convergence logic.
 *
 * Reads the desired state from the config and converges Railway
 * infrastructure to match. Every operation is idempotent — running
 * this multiple times produces the same result.
 *
 * Databases use a save-back pattern: after creating a database,
 * the Railway-assigned ID is written back to the config and pushed
 * immediately. The service is then renamed to match the config name
 * so variable references (e.g. ${{postgres.DATABASE_URL}}) resolve.
 */

import * as core from '@actions/core';

import type { Config } from './config.js';
import { saveConfig } from './config.js';
import {
  addService,
  createDatabase,
  createProject,
  deploy,
  ensureDomain,
  findProject,
  findService,
  findServiceById,
  getServices,
  linkProject,
  renameService,
  setVariable,
} from './railway.js';

export interface ConvergeResult {
  services: Array<{ name: string; url: string }>;
}

export async function converge(
  config: Config,
  repoRoot: string,
  configPath: string,
  commitAndPush: (message: string) => Promise<void>
): Promise<ConvergeResult> {
  // Step 1: Ensure project exists
  core.startGroup(`Ensuring project '${config.project.name}' exists`);

  let project = await findProject(config.project.name);

  if (project == null) {
    core.info(`Creating project '${config.project.name}'...`);
    project = await createProject(config.project.name);
    core.info(`Created project: ${project.id}`);
  } else {
    core.info(`Project already exists: ${project.id}`);
  }

  await linkProject(project.id);
  core.endGroup();

  // Step 2: Check for unrecognized services
  core.startGroup('Checking for unrecognized services');

  const allServices = await getServices();
  const knownIds = new Set(
    config.databases.filter((d) => d.railwayId != null).map((d) => d.railwayId)
  );
  const knownNames = new Set(config.services.map((s) => s.name));

  const unrecognized = allServices.filter((s) => !knownIds.has(s.id) && !knownNames.has(s.name));

  if (unrecognized.length > 0) {
    const list = unrecognized
      .map(
        (s) =>
          `  - ${s.name} (${s.id})\n    https://railway.com/project/${project.id}/service/${s.id}`
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

  // Step 3: Ensure databases exist
  core.startGroup('Ensuring databases exist');

  for (const db of config.databases) {
    if (db.railwayId != null) {
      // Already provisioned — verify it exists and name matches
      const existing = await findServiceById(db.railwayId);
      if (existing == null) {
        throw new Error(
          `Database '${db.name}' has railwayId '${db.railwayId}' but no matching service exists in Railway. ` +
            `It may have been deleted. Remove the railwayId from the config to re-create it.`
        );
      }

      // Ensure the name matches (handles retry after failed rename)
      if (existing.name !== db.name) {
        core.info(`Database '${db.name}' exists as '${existing.name}' — renaming...`);
        await renameService(db.railwayId, db.name);
        core.info(`Renamed to '${db.name}'`);
      } else {
        core.info(`Database '${db.name}' already provisioned (${db.railwayId})`);
      }
    } else {
      // Not yet provisioned — create, save ID immediately, then rename
      core.info(`Provisioning ${db.type} database '${db.name}'...`);

      const created = await createDatabase(db.type);
      core.info(
        `Created database: Railway service '${created.serviceName}' (${created.serviceId})`
      );

      // Save the ID to config and push immediately so it's never lost
      db.railwayId = created.serviceId;
      saveConfig(configPath, config);
      await commitAndPush(`chore: save Railway ID for database '${db.name}'`);
      core.info(`Saved railwayId to config`);

      // Rename to match config name
      if (created.serviceName !== db.name) {
        await renameService(created.serviceId, db.name);
        core.info(`Renamed '${created.serviceName}' → '${db.name}'`);
      }
    }
  }

  core.endGroup();

  // Step 3: Ensure services exist
  core.startGroup('Ensuring services exist');

  for (const svc of config.services) {
    const existing = await findService(svc.name);

    if (existing == null) {
      core.info(`Adding service '${svc.name}'...`);
      await addService(svc.name);
    } else {
      core.info(`Service '${svc.name}' already exists`);
    }
  }

  core.endGroup();

  // Step 4: Set variables on services
  core.startGroup('Setting variables');

  for (const svc of config.services) {
    if (svc.variables == null) {
      continue;
    }

    core.info(`Variables for service '${svc.name}':`);

    for (const [key, value] of Object.entries(svc.variables)) {
      core.info(`  ${key}=${value}`);
      await setVariable(svc.name, key, value);
    }
  }

  core.endGroup();

  // Step 5: Deploy services
  core.startGroup('Deploying services');

  for (const svc of config.services) {
    core.info(`Deploying '${svc.name}' from ${repoRoot}...`);
    await deploy(svc.name, repoRoot);
  }

  core.endGroup();

  // Step 6: Ensure public domains and collect URLs
  core.startGroup('Ensuring service domains');

  const services: ConvergeResult['services'] = [];

  for (const svc of config.services) {
    const url = await ensureDomain(svc.name);
    core.info(`Service '${svc.name}' URL: ${url}`);
    services.push({ name: svc.name, url });
  }

  core.endGroup();

  core.info('Deployment complete!');
  return { services };
}
