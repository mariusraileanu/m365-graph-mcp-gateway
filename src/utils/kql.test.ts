import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKqlFilter, validateKqlField, isValidKqlExpression, supportedKqlFields } from '../utils/kql.js';

describe('kql', () => {
  describe('validateKqlField', () => {
    it('returns canonical casing for supported fields', () => {
      assert.equal(validateKqlField('author'), 'Author');
      assert.equal(validateKqlField('FILEEXTENSION'), 'FileExtension');
      assert.equal(validateKqlField('Path'), 'Path');
      assert.equal(validateKqlField('siteID'), 'SiteID');
    });

    it('returns null for unsupported fields', () => {
      assert.equal(validateKqlField('bogus'), null);
      assert.equal(validateKqlField('Content'), null);
      assert.equal(validateKqlField(''), null);
    });
  });

  describe('buildKqlFilter', () => {
    it('returns empty string for no clauses', () => {
      assert.equal(buildKqlFilter({ clauses: [] }), '');
    });

    it('builds a single clause with default contains operator', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'Author', value: 'alice' }] });
      assert.equal(result, 'Author:alice');
    });

    it('builds a single clause with equals operator', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'FileExtension', operator: '=', value: 'docx' }] });
      assert.equal(result, 'FileExtension=docx');
    });

    it('builds multiple clauses with AND join', () => {
      const result = buildKqlFilter({
        clauses: [
          { field: 'Author', value: 'alice' },
          { field: 'FileExtension', operator: '=', value: 'pdf' },
        ],
        join: 'AND',
      });
      assert.equal(result, 'Author:alice AND FileExtension=pdf');
    });

    it('builds multiple clauses with OR join', () => {
      const result = buildKqlFilter({
        clauses: [
          { field: 'Title', value: 'report' },
          { field: 'Title', value: 'summary' },
        ],
        join: 'OR',
      });
      assert.equal(result, 'Title:report OR Title:summary');
    });

    it('quotes values with spaces', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'Author', value: 'John Doe' }] });
      assert.equal(result, 'Author:"John Doe"');
    });

    it('escapes double quotes in values', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'Title', value: 'The "Big" Report' }] });
      assert.equal(result, 'Title:"The \\"Big\\" Report"');
    });

    it('handles date comparison operators', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'LastModifiedTime', operator: '>', value: '2024-01-01' }] });
      assert.equal(result, 'LastModifiedTime>2024-01-01');
    });

    it('normalizes field casing to canonical form', () => {
      const result = buildKqlFilter({ clauses: [{ field: 'filename', value: 'test.docx' }] });
      assert.equal(result, 'Filename:test.docx');
    });

    it('throws on invalid field names', () => {
      assert.throws(
        () => buildKqlFilter({ clauses: [{ field: 'InvalidField', value: 'test' }] }),
        (err: Error) => err.message.includes('INVALID_KQL_FIELD'),
      );
    });

    it('defaults to AND join when not specified', () => {
      const result = buildKqlFilter({
        clauses: [
          { field: 'Author', value: 'alice' },
          { field: 'Path', value: '/sites/team' },
        ],
      });
      assert.equal(result, 'Author:alice AND Path:/sites/team');
    });
  });

  describe('isValidKqlExpression', () => {
    it('returns true for valid expressions', () => {
      assert.equal(isValidKqlExpression('Author:alice'), true);
      assert.equal(isValidKqlExpression('Author:"John Doe" AND Path:/sites'), true);
      assert.equal(isValidKqlExpression('(Author:alice OR Author:bob) AND FileExtension=pdf'), true);
    });

    it('returns false for empty string', () => {
      assert.equal(isValidKqlExpression(''), false);
      assert.equal(isValidKqlExpression('   '), false);
    });

    it('returns false for unbalanced quotes', () => {
      assert.equal(isValidKqlExpression('Author:"unclosed'), false);
    });

    it('returns false for unbalanced parentheses', () => {
      assert.equal(isValidKqlExpression('(Author:alice'), false);
      assert.equal(isValidKqlExpression('Author:alice)'), false);
    });
  });

  describe('supportedKqlFields', () => {
    it('returns an array of field names', () => {
      const fields = supportedKqlFields();
      assert.ok(Array.isArray(fields));
      assert.ok(fields.length > 0);
      assert.ok(fields.includes('Author'));
      assert.ok(fields.includes('FileExtension'));
      assert.ok(fields.includes('Path'));
      assert.ok(fields.includes('SiteID'));
    });
  });
});
