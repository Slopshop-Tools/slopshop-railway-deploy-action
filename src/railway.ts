/**
 * Railway CLI and API wrapper.
 *
 * CLI commands assume RAILWAY_API_TOKEN is set in the environment.
 * GraphQL API calls use the token directly via Authorization header.
 */

import * as core from '@actions/core';
import { exec, getExecOutput } from '@actions/exec';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

/**
 * Run a railway CLI command and return the JSON-parsed output.
 */
async function railwayJson<T>(args: string[]): Promise<T> {
  const result = await getExecOutput('railway', [...args, '--json'], {
    silent: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(`railway ${args.join(' ')} failed: ${result.stderr}`);
  }

  return JSON.parse(result.stdout) as T;
}

/**
 * Run a railway CLI command (no output parsing).
 */
async function railway(args: string[]): Promise<void> {
  const exitCode = await exec('railway', args);
  if (exitCode !== 0) {
    throw new Error(`railway ${args.join(' ')} failed with exit code ${exitCode}`);
  }
}

/**
 * Run a railway CLI command, tolerating failure (for idempotent operations).
 */
async function railwaySafe(args: string[]): Promise<boolean> {
  try {
    const exitCode = await exec('railway', args, { silent: true });
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Execute a GraphQL mutation/query against Railway's API.
 */
async function railwayGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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

// ============================================================================
// Project operations
// ============================================================================

interface RailwayProject {
  id: string;
  name: string;
}

/**
 * List all projects accessible to the current token.
 */
export async function listProjects(): Promise<RailwayProject[]> {
  return railwayJson<RailwayProject[]>(['list']);
}

/**
 * Find a project by name. Returns null if not found.
 */
export async function findProject(name: string): Promise<RailwayProject | null> {
  const projects = await listProjects();
  return projects.find((p) => p.name === name) ?? null;
}

/**
 * Create a new project with the given name.
 */
export async function createProject(name: string): Promise<RailwayProject> {
  return railwayJson<RailwayProject>(['init', '--name', name]);
}

/**
 * Link the CLI to a project by ID so subsequent commands target it.
 */
export async function linkProject(projectId: string): Promise<void> {
  await railway(['link', '--project', projectId]);
}

// ============================================================================
// Service operations
// ============================================================================

export interface RailwayService {
  id: string;
  name: string;
}

/**
 * Get the list of services in the currently linked project.
 * Parses from `railway status --json`.
 *
 * Railway returns services in GraphQL relay format:
 *   { services: { edges: [{ node: { id, name } }] } }
 */
export async function getServices(): Promise<RailwayService[]> {
  try {
    const status = await railwayJson<{
      services?: { edges?: Array<{ node: RailwayService }> } | RailwayService[];
    }>(['status']);

    const raw = status.services;
    if (raw == null) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (Array.isArray(raw.edges)) {
      return raw.edges.map((e: { node: RailwayService }) => e.node);
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Find a service by exact name in the current project.
 */
export async function findService(name: string): Promise<RailwayService | null> {
  const services = await getServices();
  return services.find((s) => s.name === name) ?? null;
}

/**
 * Find a service by Railway ID.
 */
export async function findServiceById(id: string): Promise<RailwayService | null> {
  const services = await getServices();
  return services.find((s) => s.id === id) ?? null;
}

/**
 * Create a database service. Returns the service ID and Railway-assigned name.
 */
export async function createDatabase(
  type: string
): Promise<{ serviceId: string; serviceName: string }> {
  const result = await railwayJson<{ serviceId: string; serviceName: string }>([
    'add',
    '--database',
    type,
  ]);
  return result;
}

/**
 * Rename a service via Railway's GraphQL API.
 */
export async function renameService(serviceId: string, newName: string): Promise<void> {
  core.info(`Renaming service ${serviceId} to '${newName}'...`);

  await railwayGraphql<{ serviceUpdate: { id: string; name: string } }>(
    `mutation serviceUpdate($id: String!, $input: ServiceUpdateInput!) {
      serviceUpdate(id: $id, input: $input) { id name }
    }`,
    { id: serviceId, input: { name: newName } }
  );
}

/**
 * Add an empty service with a name.
 */
export async function addService(name: string): Promise<void> {
  await railway(['add', '--service', name]);
}

// ============================================================================
// Variable operations
// ============================================================================

/**
 * Set a variable on a service. Uses Railway's reference syntax
 * (e.g., ${{postgres.DATABASE_URL}}) which Railway resolves at runtime.
 */
export async function setVariable(serviceName: string, key: string, value: string): Promise<void> {
  await railwaySafe(['variable', 'set', `${key}=${value}`, '--service', serviceName]);
}

// ============================================================================
// Domain operations
// ============================================================================

/**
 * Get the public domain for a service, generating one if none exists.
 * Railway's `domain` command returns the domain or creates one on first call.
 */
export async function ensureDomain(serviceName: string): Promise<string> {
  const result = await getExecOutput('railway', ['domain', '--service', serviceName], {
    silent: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(`railway domain --service ${serviceName} failed: ${result.stderr}`);
  }

  // Railway may print informational text around the URL (e.g. "Service Domain created:\n🚀 https://...").
  // Extract the first https:// URL from the output.
  const urlMatch = result.stdout.match(/https:\/\/\S+/);
  if (urlMatch == null) {
    throw new Error(`Could not find URL in railway domain output: ${result.stdout}`);
  }
  return urlMatch[0];
}

// ============================================================================
// Deploy operations
// ============================================================================

/**
 * Deploy a service from the repo root.
 * Uploads the entire repo so monorepo build commands work.
 * The railway.toml at the repo root controls build/start commands.
 * Waits for the build to complete so CI fails on build errors.
 */
export async function deploy(serviceName: string, repoRoot: string): Promise<void> {
  await exec('railway', ['up', '--service', serviceName], {
    cwd: repoRoot,
  });
}
