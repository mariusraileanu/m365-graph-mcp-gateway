/**
 * KQL (Keyword Query Language) filter expression builder for Copilot Retrieval API.
 *
 * The Retrieval API's filterExpression accepts KQL syntax. If the expression is
 * invalid, the API silently ignores it and returns unscoped results — so we
 * validate field names and produce well-formed expressions client-side.
 *
 * Supported KQL fields (Retrieval API):
 *   Author, FileExtension, Filename, FileType, InformationProtectionLabelId,
 *   LastModifiedTime, ModifiedBy, Path, SiteID, Title
 */

/** Fields the Copilot Retrieval API filterExpression accepts. */
const SUPPORTED_FIELDS = new Set([
  'Author',
  'FileExtension',
  'Filename',
  'FileType',
  'InformationProtectionLabelId',
  'LastModifiedTime',
  'ModifiedBy',
  'Path',
  'SiteID',
  'Title',
]);

export interface KqlClause {
  field: string;
  /** Operator — defaults to ':' (contains). Use '=' for exact, '>','<','>=','<=' for dates. */
  operator?: ':' | '=' | '>' | '<' | '>=' | '<=';
  value: string;
}

export interface KqlBuildOptions {
  clauses: KqlClause[];
  /** Join multiple clauses with AND (default) or OR. */
  join?: 'AND' | 'OR';
}

/** Escape a value for use in a KQL expression. Wraps in double quotes if needed. */
function quoteKqlValue(value: string): string {
  // If value contains spaces, quotes, or special KQL chars, wrap in double quotes with escaping
  if (/[\s"():]/g.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Validate a single KQL field name against the supported set.
 * Returns the canonical casing if valid, null otherwise.
 */
export function validateKqlField(field: string): string | null {
  // Case-insensitive lookup, return canonical casing
  for (const supported of SUPPORTED_FIELDS) {
    if (supported.toLowerCase() === field.toLowerCase()) {
      return supported;
    }
  }
  return null;
}

/**
 * Build a KQL filter expression from structured options.
 *
 * @throws Error with INVALID_KQL_FIELD if any field is unsupported
 * @returns The KQL expression string, or empty string if no clauses provided
 */
export function buildKqlFilter(options: KqlBuildOptions): string {
  if (!options.clauses.length) return '';

  const join = options.join ?? 'AND';
  const parts: string[] = [];

  for (const clause of options.clauses) {
    const canonical = validateKqlField(clause.field);
    if (!canonical) {
      throw new Error(`INVALID_KQL_FIELD: '${clause.field}' is not supported. ` + `Supported fields: ${[...SUPPORTED_FIELDS].join(', ')}`);
    }

    const op = clause.operator ?? ':';
    const quoted = quoteKqlValue(clause.value);
    parts.push(`${canonical}${op}${quoted}`);
  }

  return parts.join(` ${join} `);
}

/**
 * Validate a raw KQL expression string — light sanity check.
 * Returns true if the expression looks structurally valid.
 */
export function isValidKqlExpression(expr: string): boolean {
  if (!expr.trim()) return false;
  // Check for balanced quotes
  const quoteCount = (expr.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) return false;
  // Check for balanced parentheses
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Return the list of supported KQL fields (for tool descriptions / error messages). */
export function supportedKqlFields(): string[] {
  return [...SUPPORTED_FIELDS];
}
