import { currentUser } from '../auth/index.js';
import { auditLogger } from '../utils/audit.js';

async function currentAuditUser(): Promise<string> {
  return (await currentUser()) || 'unknown';
}

export async function writeAuditLog(
  action: string,
  details: Record<string, unknown>,
  status: 'success' | 'blocked' | 'error' = 'success',
): Promise<void> {
  await auditLogger.log({
    action,
    user: await currentAuditUser(),
    details,
    status,
  });
}
