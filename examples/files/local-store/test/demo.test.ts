/** @file Proves the runnable local-store example over a real isolated filesystem. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { localStoreDemo } from '../src/demo.js';

describe('local store example', () => {
  it('proves persistence, verified reading, missing content, and cleanup', async () => {
    /** Exact test-owned root isolates the real filesystem dependency. */
    const root = await mkdtemp(join(tmpdir(), 'archer-files-example-test-'));
    try {
      expect(await localStoreDemo(root)).toEqual({
        persisted: true,
        content: 'survives close',
        missingCode: 'files_content_missing',
        closed: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
