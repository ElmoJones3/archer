/** @file Proves the public Scratchpad suite executes every claim against the memory reference. */

import { describe, expect, it } from 'vitest';

import { TimestampSchema, UuidV4Schema, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
} from '@archer/core/authority';

import { memoryFileStore } from '../src/index.js';
import {
  SCRATCHPAD_CHECKPOINT_ACTION,
  SCRATCHPAD_CONFORMANCE_CASES,
  SCRATCHPAD_READ_ACTION,
  SCRATCHPAD_WRITE_ACTION,
  ScratchpadIdSchema,
  createMemoryScratchpad,
  runScratchpadConformance,
  type MemoryScratchpadRetention,
  type ScratchpadAction,
  type ScratchpadCheckpointAction,
  type ScratchpadConformanceFixture,
  type ScratchpadReadAction,
  type ScratchpadWriteAction,
} from '../src/scratchpad/index.js';

/**
 * Creates deterministic UUIDv4 identities independently for every fresh fixture.
 * @param fixture - One-based case construction sequence.
 * @param identity - One-based identity inside that fixture.
 * @returns Stable UUIDv4-shaped text with no randomness or shared state.
 */
function fixtureId(fixture: number, identity: number): string {
  return `64000000-0000-4000-8000-${String(fixture * 100 + identity).padStart(12, '0')}`;
}

describe('Scratchpad conformance', () => {
  it('executes every required case against independent memory Scratchpad attachments', async () => {
    /** Counts target construction so every case receives disjoint identity and state. */
    let fixtureSequence = 0;
    /** Public runner owns retention, commands, and claims; target supplies production wiring. */
    const report = await runScratchpadConformance({
      name: '@archer/files memory Scratchpad',
      /**
       * Opens the empty generation-zero retention mode requested by the suite.
       * @param retention - Honest process-local retention selected by the executable case.
       * @returns Fresh handle, current grants, and borrowed-dependency cleanup.
       */
      async open(retention: MemoryScratchpadRetention): Promise<ScratchpadConformanceFixture> {
        fixtureSequence += 1;
        /**
         * Binds every identity to this exact fresh attachment.
         * @param identity - One-based identity within the current fixture.
         * @returns Deterministic UUIDv4 text unique across the suite run.
         */
        const id = (identity: number): string => fixtureId(fixtureSequence, identity);
        /** Content-addressed store receives only production-reachable empty and mutated trees. */
        const store = memoryFileStore();
        /** Stable attachment identity scopes every grant and current decision. */
        const ledgerId = AuthorityLedgerIdSchema.parse(id(1));
        /** Stable subject is attributed to every suite command. */
        const subject = PrincipalIdSchema.parse(id(2));
        /** Stable private owner is independent from its changing immutable tree. */
        const scratchpadId = ScratchpadIdSchema.parse(id(3));
        /** Ordinary external ownership avoids requiring a Task or Thread fixture. */
        const owner = Object.freeze({ type: 'external' as const, id: UuidV4Schema.parse(id(4)) });
        /** Trusted fact time is fixed before the verification clock. */
        const createdAt = TimestampSchema.parse('2026-08-24T02:00:00.000Z');
        /** Whole-owner read root still requires current verification per method. */
        const readRoot = createBootstrapAuthorizationGrant<ScratchpadReadAction>(SCRATCHPAD_READ_ACTION, {
          id: AuthorizationGrantIdSchema.parse(id(5)),
          ledgerId,
          subject,
          scope: { kind: 'scratchpad-read', scratchpadId },
          issuedBy: subject,
          createdAt,
        });
        /** Whole-owner write root still requires current verification per command. */
        const writeRoot = createBootstrapAuthorizationGrant<ScratchpadWriteAction>(SCRATCHPAD_WRITE_ACTION, {
          id: AuthorizationGrantIdSchema.parse(id(6)),
          ledgerId,
          subject,
          scope: { kind: 'scratchpad-write', scratchpadId },
          issuedBy: subject,
          createdAt,
        });
        /** Checkpoint permission stays independent from ordinary mutation authority. */
        const checkpointRoot = createBootstrapAuthorizationGrant<ScratchpadCheckpointAction>(
          SCRATCHPAD_CHECKPOINT_ACTION,
          {
            id: AuthorizationGrantIdSchema.parse(id(7)),
            ledgerId,
            subject,
            scope: { kind: 'scratchpad-checkpoint', scratchpadId },
            issuedBy: subject,
            createdAt,
          },
        );
        /** Real broker exercises lookup, subject, action, scope, time, and current state. */
        const authority = createMemoryAuthorityLedger<ScratchpadAction>({
          ledgerId,
          actions: [SCRATCHPAD_READ_ACTION, SCRATCHPAD_WRITE_ACTION, SCRATCHPAD_CHECKPOINT_ACTION],
          bootstrap: [readRoot, writeRoot, checkpointRoot],
          /**
           * Keeps every root current deterministically.
           * @returns Fixed trusted verification instant.
           */
          now: () => new Date('2026-08-24T02:01:00.000Z'),
        });
        /** Runtime identity counter covers composition, state sources, snapshots, and checkpoints. */
        let runtimeIdentity = 20;
        /**
         * Supplies deterministic identities local to this fixture.
         * @returns Next valid UUIDv4 text.
         */
        const createId = (): string => id(runtimeIdentity++);
        /** Public constructor earns an empty canonical base before exposing the candidate handle. */
        const opened = await createMemoryScratchpad({
          scratchpadId,
          owner,
          retention,
          subject,
          store: borrowed(store),
          authority: borrowed(authority),
          createId,
          /**
           * Keeps checkpoint and close evidence deterministic.
           * @returns Fixed trusted Scratchpad instant.
           */
          now: () => new Date('2026-08-24T02:02:00.000Z'),
        } as Parameters<typeof createMemoryScratchpad>[0]);
        if (!opened.ok) throw opened.error;
        return Object.freeze({
          scratchpad: opened.value,
          readGrant: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
          writeGrant: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
          checkpointGrant: Object.freeze({ grantId: checkpointRoot.id, action: checkpointRoot.action }),
          /** Releases only dependencies deliberately borrowed by the candidate handle. */
          async dispose() {
            await authority.close();
            await store.close();
          },
        });
      },
    });

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({ required: SCRATCHPAD_CONFORMANCE_CASES.length, executed: 5, skipped: 0 });
    expect(report.cases).toHaveLength(SCRATCHPAD_CONFORMANCE_CASES.length);
    expect(report.cases.every((item) => item.status === 'passed')).toBe(true);
  });
});
