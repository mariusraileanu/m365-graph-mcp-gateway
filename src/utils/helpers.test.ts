import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  resolveStoragePath,
  parseRecipients,
  checkEmailAllowed,
  compactText,
  normalizeError,
  stripHtml,
  escapeHtml,
  sanitizeEmailHtml,
  escapeODataString,
} from './helpers.js';

describe('resolveStoragePath', () => {
  let existsSyncMock: ReturnType<typeof mock.method<typeof fs, 'existsSync'>>;
  const originalUserSlug = process.env.USER_SLUG;

  beforeEach(() => {
    existsSyncMock = mock.method(fs, 'existsSync');
    delete process.env.USER_SLUG;
  });

  afterEach(() => {
    existsSyncMock.mock.restore();
    if (originalUserSlug !== undefined) {
      process.env.USER_SLUG = originalUserSlug;
    } else {
      delete process.env.USER_SLUG;
    }
  });

  it('resolves to /app/data/<slug>/<path> when USER_SLUG set and /app/data exists', () => {
    process.env.USER_SLUG = 'jdoe';
    existsSyncMock.mock.mockImplementation((p: fs.PathLike) => String(p) === '/app/data');
    const result = resolveStoragePath('graph-mcp/tokens');
    assert.equal(result, '/app/data/jdoe/graph-mcp/tokens');
  });

  it('resolves to /app/<path> when /app exists but no USER_SLUG', () => {
    existsSyncMock.mock.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === '/app';
    });
    const result = resolveStoragePath('graph-mcp/tokens');
    assert.equal(result, '/app/graph-mcp/tokens');
  });

  it('resolves to cwd/data/<path> for local dev (no /app, no USER_SLUG)', () => {
    existsSyncMock.mock.mockImplementation(() => false);
    const result = resolveStoragePath('graph-mcp/tokens');
    assert.equal(result, path.resolve(process.cwd(), 'data', 'graph-mcp/tokens'));
  });

  it('falls through to /app when USER_SLUG set but /app/data missing', () => {
    process.env.USER_SLUG = 'jdoe';
    existsSyncMock.mock.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === '/app'; // /app/data doesn't exist, but /app does
    });
    const result = resolveStoragePath('graph-mcp/tokens');
    assert.equal(result, '/app/graph-mcp/tokens');
  });

  it('handles nested audit path correctly', () => {
    process.env.USER_SLUG = 'anotheruser';
    existsSyncMock.mock.mockImplementation((p: fs.PathLike) => String(p) === '/app/data');
    const result = resolveStoragePath('graph-mcp/audit/audit.jsonl');
    assert.equal(result, '/app/data/anotheruser/graph-mcp/audit/audit.jsonl');
  });
});

describe('parseRecipients', () => {
  it('parses comma-separated string', () => {
    assert.deepEqual(parseRecipients('a@b.com, c@d.com'), ['a@b.com', 'c@d.com']);
  });
  it('accepts array', () => {
    assert.deepEqual(parseRecipients(['x@y.com']), ['x@y.com']);
  });
  it('returns empty for undefined', () => {
    assert.deepEqual(parseRecipients(undefined), []);
  });
  it('trims whitespace', () => {
    assert.deepEqual(parseRecipients('  a@b.com  '), ['a@b.com']);
  });
});

describe('compactText', () => {
  it('returns full text under limit', () => {
    const result = compactText('hello', 100);
    assert.equal(result.text, 'hello');
    assert.equal(result.truncated, false);
  });
  it('truncates above limit', () => {
    // compactText clamps minimum to 200 chars, so a 10-char string is never truncated
    const result = compactText('abcdefghij', 5);
    assert.equal(result.text, 'abcdefghij');
    assert.equal(result.truncated, false);
  });
});

describe('normalizeError', () => {
  it('extracts code from CODE: message pattern', () => {
    const result = normalizeError(new Error('AUTH_REQUIRED: not logged in'));
    assert.equal(result.code, 'AUTH_REQUIRED');
    assert.equal(result.message, 'AUTH_REQUIRED: not logged in');
  });
  it('defaults to INTERNAL_ERROR for plain errors', () => {
    const result = normalizeError(new Error('something broke'));
    assert.equal(result.code, 'INTERNAL_ERROR');
  });
  it('handles non-Error objects', () => {
    const result = normalizeError('string error');
    assert.equal(result.code, 'INTERNAL_ERROR');
    assert.equal(result.message, 'string error');
  });
});

describe('stripHtml', () => {
  it('removes tags', () => {
    assert.equal(stripHtml('<p>Hello</p>'), 'Hello');
  });
  it('handles nested tags', () => {
    // Tags are replaced with spaces, so </b> + existing space yields double space
    assert.equal(stripHtml('<div><b>bold</b> text</div>'), 'bold  text');
  });
});

describe('escapeHtml', () => {
  it('escapes special characters', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('sanitizeEmailHtml', () => {
  it('removes script tags', () => {
    assert.equal(sanitizeEmailHtml('<p>Hello</p><script>alert("xss")</script>'), '<p>Hello</p>');
  });
  it('removes iframe tags', () => {
    assert.equal(sanitizeEmailHtml('<iframe src="evil.com"></iframe><p>ok</p>'), '<p>ok</p>');
  });
  it('removes event handlers', () => {
    const result = sanitizeEmailHtml('<img src="x" onerror="alert(1)">');
    assert.ok(!result.includes('onerror'));
  });
  it('blocks javascript: URIs', () => {
    const result = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    assert.ok(!result.includes('javascript:'));
  });
  it('preserves safe HTML', () => {
    assert.equal(sanitizeEmailHtml('<p>Hello <b>world</b></p>'), '<p>Hello <b>world</b></p>');
  });
});

describe('escapeODataString', () => {
  it('returns plain strings unchanged', () => {
    assert.equal(escapeODataString('hello'), 'hello');
  });

  it('escapes single quotes by doubling them', () => {
    assert.equal(escapeODataString("it's"), "it''s");
  });

  it('escapes multiple single quotes', () => {
    assert.equal(escapeODataString("it's a 'test'"), "it''s a ''test''");
  });

  it('handles empty string', () => {
    assert.equal(escapeODataString(''), '');
  });

  it('handles string with only single quotes', () => {
    assert.equal(escapeODataString("'''"), "''''''");
  });

  it('does not alter double quotes or other characters', () => {
    assert.equal(escapeODataString('hello "world" <>&'), 'hello "world" <>&');
  });
});
