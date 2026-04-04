import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock officeparser ──────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockParseOffice = mock.fn(
  async (): Promise<any> => ({
    type: 'docx',
    metadata: { title: 'Test Document', author: 'Alice', pages: 3 },
    content: [],
    attachments: [],
    toText: () => 'Hello world\nThis is a test document.',
  }),
);

mock.module('officeparser', {
  namedExports: {
    parseOffice: mockParseOffice,
  },
});

// ── Import after mocks ────────────────────────────────────────────────────
const { parseFile, isSupportedForParsing, supportedParseExtensions } = await import('../parsers/index.js');

describe('parsers', () => {
  describe('isSupportedForParsing', () => {
    it('returns true for supported extensions', () => {
      assert.equal(isSupportedForParsing('report.docx'), true);
      assert.equal(isSupportedForParsing('slides.pptx'), true);
      assert.equal(isSupportedForParsing('data.xlsx'), true);
      assert.equal(isSupportedForParsing('paper.pdf'), true);
      assert.equal(isSupportedForParsing('doc.odt'), true);
      assert.equal(isSupportedForParsing('pres.odp'), true);
      assert.equal(isSupportedForParsing('sheet.ods'), true);
      assert.equal(isSupportedForParsing('notes.rtf'), true);
    });

    it('returns false for unsupported extensions', () => {
      assert.equal(isSupportedForParsing('image.png'), false);
      assert.equal(isSupportedForParsing('video.mp4'), false);
      assert.equal(isSupportedForParsing('script.js'), false);
      assert.equal(isSupportedForParsing('noextension'), false);
    });

    it('handles case-insensitive extensions', () => {
      assert.equal(isSupportedForParsing('report.DOCX'), true);
      assert.equal(isSupportedForParsing('slides.Pptx'), true);
    });
  });

  describe('supportedParseExtensions', () => {
    it('returns an array of extensions', () => {
      const exts = supportedParseExtensions();
      assert.ok(Array.isArray(exts));
      assert.ok(exts.length > 0);
      assert.ok(exts.includes('.docx'));
      assert.ok(exts.includes('.pptx'));
      assert.ok(exts.includes('.pdf'));
      assert.ok(exts.includes('.xlsx'));
    });
  });

  describe('parseFile', () => {
    it('extracts text from a supported file', async () => {
      const buffer = Buffer.from('fake docx content');
      const result = await parseFile(buffer, 'report.docx');

      assert.equal(result.document_type, 'document');
      assert.equal(result.file_name, 'report.docx');
      assert.equal(result.size_bytes, buffer.length);
      assert.equal(result.content, 'Hello world\nThis is a test document.');
      assert.equal(result.truncated, false);
      assert.ok(result.char_count > 0);
      assert.equal(result.metadata.title, 'Test Document');
      assert.equal(result.metadata.author, 'Alice');
      assert.equal(result.metadata.pages, 3);
    });

    it('truncates long content to max_chars', async () => {
      mockParseOffice.mock.mockImplementation(async () => ({
        type: 'docx',
        metadata: {},
        content: [],
        attachments: [],
        toText: () => 'A'.repeat(10000),
      }));

      const buffer = Buffer.from('fake content');
      const result = await parseFile(buffer, 'long.docx', 100);

      assert.equal(result.truncated, true);
      assert.equal(result.char_count, 100);
      assert.equal(result.content.length, 100);

      // Restore default mock
      mockParseOffice.mock.mockImplementation(async () => ({
        type: 'docx',
        metadata: { title: 'Test Document', author: 'Alice', pages: 3 },
        content: [],
        attachments: [],
        toText: () => 'Hello world\nThis is a test document.',
      }));
    });

    it('throws UNSUPPORTED_FILE_TYPE for unknown extensions', async () => {
      const buffer = Buffer.from('not a document');
      await assert.rejects(
        () => parseFile(buffer, 'image.png'),
        (err: Error) => err.message.includes('UNSUPPORTED_FILE_TYPE'),
      );
    });

    it('throws FILE_TOO_LARGE for oversized files', async () => {
      // Create a buffer descriptor that reports a huge size
      const hugeBuffer = { length: 60 * 1024 * 1024 } as Buffer;
      await assert.rejects(
        () => parseFile(hugeBuffer, 'huge.docx'),
        (err: Error) => err.message.includes('FILE_TOO_LARGE'),
      );
    });

    it('throws PARSE_ERROR when officeparser fails', async () => {
      mockParseOffice.mock.mockImplementation(async () => {
        throw new Error('corrupt file');
      });

      const buffer = Buffer.from('corrupt content');
      await assert.rejects(
        () => parseFile(buffer, 'bad.docx'),
        (err: Error) => err.message.includes('PARSE_ERROR'),
      );

      // Restore default mock
      mockParseOffice.mock.mockImplementation(async () => ({
        type: 'docx',
        metadata: { title: 'Test Document', author: 'Alice', pages: 3 },
        content: [],
        attachments: [],
        toText: () => 'Hello world\nThis is a test document.',
      }));
    });

    it('maps document types correctly', async () => {
      const buffer = Buffer.from('content');

      // Reset mock for each call
      const result1 = await parseFile(buffer, 'slides.pptx');
      assert.equal(result1.document_type, 'presentation');

      const result2 = await parseFile(buffer, 'data.xlsx');
      assert.equal(result2.document_type, 'spreadsheet');

      const result3 = await parseFile(buffer, 'paper.pdf');
      assert.equal(result3.document_type, 'pdf');

      const result4 = await parseFile(buffer, 'report.docx');
      assert.equal(result4.document_type, 'document');
    });
  });
});
