/**
 * Generates a JSON Schema from the Zod config schema.
 * Run as part of the build step — output goes to dist/schema.json.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import { ConfigSchema } from '../src/config.js';

const jsonSchema = zodToJsonSchema(ConfigSchema, {
  name: 'RailwayDeployConfig',
  $refStrategy: 'none',
});

const outputPath = join(import.meta.dirname, '../dist/schema.json');
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));

console.log(`Generated JSON Schema at ${outputPath}`);
