import { z } from 'zod';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ContentBlock = { type: 'text'; text: string };

export interface ToolSuccess {
  content: ContentBlock[];
  structuredContent: Json | Record<string, unknown>;
}

export interface ToolFailure {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
  isError: true;
}

export type ToolResult = ToolSuccess | ToolFailure;

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (params: unknown) => Promise<ToolResult>;
}

type ToolDefinition<TSchema extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TSchema;
  run: (params: z.output<TSchema>) => Promise<ToolResult>;
};

export function defineTool<TSchema extends z.ZodTypeAny>(tool: ToolDefinition<TSchema>): ToolSpec {
  return tool;
}
