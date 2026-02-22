import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const ConfigSchema = z.object({
  azure: z.object({
    clientId: z.string().min(1, 'GRAPH_MCP_CLIENT_ID is required'),
    tenantId: z.string().min(1, 'GRAPH_MCP_TENANT_ID is required'),
  }),
  scopes: z.array(z.string()).min(1),
  guardrails: z
    .object({
      email: z
        .object({
          allowDomains: z.array(z.string()).default([]),
          requireDraftApproval: z.boolean().default(true),
          stripSensitiveFromLogs: z.boolean().default(true),
        })
        .default({}),
      audit: z
        .object({
          enabled: z.boolean().default(true),
          logPath: z.string().default('./data/audit/audit.jsonl'),
          retentionDays: z.number().int().positive().default(90),
        })
        .default({}),
    })
    .default({}),
  safety: z
    .object({
      requireConfirmForWrites: z.boolean().default(true),
    })
    .default({}),
  output: z
    .object({
      defaultIncludeFull: z.boolean().default(false),
      defaultMaxChars: z.number().int().positive().default(4000),
      hardMaxChars: z.number().int().positive().default(20000),
    })
    .default({}),
  search: z
    .object({
      defaultTop: z.number().int().positive().default(10),
      maxTop: z.number().int().positive().default(50),
    })
    .default({}),
  calendar: z
    .object({
      defaultTimezone: z.string().default('Asia/Dubai'),
    })
    .default({}),
  storage: z
    .object({
      tokenPath: z.string().default('./data/tokens'),
    })
    .default({}),
  retrieval: z
    .object({
      enabled: z.boolean().default(true),
      dataSource: z.enum(['sharePoint', 'oneDriveBusiness']).default('sharePoint'),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AzureConfig = Config['azure'];
export type GuardrailsConfig = Config['guardrails'];
export type SafetyConfig = Config['safety'];
export type OutputConfig = Config['output'];
export type SearchConfig = Config['search'];
export type CalendarConfig = Config['calendar'];
export type StorageConfig = Config['storage'];
export type RetrievalConfig = Config['retrieval'];

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return process.env[key] || '';
  });
}

function expandEnvVarsInObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = expandEnvVars(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? expandEnvVars(v) : v));
    } else if (value && typeof value === 'object') {
      result[key] = expandEnvVarsInObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

let cachedConfig: Config | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.resolve(__dirname, '../../config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const fileContents = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.parse(fileContents);
  const expanded = expandEnvVarsInObject(parsed as Record<string, unknown>);

  const result = ConfigSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = result.data;

  // Fail fast on missing required env vars
  if (!config.azure.clientId) {
    throw new Error('GRAPH_MCP_CLIENT_ID is required. Set it in .env or as an environment variable.');
  }
  if (!config.azure.tenantId) {
    throw new Error('GRAPH_MCP_TENANT_ID is required. Set it in .env or as an environment variable.');
  }

  cachedConfig = config;
  return config;
}
