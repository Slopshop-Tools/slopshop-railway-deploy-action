import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';

// Mock the railway CLI wrapper
const mockFindProject = vi.fn();
const mockCreateProject = vi.fn();
const mockLinkProject = vi.fn();
const mockGetServices = vi.fn();
const mockFindService = vi.fn();
const mockFindServiceById = vi.fn();
const mockCreateDatabase = vi.fn();
const mockRenameService = vi.fn();
const mockAddService = vi.fn();
const mockSetVariable = vi.fn();
const mockDeploy = vi.fn();
const mockEnsureDomain = vi.fn();

vi.mock('../railway.js', () => ({
  findProject: (...args: unknown[]) => mockFindProject(...args),
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  linkProject: (...args: unknown[]) => mockLinkProject(...args),
  getServices: (...args: unknown[]) => mockGetServices(...args),
  findService: (...args: unknown[]) => mockFindService(...args),
  findServiceById: (...args: unknown[]) => mockFindServiceById(...args),
  createDatabase: (...args: unknown[]) => mockCreateDatabase(...args),
  renameService: (...args: unknown[]) => mockRenameService(...args),
  addService: (...args: unknown[]) => mockAddService(...args),
  setVariable: (...args: unknown[]) => mockSetVariable(...args),
  deploy: (...args: unknown[]) => mockDeploy(...args),
  ensureDomain: (...args: unknown[]) => mockEnsureDomain(...args),
}));

// Mock @actions/core so convergence doesn't try to write GitHub Actions output
vi.mock('@actions/core', () => ({
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  info: vi.fn(),
}));

// Mock config save
const mockSaveConfig = vi.fn();
vi.mock('../config.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, saveConfig: (...args: unknown[]) => mockSaveConfig(...args) };
});

import { converge } from '../converge.js';

const mockCommitAndPush = vi.fn();

const BASE_CONFIG: Config = {
  version: 1,
  project: { name: 'test-project' },
  databases: [{ name: 'postgres', type: 'postgres' }],
  services: [
    {
      name: 'api',
      root: 'apps/api',
      variables: {
        DATABASE_URL: '${{postgres.DATABASE_URL}}',
        NODE_ENV: 'production',
      },
    },
  ],
};

function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}

function configWithDbId(railwayId: string): Config {
  const config = cloneConfig(BASE_CONFIG);
  const db = config.databases[0];
  if (db != null) {
    db.railwayId = railwayId;
  }
  return config;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no services exist (fresh project)
  mockGetServices.mockResolvedValue([]);
  mockEnsureDomain.mockImplementation((name: string) =>
    Promise.resolve(`https://${name}-production-abc123.up.railway.app`)
  );
});

describe('converge — fresh project (nothing exists)', () => {
  beforeEach(() => {
    mockFindProject.mockResolvedValue(null);
    mockCreateProject.mockResolvedValue({ id: 'proj_new', name: 'test-project' });
    mockFindService.mockResolvedValue(null);
    mockCreateDatabase.mockResolvedValue({ serviceId: 'db_new', serviceName: 'Postgres-xYz' });
  });

  it('creates the project', async () => {
    await converge(cloneConfig(BASE_CONFIG), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateProject).toHaveBeenCalledWith('test-project');
    expect(mockLinkProject).toHaveBeenCalledWith('proj_new');
  });

  it('creates the database, saves ID, and renames', async () => {
    const config = cloneConfig(BASE_CONFIG);
    await converge(config, '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateDatabase).toHaveBeenCalledWith('postgres');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(mockCommitAndPush).toHaveBeenCalled();
    expect(mockRenameService).toHaveBeenCalledWith('db_new', 'postgres');
    expect(config.databases[0]?.railwayId).toBe('db_new');
  });

  it('creates the service', async () => {
    await converge(cloneConfig(BASE_CONFIG), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockAddService).toHaveBeenCalledWith('api');
  });

  it('sets variables on the service', async () => {
    await converge(cloneConfig(BASE_CONFIG), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockSetVariable).toHaveBeenCalledWith(
      'api',
      'DATABASE_URL',
      '${{postgres.DATABASE_URL}}'
    );
    expect(mockSetVariable).toHaveBeenCalledWith('api', 'NODE_ENV', 'production');
  });

  it('deploys the service from the repo root', async () => {
    await converge(cloneConfig(BASE_CONFIG), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockDeploy).toHaveBeenCalledWith('api', '/repo');
  });
});

describe('converge — existing project with provisioned database', () => {
  beforeEach(() => {
    mockFindProject.mockResolvedValue({ id: 'proj_existing', name: 'test-project' });
    mockGetServices.mockResolvedValue([
      { id: 'db_existing', name: 'postgres' },
      { id: 'svc_existing', name: 'api' },
    ]);
    mockFindService.mockResolvedValue({ id: 'svc_existing', name: 'api' });
    mockFindServiceById.mockResolvedValue({ id: 'db_existing', name: 'postgres' });
  });

  it('does not create the project', async () => {
    await converge(configWithDbId('db_existing'), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateProject).not.toHaveBeenCalled();
    expect(mockLinkProject).toHaveBeenCalledWith('proj_existing');
  });

  it('does not create database or service that already exist', async () => {
    await converge(configWithDbId('db_existing'), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateDatabase).not.toHaveBeenCalled();
    expect(mockAddService).not.toHaveBeenCalled();
  });

  it('does not rename if name already matches', async () => {
    await converge(configWithDbId('db_existing'), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockRenameService).not.toHaveBeenCalled();
  });

  it('renames if name does not match (retry case)', async () => {
    mockFindServiceById.mockResolvedValue({ id: 'db_existing', name: 'Postgres-xYz' });
    await converge(configWithDbId('db_existing'), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockRenameService).toHaveBeenCalledWith('db_existing', 'postgres');
  });

  it('fails if railwayId points to nonexistent service', async () => {
    mockGetServices.mockResolvedValue([{ id: 'svc_existing', name: 'api' }]);
    mockFindServiceById.mockResolvedValue(null);

    await expect(
      converge(configWithDbId('db_gone'), '/repo', '/repo/config.jsonc', mockCommitAndPush)
    ).rejects.toThrow(/no matching service exists/);
  });
});

describe('converge — no databases, no variables', () => {
  const minimalConfig: Config = {
    version: 1,
    project: { name: 'minimal' },
    databases: [],
    services: [{ name: 'worker', root: '.' }],
  };

  beforeEach(() => {
    mockFindProject.mockResolvedValue(null);
    mockCreateProject.mockResolvedValue({ id: 'proj_min', name: 'minimal' });
    mockFindService.mockResolvedValue(null);
  });

  it('skips database and variable steps', async () => {
    await converge(cloneConfig(minimalConfig), '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateDatabase).not.toHaveBeenCalled();
    expect(mockSetVariable).not.toHaveBeenCalled();
    expect(mockAddService).toHaveBeenCalledWith('worker');
    expect(mockDeploy).toHaveBeenCalledWith('worker', '/repo');
  });
});
