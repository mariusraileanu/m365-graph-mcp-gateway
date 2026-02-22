import { loadConfig } from './config/index.js';
import { login, logout, currentUser, isLoggedIn, loadTokenCache } from './auth/index.js';
import { auditLogger } from './utils/audit.js';
import { log } from './utils/log.js';
import { startHttpServer, startMcpStdioServer, getHttpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  loadConfig(); // validate config early
  await auditLogger.init();
  await loadTokenCache();

  if (args.includes('--login') || args.includes('--login-interactive')) {
    await login('interactive');
    log.info('Logged in', { user: currentUser() || 'unknown' });
    return;
  }
  if (args.includes('--login-device')) {
    await login('device');
    log.info('Logged in', { user: currentUser() || 'unknown' });
    return;
  }
  if (args.includes('--logout')) {
    await logout();
    log.info('Logged out');
    return;
  }
  if (args.includes('--user')) {
    if (!isLoggedIn()) {
      log.error('Not logged in');
      process.exit(1);
    }
    log.info('Current user', { user: currentUser() });
    return;
  }

  // For stdio mode, require pre-authentication
  if (args.includes('--stdio')) {
    if (!isLoggedIn()) {
      log.error('Not logged in. Run with --login first.');
      process.exit(1);
    }
    startMcpStdioServer();
    return;
  }

  // HTTP mode: allow starting without auth (users can sign in via device-code or auth tool)
  const port = Number(process.env.PORT) || 3000;
  if (!isLoggedIn()) {
    log.warn('Not logged in. Use --login-device or the auth MCP tool to sign in.');
  }

  startHttpServer(port);
}

main().catch((error) => {
  log.error('Fatal error', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal: sig });

    const server = getHttpServer();
    if (server) {
      server.close(() => log.info('HTTP server closed'));
    }

    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
