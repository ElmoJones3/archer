/** @file Proves the reactive job writes an index from real Markdown files. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UuidV4Schema } from '@archer/core';
import { describe, expect, it } from 'vitest';

import { createDocumentationIndexRun } from '../src/indexer.js';

describe('documentation indexer application', () => {
  it('indexes Markdown headings while its public progress stream stays live', async () => {
    /** The complete filesystem workflow remains inside one test-owned directory. */
    const root = await mkdtemp(join(tmpdir(), 'archer-documentation-indexer-'));
    /** Real source hierarchy gives traversal and relative paths their production shape. */
    const sourceDirectory = join(root, 'docs');
    /** The output is separate from source discovery to avoid indexing itself. */
    const outputFile = join(root, 'output', 'search-index.json');
    try {
      await mkdir(join(sourceDirectory, 'guides'), { recursive: true });
      await writeFile(join(sourceDirectory, 'README.md'), '# Archer\n\n## Install\n');
      await writeFile(join(sourceDirectory, 'guides', 'files.md'), '# Files\n\n## Identity\n## Stores\n');
      await writeFile(join(sourceDirectory, 'ignored.txt'), 'not Markdown');

      /** Fixed identity controls only the job envelope, never application contents. */
      const run = createDocumentationIndexRun({
        sourceDirectory,
        outputFile,
        runId: UuidV4Schema.parse('60000000-0000-4000-8000-000000000001'),
      });
      /** This bounded subscriber observes the same public stream a CLI or UI would consume. */
      const subscription = run.updates.subscribe({ capacityItems: 32 });
      /** Collection starts before awaiting settlement so no live update is missed. */
      const updates = (async () => {
        /** Deliveries remain ordered by the public transient source. */
        const observed: unknown[] = [];
        /** Capacity exceeds the job's known output, so any gap is a contract failure. */
        for await (const delivery of subscription) {
          if (delivery.kind === 'gap') throw new Error(`Unexpected progress gap: ${delivery.lostItems}`);
          observed.push(delivery.value);
        }
        return observed;
      })();

      expect(await run.result).toMatchObject({ kind: 'completed' });
      await run.close();
      expect(await updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'step.progress', message: 'indexed README.md' }),
          expect.objectContaining({ kind: 'step.progress', message: 'indexed guides/files.md' }),
        ]),
      );

      /** The file is the application's useful result, not a diagnostic proof report. */
      const index = JSON.parse(await readFile(outputFile, 'utf8')) as unknown;
      expect(index).toEqual({
        documents: [
          { path: 'README.md', title: 'Archer', headings: ['Archer', 'Install'] },
          { path: 'guides/files.md', title: 'Files', headings: ['Files', 'Identity', 'Stores'] },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
