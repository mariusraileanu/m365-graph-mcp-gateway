import { z } from 'zod';
import { authTools } from './auth.js';
import { findTools } from './find.js';
import { getTools } from './get.js';
import { composeEmailTools } from './compose-email.js';
import { scheduleMeetingTools } from './schedule-meeting.js';
import { respondMeetingTools } from './respond-meeting.js';
import { auditTools } from './audit.js';
import { teamsChatTools } from './teams-chat.js';
import { teamsMeetingTools } from './teams-meeting.js';
import { retrievalTools } from './retrieve-context.js';
import { fail, normalizeError } from './results.js';
import type { ToolSpec, ToolResult } from './types.js';

export const tools: ToolSpec[] = [
  ...authTools,
  ...findTools,
  ...getTools,
  ...composeEmailTools,
  ...scheduleMeetingTools,
  ...respondMeetingTools,
  ...auditTools,
  ...teamsChatTools,
  ...teamsMeetingTools,
  ...retrievalTools,
];

const toolMap = new Map<string, ToolSpec>(tools.map((t) => [t.name, t]));

export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return fail('NOT_FOUND', `Tool not found: ${name}`);
  }

  try {
    const parsed = tool.schema.parse(args);
    return await tool.run(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fail('VALIDATION_ERROR', `Invalid parameters: ${issues}`);
    }
    const { code, message } = normalizeError(error);
    return fail(code, message);
  }
}
