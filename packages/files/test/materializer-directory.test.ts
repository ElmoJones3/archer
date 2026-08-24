/**
 * @file Proves the directory Materializer through its public package surface.
 *
 * The reference deliberately claims cooperative quiescence only. Later sandbox
 * adapters must supply their own stronger proof type rather than inheriting a
 * guarantee from these local filesystem tests.
 */

import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IdempotencyKeySchema, TimestampSchema } from '@archer/core';
import { AuthorizationGrantIdSchema } from '@archer/core/authority';

import * as files from '../src/index.js';
import { restoreTree } from '../src/index.js';
import { closeDirectoryFixture, materializeFixture, openDirectoryFixture } from './support/directory-fixture.js';

describe('directory Materializer', () => {
  it('publishes an explicit directory adapter constructor', () => {
    /** Namespace lookup keeps the first TDD proof executable before declarations exist. */
    const createDirectoryMaterializer = (files as Readonly<Record<string, unknown>>).createDirectoryMaterializer;

    expect(createDirectoryMaterializer).toBeTypeOf('function');
  });

  it('humanizes logical ownership as ordinary separate filesystem roots', async () => {
    /** Physical paths are the integration: existing tools need no Archer filesystem API. */
    const fixture = await openDirectoryFixture();
    try {
      /** First start allocates and immediately activates one hot physical attempt. */
      const started = await fixture.materializer.startMaterialization(fixture.input, fixture.materialize);
      expect(started).toMatchObject({ kind: 'started', replayed: false });
      if (started.kind !== 'started') throw new Error('Expected a started materialization');
      /** Exact retry must return the same live operation rather than duplicate I/O. */
      const replay = await fixture.materializer.startMaterialization(fixture.input, fixture.materialize);
      expect(replay).toMatchObject({ kind: 'started', replayed: true });
      if (replay.kind !== 'started') throw new Error('Expected a replayed materialization');
      expect(replay.operation).toBe(started.operation);
      /** Terminal settlement makes all three ordinary roots safe to inspect. */
      const result = await started.operation.result;
      expect(result.kind).toBe('materialized');
      if (result.kind !== 'materialized') throw new Error('Expected a completed physical view');

      expect(await readFile(join(result.view.paths.workspace, 'README.md'), 'utf8')).toBe('workspace\n');
      expect(await readFile(join(result.view.paths.resources, 'docs', 'guide.txt'), 'utf8')).toBe('reference\n');
      expect(await readFile(join(result.view.paths.scratchpads, 'session', 'notes.txt'), 'utf8')).toBe('scratch\n');
      expect(result.view).toMatchObject({ type: 'directory', generation: 7, mappingVersion: 1 });
      await started.operation.close();
    } finally {
      await closeDirectoryFixture(fixture);
    }
  });

  it('ingests only the cooperatively quiesced Workspace root into a verified receipt', async () => {
    /** Ordinary host mutations model an existing AI SDK tool or editor, not Archer-specific code. */
    const fixture = await openDirectoryFixture();
    try {
      /** Completed view exposes ordinary paths to the non-Archer mutation code below. */
      const view = await materializeFixture(fixture);
      await writeFile(join(view.paths.workspace, 'README.md'), 'changed\n');
      await writeFile(join(view.paths.workspace, 'generated.txt'), 'generated\n');
      await rename(join(view.paths.workspace, 'generated.txt'), join(view.paths.workspace, 'answer.txt'));
      await writeFile(join(view.paths.scratchpads, 'session', 'notes.txt'), 'must stay private\n');

      /** Cooperative evidence says only that this application stopped its own writers. */
      const command = {
        quiescence: {
          type: 'cooperative-directory' as const,
          materializedViewId: view.materializedViewId,
          generation: view.generation,
          acknowledgedBy: 'materializer integration test',
          acknowledgedAt: TimestampSchema.parse('2026-08-23T22:31:00.000Z'),
        },
        expectedBase: view.base,
        expectedGeneration: view.generation,
        idempotencyKey: IdempotencyKeySchema.parse('20000000-0000-4000-8000-000000000008'),
      };
      /** First ingestion begins an immediate verified scan of Workspace alone. */
      const started = await view.startIngestion(command, fixture.ingest);
      expect(started).toMatchObject({ kind: 'started', replayed: false });
      if (started.kind !== 'started') throw new Error('Expected an ingestion operation');
      /** Exact retry reuses the same hot scan and eventual receipt identity. */
      const replay = await view.startIngestion(command, fixture.ingest);
      expect(replay).toMatchObject({ kind: 'started', replayed: true });
      if (replay.kind !== 'started') throw new Error('Expected an ingestion replay');
      expect(replay.operation).toBe(started.operation);
      /** Terminal scan result is the only source of complete ingestion evidence. */
      const result = await started.operation.result;
      expect(result).toMatchObject({
        kind: 'ingested',
        replayed: false,
        receipt: {
          object: 'ingestion-receipt',
          status: 'complete',
          materializedViewId: view.materializedViewId,
          generation: 7,
          excludedRoots: ['resources', 'scratchpads'],
          fileCount: 2,
        },
      });
      if (result.kind !== 'ingested') throw new Error('Expected a complete ingestion receipt');
      /** Restoration proves receipt identity names exactly the eligible Workspace content. */
      const restored = await restoreTree(fixture.store, result.receipt.result);
      if (!restored.ok) throw restored.error;
      expect(restored.value.files.map((entry) => entry.path)).toEqual(['README.md', 'answer.txt']);
      await started.operation.close();
      await view.close();
      await expect(readFile(view.paths.workspace, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeDirectoryFixture(fixture);
    }
  });

  it('rejects unsupported links instead of allowing physical escape into logical identity', async () => {
    /** A link remains unsupported even when its target stays inside the selected root. */
    const fixture = await openDirectoryFixture();
    try {
      /** Completed physical view is required before introducing an unsupported link. */
      const view = await materializeFixture(fixture);
      await symlink('../resources/docs/guide.txt', join(view.paths.workspace, 'linked.txt'));
      /** Ingestion operation must settle as expected refusal, not follow the link. */
      const started = await view.startIngestion(
        {
          quiescence: {
            type: 'cooperative-directory',
            materializedViewId: view.materializedViewId,
            generation: view.generation,
            acknowledgedBy: 'materializer integration test',
            acknowledgedAt: TimestampSchema.parse('2026-08-23T22:32:00.000Z'),
          },
          expectedBase: view.base,
          expectedGeneration: view.generation,
          idempotencyKey: IdempotencyKeySchema.parse('20000000-0000-4000-8000-000000000009'),
        },
        fixture.ingest,
      );
      if (started.kind !== 'started') throw new Error('Expected an ingestion operation');
      expect(await started.operation.result).toEqual({ kind: 'refused', reason: 'unsupported-entry' });
      await started.operation.close();
    } finally {
      await closeDirectoryFixture(fixture);
    }
  });

  it('returns target and Authority refusals without publishing a physical view', async () => {
    /** Existing target state belongs to the caller and must never be overwritten. */
    const fixture = await openDirectoryFixture();
    try {
      await mkdir(fixture.input.target.rootPath);
      /** Attempt may start, but target collision must prevent physical publication. */
      const started = await fixture.materializer.startMaterialization(fixture.input, fixture.materialize);
      if (started.kind !== 'started') throw new Error('Expected an operation that can inspect the target');
      expect(await started.operation.result).toEqual({ kind: 'refused', reason: 'target-exists' });
      await started.operation.close();

      /** A fresh command key reaches current Authority before any second physical attempt. */
      const unauthorized = await fixture.materializer.startMaterialization(
        {
          ...fixture.input,
          idempotencyKey: IdempotencyKeySchema.parse('20000000-0000-4000-8000-000000000010'),
        },
        {
          grantId: AuthorizationGrantIdSchema.parse('20000000-0000-4000-8000-000000000099'),
          action: 'files-materialize',
        },
      );
      expect(unauthorized).toMatchObject({ kind: 'authority-refused', refusal: { reason: 'grant-not-found' } });
    } finally {
      await closeDirectoryFixture(fixture);
    }
  });
});
