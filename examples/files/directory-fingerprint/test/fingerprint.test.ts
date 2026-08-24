/** @file Proves a real directory produces a stable content fingerprint. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintDirectory } from '../src/fingerprint.js';

describe('directory fingerprint application', () => {
  it('changes identity only when the logical files change', async () => {
    /** The test owns this complete source tree and removes it after the workflow. */
    const root = await mkdtemp(join(tmpdir(), 'archer-directory-fingerprint-'));
    try {
      await mkdir(join(root, 'docs'));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
      await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');

      /** The first two runs traverse the same production-created directory. */
      const first = await fingerprintDirectory(root);
      /** Repeating the complete workflow proves identity rather than process-local reuse. */
      const repeated = await fingerprintDirectory(root);

      expect(repeated.root).toEqual(first.root);
      expect(first.files.map((file) => file.path)).toEqual(['docs/guide.md', 'src/index.ts']);
      expect(first.totalBytes).toBe('34');

      await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 43;\n');
      /** The third run differs by one real file write through the normal input boundary. */
      const changed = await fingerprintDirectory(root);

      expect(changed.root.digest).not.toBe(first.root.digest);
      expect(changed.files[0]?.blob).toEqual(first.files[0]?.blob);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
