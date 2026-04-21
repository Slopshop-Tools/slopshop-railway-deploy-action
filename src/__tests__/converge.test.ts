import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';

// Mock the railway CLI wrapper
const mockFindProject = vi.fn();
const mockCreateProject = vi.fn();
const mockLinkProject = vi.fn();
const mockFindService = vi.fn();
const mockAddDatabase = vi.fn();
const mockAddService = vi.fn();
const mockSetVariable = vi.fn();
const mockDeploy = vi.fn();
const mockEnsureDomain = vi.fn();

vi.mock('../railway.js', () => ({
  findProject: (...args: unknown[]) => mockFindProject(...args),
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  linkProject: (...args: unknown[]) => mockLinkProject(...args),
  findService: (...args: unknown[]) => mockFindService(...args),
  addDatabase: (...args: unknown[]) => mockAddDatabase(...args),
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

import { converge } from '../converge.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: ensureDomain returns a URL based on the service name
  mockEnsureDomain.mockImplementation((name: string) =>
    Promise.resolve(`https://${name}-production-abc123.up.railway.app`)
  );
});

describe('converge — fresh project (nothing exists)', () => {
  beforeEach(() => {
    mockFindProject.mockResolvedValue(null);
    mockCreateProject.mockResolvedValue({ id: 'proj_new', name: 'test-project' });
    mockFindService.mockResolvedValue(null);
  });

  it('creates the project', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockCreateProject).toHaveBeenCalledWith('test-project');
    expect(mockLinkProject).toHaveBeenCalledWith('proj_new');
  });

  it('creates the database', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockAddDatabase).toHaveBeenCalledWith('postgres', 'postgres');
  });

  it('creates the service', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockAddService).toHaveBeenCalledWith('api');
  });

  it('sets variables on the service', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockSetVariable).toHaveBeenCalledWith(
      'api',
      'DATABASE_URL',
      '${{postgres.DATABASE_URL}}'
    );
    expect(mockSetVariable).toHaveBeenCalledWith('api', 'NODE_ENV', 'production');
  });

  it('deploys the service from the correct root', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockDeploy).toHaveBeenCalledWith('api', '/repo/apps/api');
  });
});

describe('converge — existing project (everything exists)', () => {
  beforeEach(() => {
    mockFindProject.mockResolvedValue({ id: 'proj_existing', name: 'test-project' });
    mockFindService.mockResolvedValue({ id: 'svc_existing', name: 'api' });
  });

  it('does not create the project', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockCreateProject).not.toHaveBeenCalled();
    expect(mockLinkProject).toHaveBeenCalledWith('proj_existing');
  });

  it('does not create databases or services that already exist', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockAddDatabase).not.toHaveBeenCalled();
    expect(mockAddService).not.toHaveBeenCalled();
  });

  it('still sets variables (idempotent)', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockSetVariable).toHaveBeenCalledTimes(2);
  });

  it('still deploys', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockDeploy).toHaveBeenCalledWith('api', '/repo/apps/api');
  });
});

describe('converge — partial state (project exists, some services missing)', () => {
  beforeEach(() => {
    mockFindProject.mockResolvedValue({ id: 'proj_partial', name: 'test-project' });
    // Database exists, but service doesn't
    mockFindService.mockImplementation((name: string) => {
      if (name === 'postgres') {
        return Promise.resolve({ id: 'svc_db', name: 'postgres' });
      }
      return Promise.resolve(null);
    });
  });

  it('skips existing database, creates missing service', async () => {
    await converge(BASE_CONFIG, '/repo');

    expect(mockAddDatabase).not.toHaveBeenCalled();
    expect(mockAddService).toHaveBeenCalledWith('api');
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
    await converge(minimalConfig, '/repo');

    expect(mockAddDatabase).not.toHaveBeenCalled();
    expect(mockSetVariable).not.toHaveBeenCalled();
    expect(mockAddService).toHaveBeenCalledWith('worker');
    expect(mockDeploy).toHaveBeenCalledWith('worker', '/repo');
  });
});

describe('converge — multiple databases and services', () => {
  const multiConfig: Config = {
    version: 1,
    project: { name: 'multi' },
    databases: [
      { name: 'main-db', type: 'postgres' },
      { name: 'cache', type: 'redis' },
    ],
    services: [
      { name: 'api', root: 'apps/api', variables: { DB: '${{main-db.DATABASE_URL}}' } },
      { name: 'worker', root: 'apps/worker', variables: { REDIS: '${{cache.REDIS_URL}}' } },
    ],
  };

  beforeEach(() => {
    mockFindProject.mockResolvedValue(null);
    mockCreateProject.mockResolvedValue({ id: 'proj_multi', name: 'multi' });
    mockFindService.mockResolvedValue(null);
  });

  it('creates all databases and services', async () => {
    await converge(multiConfig, '/repo');

    expect(mockAddDatabase).toHaveBeenCalledWith('postgres', 'main-db');
    expect(mockAddDatabase).toHaveBeenCalledWith('redis', 'cache');
    expect(mockAddService).toHaveBeenCalledWith('api');
    expect(mockAddService).toHaveBeenCalledWith('worker');
  });

  it('sets variables on the correct services', async () => {
    await converge(multiConfig, '/repo');

    expect(mockSetVariable).toHaveBeenCalledWith('api', 'DB', '${{main-db.DATABASE_URL}}');
    expect(mockSetVariable).toHaveBeenCalledWith('worker', 'REDIS', '${{cache.REDIS_URL}}');
  });

  it('deploys each service from its root', async () => {
    await converge(multiConfig, '/repo');

    expect(mockDeploy).toHaveBeenCalledWith('api', '/repo/apps/api');
    expect(mockDeploy).toHaveBeenCalledWith('worker', '/repo/apps/worker');
  });
});
