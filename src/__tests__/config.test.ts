import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe('loadConfig', () => {
  it('parses a valid config with comments and all fields', () => {
    const config = loadConfig(fixture('valid.jsonc'));

    expect(config.version).toBe(1);
    expect(config.project.name).toBe('my-app');
    expect(config.databases).toHaveLength(1);
    expect(config.databases[0]?.type).toBe('postgres');
    expect(config.databases[0]?.name).toBe('postgres');
    expect(config.services).toHaveLength(1);
    expect(config.services[0]?.name).toBe('api');
    expect(config.services[0]?.root).toBe('apps/api');
    expect(config.services[0]?.variables?.DATABASE_URL).toContain('DATABASE_URL');
    expect(config.services[0]?.variables?.NODE_ENV).toBe('production');
  });

  it('supports block comments', () => {
    const config = loadConfig(fixture('block-comments.jsonc'));
    expect(config.project.name).toBe('test');
  });

  it('defaults databases and services to empty arrays', () => {
    const config = loadConfig(fixture('minimal.jsonc'));
    expect(config.databases).toEqual([]);
    expect(config.services).toEqual([]);
  });

  it('rejects unsupported version', () => {
    expect(() => loadConfig(fixture('bad-version.jsonc'))).toThrow('Unsupported config version');
  });

  it('rejects missing project', () => {
    expect(() => loadConfig(fixture('no-project.jsonc'))).toThrow();
  });

  it('rejects empty project name', () => {
    expect(() => loadConfig(fixture('empty-name.jsonc'))).toThrow();
  });

  it('rejects service without root', () => {
    expect(() => loadConfig(fixture('no-root.jsonc'))).toThrow();
  });

  it('rejects invalid database type', () => {
    expect(() => loadConfig(fixture('bad-db-type.jsonc'))).toThrow();
  });

  it('rejects non-string variable values', () => {
    expect(() => loadConfig(fixture('bad-vars.jsonc'))).toThrow();
  });

  it('allows services without variables', () => {
    const config = loadConfig(fixture('no-vars.jsonc'));
    expect(config.services[0]?.variables).toBeUndefined();
  });

  it('throws on nonexistent file', () => {
    expect(() => loadConfig('/nonexistent/path.jsonc')).toThrow();
  });
});
