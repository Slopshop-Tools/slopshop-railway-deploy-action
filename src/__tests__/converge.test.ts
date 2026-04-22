import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';

// Mock the railway API/CLI wrapper
const mockGetProject = vi.fn();
const mockCreateProject = vi.fn();
const mockRenameProject = vi.fn();
const mockGetProductionEnvironmentId = vi.fn();
const mockGetServices = vi.fn();
const mockCreateService = vi.fn();
const mockRenameService = vi.fn();
const mockCreateDatabase = vi.fn();
const mockSetVariable = vi.fn();
const mockDeploy = vi.fn();
const mockEnsureDomain = vi.fn();

vi.mock('../railway.js', () => ({
  getProject: (...args: unknown[]) => mockGetProject(...args),
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  renameProject: (...args: unknown[]) => mockRenameProject(...args),
  getProductionEnvironmentId: (...args: unknown[]) => mockGetProductionEnvironmentId(...args),
  getServices: (...args: unknown[]) => mockGetServices(...args),
  createService: (...args: unknown[]) => mockCreateService(...args),
  renameService: (...args: unknown[]) => mockRenameService(...args),
  createDatabase: (...args: unknown[]) => mockCreateDatabase(...args),
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
const WORKSPACE_ID = 'ws_test';

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

function configWithIds(opts: { projectId?: string; dbId?: string; serviceId?: string }): Config {
  const config = cloneConfig(BASE_CONFIG);
  if (opts.projectId != null) {
    config.project.railwayId = opts.projectId;
  }
  if (opts.dbId != null && config.databases[0] != null) {
    config.databases[0].railwayId = opts.dbId;
  }
  if (opts.serviceId != null && config.services[0] != null) {
    config.services[0].railwayId = opts.serviceId;
  }
  return config;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProductionEnvironmentId.mockResolvedValue('env_prod');
  mockGetServices.mockResolvedValue([]);
  mockEnsureDomain.mockImplementation((_pId: string, _eId: string, sId: string) =>
    Promise.resolve(`https://${sId}-production.up.railway.app`)
  );
});

describe('converge — fresh project (nothing exists)', () => {
  beforeEach(() => {
    mockCreateProject.mockResolvedValue({ id: 'proj_new', name: 'test-project' });
    mockCreateDatabase.mockResolvedValue({ id: 'db_new', name: 'postgres' });
    mockCreateService.mockResolvedValue({ id: 'svc_new', name: 'api' });
  });

  it('creates the project and saves ID', async () => {
    const config = cloneConfig(BASE_CONFIG);
    await converge(config, WORKSPACE_ID, '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateProject).toHaveBeenCalledWith('test-project', WORKSPACE_ID);
    expect(config.project.railwayId).toBe('proj_new');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(mockCommitAndPush).toHaveBeenCalledWith(expect.stringContaining('project'));
  });

  it('creates the database with desired name and saves ID', async () => {
    const config = cloneConfig(BASE_CONFIG);
    await converge(config, WORKSPACE_ID, '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateDatabase).toHaveBeenCalledWith('proj_new', 'env_prod', 'postgres', 'postgres');
    expect(config.databases[0]?.railwayId).toBe('db_new');
  });

  it('creates the service and saves ID', async () => {
    const config = cloneConfig(BASE_CONFIG);
    await converge(config, WORKSPACE_ID, '/repo', '/repo/config.jsonc', mockCommitAndPush);

    expect(mockCreateService).toHaveBeenCalledWith('proj_new', 'api');
    expect(config.services[0]?.railwayId).toBe('svc_new');
  });

  it('sets variables with service ID', async () => {
    await converge(
      cloneConfig(BASE_CONFIG),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockSetVariable).toHaveBeenCalledWith(
      'proj_new',
      'env_prod',
      'svc_new',
      'DATABASE_URL',
      '${{postgres.DATABASE_URL}}'
    );
    expect(mockSetVariable).toHaveBeenCalledWith(
      'proj_new',
      'env_prod',
      'svc_new',
      'NODE_ENV',
      'production'
    );
  });

  it('deploys with explicit project/environment/service IDs', async () => {
    await converge(
      cloneConfig(BASE_CONFIG),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockDeploy).toHaveBeenCalledWith('proj_new', 'env_prod', 'svc_new', '/repo');
  });
});

describe('converge — existing project with all IDs', () => {
  beforeEach(() => {
    mockGetProject.mockResolvedValue({ id: 'proj_existing', name: 'test-project' });
    mockGetServices.mockResolvedValue([
      { id: 'db_existing', name: 'postgres' },
      { id: 'svc_existing', name: 'api' },
    ]);
  });

  it('does not create anything', async () => {
    await converge(
      configWithIds({ projectId: 'proj_existing', dbId: 'db_existing', serviceId: 'svc_existing' }),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockCreateProject).not.toHaveBeenCalled();
    expect(mockCreateDatabase).not.toHaveBeenCalled();
    expect(mockCreateService).not.toHaveBeenCalled();
  });

  it('does not rename if names match', async () => {
    await converge(
      configWithIds({ projectId: 'proj_existing', dbId: 'db_existing', serviceId: 'svc_existing' }),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockRenameProject).not.toHaveBeenCalled();
    expect(mockRenameService).not.toHaveBeenCalled();
  });

  it('renames project if name does not match', async () => {
    mockGetProject.mockResolvedValue({ id: 'proj_existing', name: 'old-name' });

    await converge(
      configWithIds({ projectId: 'proj_existing', dbId: 'db_existing', serviceId: 'svc_existing' }),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockRenameProject).toHaveBeenCalledWith('proj_existing', 'test-project');
  });

  it('renames database if name does not match', async () => {
    mockGetServices.mockResolvedValue([
      { id: 'db_existing', name: 'Postgres-xYz' },
      { id: 'svc_existing', name: 'api' },
    ]);

    await converge(
      configWithIds({ projectId: 'proj_existing', dbId: 'db_existing', serviceId: 'svc_existing' }),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockRenameService).toHaveBeenCalledWith('db_existing', 'postgres');
  });

  it('renames service if name does not match', async () => {
    mockGetServices.mockResolvedValue([
      { id: 'db_existing', name: 'postgres' },
      { id: 'svc_existing', name: 'old-api' },
    ]);

    await converge(
      configWithIds({ projectId: 'proj_existing', dbId: 'db_existing', serviceId: 'svc_existing' }),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockRenameService).toHaveBeenCalledWith('svc_existing', 'api');
  });

  it('fails if project railwayId points to nonexistent project', async () => {
    mockGetProject.mockResolvedValue(null);

    await expect(
      converge(
        configWithIds({ projectId: 'proj_gone', dbId: 'db_existing', serviceId: 'svc_existing' }),
        WORKSPACE_ID,
        '/repo',
        '/repo/config.jsonc',
        mockCommitAndPush
      )
    ).rejects.toThrow(/no matching project exists/);
  });

  it('fails if database railwayId points to nonexistent service', async () => {
    mockGetServices.mockResolvedValue([{ id: 'svc_existing', name: 'api' }]);

    await expect(
      converge(
        configWithIds({ projectId: 'proj_existing', dbId: 'db_gone', serviceId: 'svc_existing' }),
        WORKSPACE_ID,
        '/repo',
        '/repo/config.jsonc',
        mockCommitAndPush
      )
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
    mockCreateProject.mockResolvedValue({ id: 'proj_min', name: 'minimal' });
    mockCreateService.mockResolvedValue({ id: 'svc_min', name: 'worker' });
  });

  it('skips database and variable steps', async () => {
    await converge(
      cloneConfig(minimalConfig),
      WORKSPACE_ID,
      '/repo',
      '/repo/config.jsonc',
      mockCommitAndPush
    );

    expect(mockCreateDatabase).not.toHaveBeenCalled();
    expect(mockSetVariable).not.toHaveBeenCalled();
    expect(mockCreateService).toHaveBeenCalledWith('proj_min', 'worker');
    expect(mockDeploy).toHaveBeenCalledWith('proj_min', 'env_prod', 'svc_min', '/repo');
  });
});
