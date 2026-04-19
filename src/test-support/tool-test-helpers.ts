import type { Config } from '../config/index.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer _Item>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep<T>(base: T, overrides: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue;
    const baseValue = result[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(overrideValue) ? mergeDeep(baseValue, overrideValue) : overrideValue;
  }
  return result as T;
}

export function createTestConfig(overrides: DeepPartial<Config> = {}): Config {
  const base: Config = {
    azure: { clientId: 'test', tenantId: 'test' },
    scopes: ['User.Read'],
    guardrails: {
      email: { allowDomains: ['example.com'], requireDraftApproval: true, stripSensitiveFromLogs: false },
      audit: { enabled: false, logPath: '/tmp/audit.jsonl', retentionDays: 90 },
    },
    safety: { requireConfirmForWrites: true },
    output: { defaultIncludeFull: false, defaultMaxChars: 4000, hardMaxChars: 20000 },
    search: { defaultTop: 10, maxTop: 50 },
    calendar: { defaultTimezone: 'UTC' },
    storage: { tokenPath: 'graph-mcp/tokens', encryptionKey: '' },
    server: { apiKey: undefined, expectedAadObjectId: undefined },
    retrieval: { defaultDataSource: 'sharePoint', defaultMaxResults: 10 },
    parsers: { defaultMaxChars: 50000 },
  };

  return mergeDeep(base, overrides);
}

export function createAuditLoggerMock(entries?: Array<Record<string, unknown>>) {
  return {
    log: async (entry: Record<string, unknown>) => {
      entries?.push(entry);
    },
    list: async () => [],
    init: async () => {},
  };
}

export function createSilentLogMock() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

