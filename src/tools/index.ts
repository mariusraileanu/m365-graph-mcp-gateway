import { authTools } from './auth.js';
import { findTools } from './find.js';
import { getTools } from './get.js';
import { composeEmailTools } from './compose-email.js';
import { scheduleMeetingTools } from './schedule-meeting.js';
import { respondMeetingTools } from './respond-meeting.js';
import { summarizeTools } from './summarize.js';
import { prepareMeetingTools } from './prepare-meeting.js';
import { auditTools } from './audit.js';
import { fail, normalizeError } from '../utils/helpers.js';
import type { ToolSpec, ToolResult } from '../utils/types.js';

export const tools: ToolSpec[] = [
  ...authTools,
  ...findTools,
  ...getTools,
  ...composeEmailTools,
  ...scheduleMeetingTools,
  ...respondMeetingTools,
  ...summarizeTools,
  ...prepareMeetingTools,
  ...auditTools,
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return fail('NOT_FOUND', `Tool not found: ${name}`);
  }

  try {
    const parsed = tool.schema.parse(args);
    return await tool.run(parsed);
  } catch (error) {
    const { code, message } = normalizeError(error);
    return fail(code, message);
  }
}
