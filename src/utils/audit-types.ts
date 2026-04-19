export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  user: string;
  details: Record<string, unknown>;
  status: 'success' | 'blocked' | 'error';
  error?: string;
}
