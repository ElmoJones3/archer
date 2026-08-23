/** @file Proves the public file-store conformance runner against both first-party stores. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { memoryFileStore } from '../src/index.js';
import { runFileStoreConformance } from '../src/conformance.js';
import { fileTreeStore } from '../src/fs/index.js';

describe('file-store conformance', () => {
  it('executes every required case against the in-memory store', async () => {
    /** Factory supplies an independent retained attachment to each conformance case. */
    const report = await runFileStoreConformance({
      name: 'memory',
      /**
       * Opens the root package's process-local implementation.
       * @returns Successful independent memory attachment.
       */
      async open() {
        return { ok: true, value: memoryFileStore() };
      },
    });

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({ required: 5, executed: 5, skipped: 0 });
    expect(report.cases).toHaveLength(5);
  });

  it('executes every required case against the real filesystem store', async () => {
    /** Exact test-owned root contains all durable objects created by the suite. */
    const root = await mkdtemp(join(tmpdir(), 'archer-files-conformance-'));
    try {
      /** Each case opens an independent attachment over the same durable store. */
      const report = await runFileStoreConformance({
        name: 'filesystem',
        /**
         * Opens through the real adapter construction boundary.
         * @returns Filesystem attachment or stable construction failure.
         */
        open: () => fileTreeStore({ root }),
      });

      expect(report.status).toBe('passed');
      expect(report.execution).toEqual({ required: 5, executed: 5, skipped: 0 });
      expect(report.cases.every((result) => result.status === 'passed')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
