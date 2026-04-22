/**
 * Infrastructure convergence logic.
 *
 * Reads the desired state from the config and converges Railway
 * infrastructure to match. Every operation is idempotent — running
 * this multiple times produces the same result.
 */

import { resolve } from 'node:path';

import * as core from '@actions/core';

import type { Config } from './config.js';
import {
  addDatabase,
  addService,
  createProject,
  deploy,
  ensureDomain,
  findProject,
  findService,
  linkProject,
  setVariable,
} from './railway.js';

export interface ConvergeResult {
  services: Array<{ name: string; url: string }>;
}

export async function converge(config: Config, repoRoot: string): Promise<ConvergeResult> {
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

  // Step 2: Ensure databases exist
  core.startGroup('Ensuring databases exist');

  for (const db of config.databases) {
    const existing = await findService(db.name);

    if (existing == null) {
      core.info(`Adding ${db.type} database '${db.name}'...`);
      await addDatabase(db.type, db.name);
    } else {
      core.info(`Database '${db.name}' already exists`);
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
    const svcRoot = resolve(repoRoot, svc.root);
    core.info(`Deploying '${svc.name}' from ${svcRoot}...`);
    await deploy(svc.name, repoRoot, svcRoot);
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
