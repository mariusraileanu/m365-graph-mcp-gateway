import { getGraph } from '../auth/index.js';
import { downloadGraphContent } from './http.js';
import type { GraphSearchHit, GraphSearchResponse } from './types.js';

type GraphDriveItemFileFacet = {
  mimeType?: string;
};

type GraphParentReference = {
  driveId?: string;
  path?: string;
};

export type GraphDriveItem = {
  id?: string;
  name?: string;
  parentReference?: GraphParentReference;
  lastModifiedDateTime?: string;
  size?: number;
  webUrl?: string;
  '@microsoft.graph.downloadUrl'?: string;
  file?: GraphDriveItemFileFacet;
  createdBy?: { user?: { displayName?: string; id?: string } };
  lastModifiedBy?: { user?: { displayName?: string; id?: string } };
};

export type DriveItemInfo = {
  name: string;
  size: number;
  mimeType: string;
  downloadUrl: string | null;
  webUrl: string | null;
};

export function extractGraphSearchHits<TResource>(response: GraphSearchResponse<TResource>): Array<GraphSearchHit<TResource>> {
  const values = Array.isArray(response.value) ? response.value : [];
  return values[0]?.hitsContainers?.[0]?.hits ?? [];
}

export function pickFile(item: GraphDriveItem, includeFullPayload: boolean): Record<string, unknown> {
  const parent = item.parentReference;
  const minimal = {
    id: item.id,
    drive_id: parent?.driveId,
    name: item.name,
    path: parent?.path,
    modified_at: item.lastModifiedDateTime,
    size: item.size,
    web_url: item.webUrl,
    download_url: item['@microsoft.graph.downloadUrl'] ?? null,
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

export async function getDriveItem(driveId: string, itemId: string): Promise<GraphDriveItem> {
  return (await getGraph()
    .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`)
    .get()) as GraphDriveItem;
}

export function getDriveItemInfo(item: GraphDriveItem): DriveItemInfo {
  return {
    name: item.name || 'unknown',
    size: item.size ?? 0,
    mimeType: item.file?.mimeType || 'application/octet-stream',
    downloadUrl: item['@microsoft.graph.downloadUrl'] ?? null,
    webUrl: item.webUrl ?? null,
  };
}

export async function downloadDriveItemContent(driveId: string, itemId: string): Promise<Buffer> {
  const endpoint = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
  const { buffer } = await downloadGraphContent(endpoint, 'UPSTREAM_ERROR: file download failed');
  return buffer;
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

  const hits = extractGraphSearchHits(response as GraphSearchResponse<GraphDriveItem>);

  const q = query.toLowerCase();
  const mapped: Record<string, unknown>[] = [];
  for (const hit of hits) {
    const resource = hit.resource ?? ({} as GraphDriveItem);
    const summary = (hit.summary || '').trim();
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
