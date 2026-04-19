import { getAccessToken } from '../auth/index.js';

/**
 * Authenticated fetch against the Graph API. Injects the Bearer token and
 * throws on non-2xx with a prefixed error message.
 */
export async function graphFetch(
  endpoint: string,
  errorPrefix: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(endpoint, { ...init, headers });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const suffix = details.trim() ? `: ${details.trim().slice(0, 300)}` : '';
    throw new Error(`${errorPrefix} (${response.status})${suffix}`);
  }

  return response;
}

export async function downloadGraphContent(
  endpoint: string,
  errorPrefix: string,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await graphFetch(endpoint, errorPrefix);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
  };
}
