/**
 * Railway CLI wrapper.
 *
 * Executes Railway CLI commands and parses JSON output.
 * All commands assume RAILWAY_API_TOKEN is set in the environment.
 */

import { exec, getExecOutput } from '@actions/exec';

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

interface RailwayService {
  id: string;
  name: string;
}

/**
 * Get the list of services in the currently linked project.
 * Parses from `railway status --json`.
 */
export async function getServices(): Promise<RailwayService[]> {
  try {
    const status = await railwayJson<{ services?: RailwayService[] }>(['status']);
    return status.services ?? [];
  } catch {
    return [];
  }
}

/**
 * Find a service by name in the current project.
 */
export async function findService(name: string): Promise<RailwayService | null> {
  const services = await getServices();
  return services.find((s) => s.name === name) ?? null;
}

/**
 * Add a database service with an explicit name.
 */
export async function addDatabase(type: string, name: string): Promise<void> {
  await railway(['add', '--database', type, '--service', name]);
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
// Deploy operations
// ============================================================================

/**
 * Deploy a service from a local directory.
 * Uses --detach so the command returns immediately.
 */
export async function deploy(serviceName: string, rootDir: string): Promise<void> {
  await exec('railway', ['up', '--service', serviceName, '--detach'], {
    cwd: rootDir,
  });
}
