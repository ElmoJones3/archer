/**
 * @file Proves logical file identity is normalized and ordered independently of
 * host filesystem behavior or JavaScript's UTF-16 default sort.
 */

import { describe, expect, it } from 'vitest';

import { LogicalNameSchema, LogicalPathSchema, compareLogicalNames } from '../src/index.js';

describe('logical paths', () => {
  it('normalizes canonical Unicode while preserving relative path meaning', () => {
    expect(LogicalPathSchema.parse('src/e\u0301.ts')).toBe('src/é.ts');
    expect(LogicalPathSchema.parse('src/.archer/tool.ts')).toBe('src/.archer/tool.ts');
    expect(LogicalNameSchema.parse('e\u0301.ts')).toBe('é.ts');
  });

  it.each([
    '',
    '/absolute',
    'trailing/',
    'double//segment',
    './relative',
    '../escape',
    'src/../escape',
    'windows\\path',
    'nul\0path',
    '.archer',
    '.archer/state.json',
    'lone-\ud800-surrogate',
  ])('rejects the non-portable or reserved path %j', (path) => {
    expect(LogicalPathSchema.safeParse(path).success).toBe(false);
  });

  it('sorts normalized names by UTF-8 bytes rather than UTF-16 code units', () => {
    /** Uses one BMP private-use scalar and one supplementary scalar whose UTF-16 order differs. */
    const names = [LogicalNameSchema.parse('😀'), LogicalNameSchema.parse('\ue000')];
    expect(names.toSorted(compareLogicalNames)).toEqual(['\ue000', '😀']);
  });
});
