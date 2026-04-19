import { z } from 'zod';
import { ok } from './results.js';
import { auditLogger } from '../utils/audit.js';
import { defineTool } from './types.js';

export const auditTools = [
  defineTool({
    name: 'audit_list',
    description: 'List recent audit records.',
    schema: z.object({ limit: z.number().int().positive().max(1000).optional() }).strict(),
    run: async (params) => {
      const limit = params.limit ?? 100;
      const logs = await auditLogger.list(Math.max(1, Math.min(limit, 1000)));
      return ok(`Retrieved ${logs.length} audit entries.`, { count: logs.length, items: logs });
    },
  }),
];
