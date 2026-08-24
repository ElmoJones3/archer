/** @file Proves a named local snapshot remains readable after its source changes. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listSnapshot, readSnapshotFile, saveSnapshot } from '../src/cache.js';

describe('local snapshot cache application', () => {
  it('reopens a named snapshot independently of the mutable source directory', async () => {
    /** One temporary parent owns both the mutable source and durable cache. */
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'archer-local-snapshot-cache-'));
    /** The application scans this directory through its normal save path. */
    const source = join(temporaryRoot, 'project');
    /** A separate directory retains content-addressed objects and named references. */
    const cache = join(temporaryRoot, 'cache');
    try {
      await mkdir(join(source, 'docs'), { recursive: true });
      await writeFile(join(source, 'README.md'), '# Project\n');
      await writeFile(join(source, 'docs', 'guide.md'), 'original guide\n');

      /** Saving establishes the immutable snapshot through the public filesystem store. */
      const saved = await saveSnapshot({ cacheRoot: cache, name: 'before-edit', sourceDirectory: source });
      expect(saved.name).toBe('before-edit');
      expect(saved.files).toEqual(['README.md', 'docs/guide.md']);

      await writeFile(join(source, 'docs', 'guide.md'), 'changed source\n');
      /** Create-only aliasing must refuse a different tree without moving the original name. */
      await expect(
        saveSnapshot({ cacheRoot: cache, name: 'before-edit', sourceDirectory: source }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      /** Independent calls reopen the store and named reference after the source diverges. */
      expect(await listSnapshot({ cacheRoot: cache, name: 'before-edit' })).toEqual(['README.md', 'docs/guide.md']);
      expect(
        new TextDecoder().decode(
          await readSnapshotFile({
            cacheRoot: cache,
            name: 'before-edit',
            path: 'docs/guide.md',
          }),
        ),
      ).toBe('original guide\n');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
