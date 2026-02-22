import { z } from 'zod';
import { getGraph } from '../auth/index.js';
import { loadConfig } from '../config/index.js';
import { ok, compactText } from '../utils/helpers.js';
import { copilotRetrieval, formatRetrievalResults } from '../graph/retrieval.js';
import { searchFiles } from '../graph/files.js';
import { log } from '../utils/log.js';
import type { ToolSpec } from '../utils/types.js';

export const summarizeTools: ToolSpec[] = [
  {
    name: 'summarize',
    description:
      'AI-powered summarization of a document, email thread, or any M365 entity. Provide a file by query/drive_id+item_id, or describe what to summarize in free text.',
    schema: z
      .object({
        query: z.string().optional(),
        drive_id: z.string().optional(),
        item_id: z.string().optional(),
        focus: z.string().optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      const focus = typeof params.focus === 'string' ? params.focus.trim() : '';
      const maxChars = Number.parseInt(String(params.max_chars || loadConfig().output.defaultMaxChars), 10);

      const driveId = String(params.drive_id || '').trim();
      const itemId = String(params.item_id || '').trim();
      const query = String(params.query || '').trim();

      let documentContent = '';
      let documentRef = '';
      let provider = 'graph';
      const citations: Array<Record<string, string>> = [];

      if (driveId && itemId) {
        // Direct file reference — fetch from Graph
        const file = await getGraph()
          .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`)
          .select('id,name,webUrl,parentReference')
          .get();
        documentRef = `${String(file?.name || itemId)}`;
        if (file?.webUrl) citations.push({ title: documentRef, url: String(file.webUrl) });

        // Try to get file content for text-based files
        try {
          const content = await getGraph()
            .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`)
            .get();
          if (typeof content === 'string') documentContent = content;
        } catch {
          /* binary file or access denied — proceed without content */
        }
      } else if (query) {
        // Use Copilot Retrieval API for semantic search
        try {
          const searchQuery = focus ? `${query} ${focus}` : query;
          const results = await copilotRetrieval({ queryString: searchQuery, maxResults: 5 });
          const first = results[0];
          if (first) {
            provider = 'copilot-retrieval';
            const formatted = formatRetrievalResults(results);
            documentContent = formatted.text;
            citations.push(...formatted.citations);
            documentRef = first.title || query;
          }
        } catch (err) {
          log.warn('Copilot Retrieval failed, falling back to Graph Search', { error: (err as Error).message });
        }

        // Fallback to Graph file search if retrieval didn't produce results
        if (!documentContent) {
          const found = await searchFiles(query, 3, 'both', false);
          if (found.length > 0) {
            provider = 'graph-search';
            documentRef = String(found[0]!.name || query);
            documentContent = found.map((f) => `${String(f.name)}: ${String(f.snippet || '')}`).join('\n\n');
            for (const f of found) {
              if (f.web_url) citations.push({ title: String(f.name || ''), url: String(f.web_url) });
            }
          } else {
            documentRef = query;
            documentContent = `No documents found matching: ${query}`;
          }
        }
      } else {
        throw new Error('VALIDATION_ERROR: provide query OR both drive_id and item_id');
      }

      const summaryParts = [`Content from: ${documentRef}`];
      if (focus) summaryParts.push(`Focus: ${focus}`);
      summaryParts.push('', documentContent);
      const summary = compactText(summaryParts.join('\n'), maxChars);

      return ok(`Summary for: "${documentRef}"`, {
        provider,
        document: documentRef,
        focus: focus || undefined,
        summary: summary.text,
        truncated: summary.truncated,
        citations: citations.slice(0, 30),
      });
    },
  },
];
