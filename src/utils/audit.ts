import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config/index.js';
import { resolveStoragePath } from './helpers.js';
import type { AuditEntry } from './types.js';

export class AuditLogger {
  private logPath: string;
  private enabled: boolean;

  constructor() {
    const cfg = loadConfig();
    this.enabled = cfg.guardrails.audit.enabled;
    this.logPath = resolveStoragePath(cfg.guardrails.audit.logPath);
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await fs.promises.mkdir(path.dirname(this.logPath), { recursive: true });
    if (!fs.existsSync(this.logPath)) {
      await fs.promises.writeFile(this.logPath, '');
    }
  }

  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    if (!this.enabled) return;
    const payload: AuditEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    await fs.promises.appendFile(this.logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    if (!this.enabled || !fs.existsSync(this.logPath)) return [];

    // Stream-read: keep only the last `limit` lines in a ring buffer
    const entries: AuditEntry[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(this.logPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
        if (entries.length > limit) entries.shift();
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }
}

export const auditLogger = new AuditLogger();
