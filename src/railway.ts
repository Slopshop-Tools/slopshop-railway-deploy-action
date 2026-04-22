/**
 * Railway API and CLI wrapper.
 *
 * All operations use the Railway GraphQL API directly except deploy,
 * which uses the CLI to upload code.
 */

import * as core from '@actions/core';
import { exec } from '@actions/exec';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

// ============================================================================
// GraphQL client
// ============================================================================

/**
 * Execute an authenticated GraphQL query/mutation against Railway's API.
 */
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (token == null) {
    throw new Error('RAILWAY_API_TOKEN is not set');
  }

  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (body.errors != null && body.errors.length > 0) {
    throw new Error(`Railway API error: ${body.errors.map((e) => e.message).join(', ')}`);
  }

  if (body.data == null) {
    throw new Error('Railway API returned no data');
  }

  return body.data;
}

/**
 * Execute a public (unauthenticated) GraphQL query against Railway's API.
 */
async function gqlPublic<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (body.errors != null && body.errors.length > 0) {
    throw new Error(`Railway API error: ${body.errors.map((e) => e.message).join(', ')}`);
  }

  if (body.data == null) {
    throw new Error('Railway API returned no data');
  }

  return body.data;
}

// ============================================================================
// Project operations
// ============================================================================

export interface RailwayProject {
  id: string;
  name: string;
}

interface RailwayEnvironment {
  id: string;
  name: string;
}

/**
 * Get a project by ID.
 */
export async function getProject(id: string): Promise<RailwayProject | null> {
  try {
    const data = await gql<{ project: RailwayProject }>(
      `query($id: String!) { project(id: $id) { id name } }`,
      { id }
    );
    return data.project;
  } catch {
    return null;
  }
}

/**
 * Create a new project.
 */
export async function createProject(name: string, workspaceId: string): Promise<RailwayProject> {
  const data = await gql<{ projectCreate: RailwayProject }>(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }`,
    { input: { name, workspaceId } }
  );
  return data.projectCreate;
}

/**
 * Rename a project.
 */
export async function renameProject(id: string, name: string): Promise<void> {
  await gql(
    `mutation($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) { id }
    }`,
    { id, input: { name } }
  );
}

/**
 * Get the environments for a project. Returns the "production" environment ID.
 */
export async function getProductionEnvironmentId(projectId: string): Promise<string> {
  const data = await gql<{
    project: { environments: { edges: Array<{ node: RailwayEnvironment }> } };
  }>(
    `query($id: String!) {
      project(id: $id) {
        environments { edges { node { id name } } }
      }
    }`,
    { id: projectId }
  );

  const env = data.project.environments.edges.find((e) => e.node.name === 'production');
  if (env == null) {
    throw new Error(`No "production" environment found in project ${projectId}`);
  }
  return env.node.id;
}

// ============================================================================
// Service operations
// ============================================================================

export interface RailwayService {
  id: string;
  name: string;
}

/**
 * Get all services in a project.
 */
export async function getServices(projectId: string): Promise<RailwayService[]> {
  const data = await gql<{
    project: { services: { edges: Array<{ node: RailwayService }> } };
  }>(
    `query($id: String!) {
      project(id: $id) {
        services { edges { node { id name } } }
      }
    }`,
    { id: projectId }
  );

  return data.project.services.edges.map((e) => e.node);
}

/**
 * Create an empty service with a name.
 */
export async function createService(projectId: string, name: string): Promise<RailwayService> {
  const data = await gql<{ serviceCreate: RailwayService }>(
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    { input: { projectId, name } }
  );
  return data.serviceCreate;
}

/**
 * Rename a service.
 */
export async function renameService(serviceId: string, name: string): Promise<void> {
  core.info(`Renaming service ${serviceId} to '${name}'...`);
  await gql(
    `mutation($id: String!, $input: ServiceUpdateInput!) {
      serviceUpdate(id: $id, input: $input) { id }
    }`,
    { id: serviceId, input: { name } }
  );
}

// ============================================================================
// Database (template) operations
// ============================================================================

interface TemplateDetail {
  id: string;
  serializedConfig: Record<string, unknown>;
}

/**
 * Create a database by deploying a Railway template (e.g. "postgres", "redis").
 * Modifies the template's serializedConfig to set the desired service name.
 * Returns the new service once it appears in the project.
 */
export async function createDatabase(
  projectId: string,
  environmentId: string,
  type: string,
  name: string
): Promise<RailwayService> {
  // Fetch template details (public, no auth needed)
  const data = await gqlPublic<{ template: TemplateDetail }>(
    `query($code: String!) { template(code: $code) { id serializedConfig } }`,
    { code: type }
  );

  const template = data.template;

  // Modify the service name in the template config
  const config = template.serializedConfig as {
    services: Record<string, { name: string }>;
  };
  for (const key of Object.keys(config.services)) {
    const svc = config.services[key];
    if (svc != null) {
      svc.name = name;
    }
  }

  // Deploy the template
  await gql(
    `mutation($input: TemplateDeployV2Input!) {
      templateDeployV2(input: $input) { projectId workflowId }
    }`,
    {
      input: {
        projectId,
        environmentId,
        templateId: template.id,
        serializedConfig: config,
      },
    }
  );

  // Poll for the newly created service (template deploy is async)
  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const services = await getServices(projectId);
    const created = services.find((s) => s.name === name);
    if (created != null) {
      return created;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error(
    `Database '${name}' was deployed via template but the service did not appear after ${maxAttempts} attempts`
  );
}

// ============================================================================
// Variable operations
// ============================================================================

/**
 * Set a variable on a service. Uses Railway's reference syntax
 * (e.g., ${{postgres.DATABASE_URL}}) which Railway resolves at runtime.
 */
export async function setVariable(
  projectId: string,
  environmentId: string,
  serviceId: string,
  key: string,
  value: string
): Promise<void> {
  await gql(
    `mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        name: key,
        value,
      },
    }
  );
}

// ============================================================================
// Domain operations
// ============================================================================

/**
 * Ensure a service has a public domain. Creates one if none exists.
 * Returns the domain URL.
 */
export async function ensureDomain(
  projectId: string,
  environmentId: string,
  serviceId: string
): Promise<string> {
  // Check for existing domains
  const data = await gql<{
    domains: { serviceDomains: Array<{ domain: string }> };
  }>(
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        serviceDomains { domain }
      }
    }`,
    { projectId, environmentId, serviceId }
  );

  const existing = data.domains.serviceDomains[0];
  if (existing != null) {
    return `https://${existing.domain}`;
  }

  // No domain exists — create one
  const createData = await gql<{
    serviceDomainCreate: { domain: string };
  }>(
    `mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
    {
      input: {
        serviceId,
        environmentId,
      },
    }
  );

  return `https://${createData.serviceDomainCreate.domain}`;
}

// ============================================================================
// Deploy operations
// ============================================================================

/**
 * Deploy a service by uploading code via the Railway CLI.
 * This is the only CLI call — everything else uses the API.
 */
export async function deploy(
  projectId: string,
  environmentId: string,
  serviceId: string,
  repoRoot: string
): Promise<void> {
  const exitCode = await exec(
    'railway',
    ['up', '--project', projectId, '--environment', environmentId, '--service', serviceId],
    { cwd: repoRoot }
  );
  if (exitCode !== 0) {
    throw new Error(`railway up failed with exit code ${exitCode}`);
  }
}
