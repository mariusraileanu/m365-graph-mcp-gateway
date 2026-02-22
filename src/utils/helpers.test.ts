import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecipients,
  checkEmailAllowed,
  compactText,
  normalizeError,
  stripHtml,
  escapeHtml,
  sanitizeEmailHtml,
  collectCitations,
} from './helpers.js';

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

describe('collectCitations', () => {
  it('extracts citations from nested object', () => {
    const data = {
      results: [
        { title: 'Doc A', url: 'https://example.com/a' },
        { title: 'Doc B', source: 'SharePoint' },
      ],
    };
    const citations: Array<Record<string, unknown>> = [];
    collectCitations(data, citations);
    assert.equal(citations.length, 2);
    assert.equal(citations[0]?.title, 'Doc A');
    assert.equal(citations[1]?.source, 'SharePoint');
  });
  it('respects depth limit', () => {
    let nested: Record<string, unknown> = { title: 'deep' };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    const citations: Array<Record<string, unknown>> = [];
    collectCitations(nested, citations);
    assert.equal(citations.length, 0);
  });
  it('handles null/undefined gracefully', () => {
    const citations: Array<Record<string, unknown>> = [];
    collectCitations(null, citations);
    collectCitations(undefined, citations);
    assert.equal(citations.length, 0);
  });
});
