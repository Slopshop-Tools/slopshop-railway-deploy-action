/**
 * Infrastructure convergence logic.
 *
 * Reads the desired state from the config and converges Railway
 * infrastructure to match. Every operation is idempotent — running
 * this multiple times produces the same result.
 *
 * Databases use a save-back pattern: after creating a database,
 * Railway assigns its own name/ID which gets written back into the
 * config file and committed to the repo.
 */

import * as core from '@actions/core';

import type { Config, DatabaseConfig } from './config.js';
import {
  addDatabase,
  addService,
  createProject,
  deploy,
  ensureDomain,
  findProject,
  findService,
  getServices,
  linkProject,
  setVariable,
} from './railway.js';

export interface ConvergeResult {
  services: Array<{ name: string; url: string }>;
  configChanged: boolean;
}

/**
 * Build a mapping from config database names to their actual Railway service names.
 * Used to rewrite variable references like ${{postgres.DATABASE_URL}} to ${{Postgres.DATABASE_URL}}.
 */
function buildNameMapping(databases: DatabaseConfig[]): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const db of databases) {
    if (db.railwayServiceName != null) {
      mapping.set(db.name, db.railwayServiceName);
    }
  }
  return mapping;
}

/**
 * Rewrite Railway variable references using the name mapping.
 * Replaces ${{configName.VAR}} with ${{actualName.VAR}}.
 */
function rewriteVariableRef(value: string, nameMapping: Map<string, string>): string {
  return value.replace(/\$\{\{(\w+)\.([\w.]+)\}\}/g, (_match, name: string, rest: string) => {
    const actual = nameMapping.get(name);
    if (actual != null) {
      return '${{' + actual + '.' + rest + '}}';
    }
    return _match;
  });
}

export async function converge(config: Config, repoRoot: string): Promise<ConvergeResult> {
  let configChanged = false;

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

  // Step 2: Ensure databases exist (with save-back)
  core.startGroup('Ensuring databases exist');

  for (const db of config.databases) {
    if (db.railwayId != null) {
      // Already provisioned — verify it still exists
      const existing = await findServiceById(db.railwayId);
      if (existing == null) {
        throw new Error(
          `Database '${db.name}' has railwayId '${db.railwayId}' but no matching service exists in Railway. ` +
            `It may have been deleted. Remove the railwayId and railwayServiceName from the config to re-create it.`
        );
      }
      core.info(
        `Database '${db.name}' already provisioned: ${db.railwayServiceName} (${db.railwayId})`
      );
    } else {
      // Not yet provisioned — snapshot, create, diff, save-back
      core.info(`Provisioning ${db.type} database '${db.name}'...`);

      const before = await getServices();
      const beforeIds = new Set(before.map((s) => s.id));

      await addDatabase(db.type, db.name);

      const after = await getServices();
      const newService = after.find((s) => !beforeIds.has(s.id));

      if (newService == null) {
        throw new Error(
          `Failed to detect newly created database '${db.name}'. ` +
            `Service list did not change after 'railway add'.`
        );
      }

      db.railwayId = newService.id;
      db.railwayServiceName = newService.name;
      configChanged = true;

      core.info(
        `Created database '${db.name}' → Railway service '${newService.name}' (${newService.id})`
      );
    }
  }

  core.endGroup();

  // Build name mapping for variable reference rewriting
  const nameMapping = buildNameMapping(config.databases);

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

  // Step 4: Set variables on services (rewriting references to actual Railway names)
  core.startGroup('Setting variables');

  for (const svc of config.services) {
    if (svc.variables == null) {
      continue;
    }

    core.info(`Variables for service '${svc.name}':`);

    for (const [key, value] of Object.entries(svc.variables)) {
      const rewritten = rewriteVariableRef(value, nameMapping);
      if (rewritten !== value) {
        core.info(`  ${key}=${value} → ${rewritten}`);
      } else {
        core.info(`  ${key}=${value}`);
      }
      await setVariable(svc.name, key, rewritten);
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
  return { services, configChanged };
}

/**
 * Find a service by Railway ID.
 */
async function findServiceById(id: string): Promise<{ id: string; name: string } | null> {
  const services = await getServices();
  return services.find((s) => s.id === id) ?? null;
}
