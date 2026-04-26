import { after, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-support/tool-test-helpers.js';

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; headers?: Headers }> = [];
let fetchResponse = { ok: true, status: 200, text: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Alice>Hello\n' };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  fetchCalls.push({ url, headers: new Headers(init?.headers) });
  return {
    ok: fetchResponse.ok,
    status: fetchResponse.status,
    headers: new Headers(),
    text: async () => fetchResponse.text,
  };
}) as typeof globalThis.fetch;

mock.module('../auth/index.js', {
  namedExports: {
    getAccessToken: async () => 'mock-token',
    getGraph: () => ({}),
  },
});

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => createTestConfig(),
  },
});

const { getTranscriptContent } = await import('./teams.js');

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fetchCalls.length = 0;
  fetchResponse = { ok: true, status: 200, text: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Alice>Hello\n' };
});

describe('getTranscriptContent', () => {
  it('requests transcript content with the documented VTT format query', async () => {
    const content = await getTranscriptContent('meeting/id', 'transcript=');

    assert.ok(content.startsWith('WEBVTT'));
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0]?.url,
      'https://graph.microsoft.com/v1.0/me/onlineMeetings/meeting%2Fid/transcripts/transcript%3D/content?$format=text/vtt',
    );
    assert.equal(fetchCalls[0]?.headers?.get('Accept'), 'text/vtt');
    assert.equal(fetchCalls[0]?.headers?.get('Authorization'), 'Bearer mock-token');
  });

  it('includes Graph response details when transcript content fails', async () => {
    fetchResponse = {
      ok: false,
      status: 400,
      text: '{"error":{"code":"BadRequest","message":"Invalid format."}}',
    };

    await assert.rejects(() => getTranscriptContent('meeting-1', 'transcript-1'), /400.*Invalid format/);
  });
});
