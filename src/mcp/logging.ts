type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

const LOG_LEVEL_SEVERITY: Record<McpLogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export const VALID_LOG_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_SEVERITY));

let clientMinLogLevel: McpLogLevel = 'debug';
let stdioMode = false;

export function sendNotification(level: McpLogLevel, logger: string, data: unknown): void {
  if (!stdioMode) return;
  if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[clientMinLogLevel]) return;

  const notification = {
    jsonrpc: '2.0' as const,
    method: 'notifications/message',
    params: { level, logger, data },
  };

  process.stdout.write(JSON.stringify(notification) + '\n');
}

export function setClientMinLogLevel(level: McpLogLevel): void {
  clientMinLogLevel = level;
}

export function resetLoggingState(): void {
  clientMinLogLevel = 'debug';
  stdioMode = false;
}

export function setStdioMode(enabled: boolean): void {
  stdioMode = enabled;
}
