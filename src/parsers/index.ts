/**
 * File content parser — extracts readable text from Office/PDF files.
 *
 * Uses officeparser v6 which returns a full AST. We use .toText() for plain
 * text extraction and pull metadata from the AST. This keeps output simple
 * and predictable while leveraging the library's rich parsing.
 *
 * Supported formats: .pptx, .docx, .pdf, .xlsx, .odt, .odp, .ods, .rtf
 */

import { parseOffice } from 'officeparser';
import type { OfficeParserAST } from 'officeparser';

const SUPPORTED_EXTENSIONS = new Set(['.pptx', '.docx', '.pdf', '.xlsx', '.odt', '.odp', '.ods', '.rtf']);

/** Max file size for parsing (50 MB). */
const PARSE_MAX_BYTES = 50 * 1024 * 1024;

export interface ParsedDocument {
  document_type: string;
  file_name: string;
  size_bytes: number;
  content: string;
  truncated: boolean;
  char_count: number;
  metadata: {
    title?: string;
    author?: string;
    pages?: number;
  };
}

/** Derive document_type from file extension. */
function documentType(ext: string): string {
  switch (ext) {
    case '.pptx':
    case '.odp':
      return 'presentation';
    case '.docx':
    case '.odt':
    case '.rtf':
      return 'document';
    case '.pdf':
      return 'pdf';
    case '.xlsx':
    case '.ods':
      return 'spreadsheet';
    default:
      return 'unknown';
  }
}

/** Get the lowercase file extension including the dot. */
function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

/**
 * Check whether a file extension is supported for parsing.
 */
export function isSupportedForParsing(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(getExtension(fileName));
}

/**
 * Return the list of supported file extensions (for tool descriptions / errors).
 */
export function supportedParseExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS];
}

/**
 * Parse a file buffer into a plain-text document with metadata.
 *
 * @param buffer  The raw file content
 * @param fileName  Original file name (used for extension detection)
 * @param maxChars  Maximum characters to return (truncates if exceeded)
 * @returns ParsedDocument with extracted text
 * @throws Error with UNSUPPORTED_FILE_TYPE if extension is not supported
 * @throws Error with FILE_TOO_LARGE if buffer exceeds 50 MB
 * @throws Error with PARSE_ERROR if officeparser fails
 */
export async function parseFile(buffer: Buffer, fileName: string, maxChars?: number): Promise<ParsedDocument> {
  const ext = getExtension(fileName);

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `UNSUPPORTED_FILE_TYPE: '${ext}' is not supported for parsing. ` + `Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }

  if (buffer.length > PARSE_MAX_BYTES) {
    throw new Error(`FILE_TOO_LARGE: file is ${buffer.length} bytes (limit: ${PARSE_MAX_BYTES} for parsed mode)`);
  }

  let ast: OfficeParserAST;
  try {
    ast = await parseOffice(buffer, { newlineDelimiter: '\n', putNotesAtLast: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PARSE_ERROR: failed to extract text from '${fileName}': ${msg}`);
  }

  // Extract plain text from AST
  const rawText = ast.toText();

  // Normalize whitespace
  const normalized = rawText.replace(/\r\n/g, '\n').trim();

  // Apply truncation
  const limit = maxChars ?? 50_000;
  const truncated = normalized.length > limit;
  const content = truncated ? normalized.slice(0, limit) : normalized;

  return {
    document_type: documentType(ext),
    file_name: fileName,
    size_bytes: buffer.length,
    content,
    truncated,
    char_count: content.length,
    metadata: {
      title: ast.metadata.title || undefined,
      author: ast.metadata.author || undefined,
      pages: ast.metadata.pages || undefined,
    },
  };
}
