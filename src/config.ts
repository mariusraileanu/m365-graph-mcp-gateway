import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { fileURLToPath } from 'url';

export interface AzureConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

export interface GuardrailsConfig {
  email: {
    allowDomains: string[];
    requireDraftApproval: boolean;
    stripSensitiveFromLogs: boolean;
  };
  audit: {
    enabled: boolean;
    logPath: string;
    retentionDays: number;
  };
}

export interface StorageConfig {
  tokenPath: string;
  sessionTimeoutMinutes: number;
}

export interface Config {
  azure: AzureConfig;
  scopes: string[];
  guardrails: GuardrailsConfig;
  storage: StorageConfig;
}

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
      result[key] = value.map(v => typeof v === 'string' ? expandEnvVars(v) : v);
    } else if (value && typeof value === 'object') {
      result[key] = expandEnvVarsInObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.resolve(__dirname, '../config.yaml');
  const fileContents = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.parse(fileContents);
  const expanded = expandEnvVarsInObject(parsed as Record<string, unknown>) as unknown as Config;

  if (!expanded.azure.clientId || !expanded.azure.tenantId) {
    throw new Error('Azure clientId and tenantId are required. Set GRAPH_MCP_CLIENT_ID and GRAPH_MCP_TENANT_ID environment variables.');
  }

  cachedConfig = expanded;
  return expanded;
}
