/**
 * Config schema for railway-deploy.jsonc
 *
 * Validates the declarative infrastructure config and provides
 * typed access to the configuration values.
 */

import { readFileSync } from 'node:fs';

import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

const SUPPORTED_VERSIONS = [1] as const;

const DatabaseSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['postgres', 'mysql', 'redis', 'mongo']),
});

const ServiceSchema = z.object({
  name: z.string().min(1),
  root: z.string().min(1),
  variables: z.record(z.string(), z.string()).optional(),
});

const ConfigSchema = z.object({
  version: z
    .number()
    .refine(
      (v): v is (typeof SUPPORTED_VERSIONS)[number] =>
        (SUPPORTED_VERSIONS as readonly number[]).includes(v),
      { message: `Unsupported config version. Supported: ${SUPPORTED_VERSIONS.join(', ')}` }
    ),
  project: z.object({
    name: z.string().min(1),
  }),
  databases: z.array(DatabaseSchema).default([]),
  services: z.array(ServiceSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;

/**
 * Load and validate a railway-deploy.jsonc config file.
 * Throws with a descriptive error if validation fails.
 */
export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, 'utf-8');
  const json: unknown = parseJsonc(raw);
  return ConfigSchema.parse(json);
}
