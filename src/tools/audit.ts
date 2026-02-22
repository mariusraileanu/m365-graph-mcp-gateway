import { z } from 'zod';
import { ok } from '../utils/helpers.js';
import { auditLogger } from '../utils/audit.js';
import type { ToolSpec } from '../utils/types.js';

export const auditTools: ToolSpec[] = [
  {
    name: 'audit_list',
    description: 'List recent audit records.',
    schema: z.object({ limit: z.number().int().positive().max(1000).optional() }).strict(),
    run: async (params) => {
      const limit = Number.parseInt(String(params.limit ?? 100), 10);
      const logs = await auditLogger.list(Math.max(1, Math.min(limit, 1000)));
      return ok(`Retrieved ${logs.length} audit entries.`, { count: logs.length, items: logs });
    },
  },
];
