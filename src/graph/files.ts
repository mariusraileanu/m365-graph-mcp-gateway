import { getGraph } from '../auth/index.js';

export function pickFile(item: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const parent = (item.parentReference || {}) as Record<string, unknown>;
  const minimal = {
    id: item.id,
    drive_id: parent.driveId,
    name: item.name,
    path: parent.path,
    modified_at: item.lastModifiedDateTime,
    size: item.size,
    web_url: item.webUrl,
  };
  if (!includeFullPayload) return minimal;
  return {
    ...minimal,
    file: item.file,
    created_by: item.createdBy,
    modified_by: item.lastModifiedBy,
    parent_reference: item.parentReference,
  };
}

export async function searchFiles(
  query: string,
  top: number,
  mode: 'name' | 'content' | 'both',
  includeFullPayload: boolean,
): Promise<Record<string, unknown>[]> {
  const response = await getGraph()
    .api('/search/query')
    .post({
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString: query },
          from: 0,
          size: top,
          fields: ['id', 'name', 'webUrl', 'lastModifiedDateTime', 'size', 'file', 'parentReference', 'createdBy', 'lastModifiedBy'],
        },
      ],
    });

  const values = Array.isArray((response as { value?: unknown[] }).value) ? (response as { value: unknown[] }).value : [];
  const hits =
    (values[0] as { hitsContainers?: Array<{ hits?: Array<{ resource?: Record<string, unknown>; summary?: string }> }> } | undefined)
      ?.hitsContainers?.[0]?.hits || [];

  const q = query.toLowerCase();
  const mapped: Record<string, unknown>[] = [];
  for (const hit of hits) {
    const resource = hit.resource || {};
    const summary = String(hit.summary || '').trim();
    const file = pickFile(resource, includeFullPayload);

    const name = String(file.name || '').toLowerCase();
    const inName = name.includes(q);
    const inContent = summary.toLowerCase().includes(q);

    if (mode === 'name' && !inName) continue;
    if (mode === 'content' && !inContent) continue;

    mapped.push({ ...file, snippet: summary });
  }

  mapped.sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
  return mapped.slice(0, top);
}
