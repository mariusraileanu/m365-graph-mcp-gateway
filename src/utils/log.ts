/** Structured JSON logger for production use. */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

/**
 * All log output goes to stderr.
 *
 * In stdio MCP transport mode, stdout is the JSON-RPC channel — writing
 * log lines there would corrupt the protocol stream.  Using stderr for
 * every level keeps the transport clean regardless of mode while still
 * making logs visible in the terminal / container runtime.
 */
function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...data,
  };
  const line = JSON.stringify(entry);
  process.stderr.write(line + '\n');
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, data);
  },
};
