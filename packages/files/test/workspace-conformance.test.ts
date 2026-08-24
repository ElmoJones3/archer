/** @file Proves the public Workspace suite executes every claim against the memory reference. */

import { describe, expect, it } from 'vitest';

import { TimestampSchema, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
} from '@archer/core/authority';

import { memoryFileStore, publishTree } from '../src/index.js';
import {
  CHANGE_SET_CREATE_ACTION,
  WORKSPACE_CONFORMANCE_CASES,
  WORKSPACE_INGESTION_ACCEPT_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_WRITE_ACTION,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  createMemoryWorkspace,
  runWorkspaceConformance,
  type WorkspaceAction,
  type WorkspaceConformanceFixture,
  type WorkspaceReadAction,
  type WorkspaceWriteAction,
} from '../src/workspace/index.js';

/**
 * Creates deterministic UUIDv4 identities independently for each fresh fixture.
 * @param fixture - One-based case construction sequence.
 * @param identity - One-based identity inside that fixture.
 * @returns Stable UUIDv4-shaped text with no randomness or shared counter.
 */
function fixtureId(fixture: number, identity: number): string {
  return `62000000-0000-4000-8000-${String(fixture * 100 + identity).padStart(12, '0')}`;
}

describe('Workspace conformance', () => {
  it('executes every required case against independent memory Workspace attachments', async () => {
    /** Counts target construction so every case receives disjoint identity and state. */
    let fixtureSequence = 0;
    /** Public runner owns case commands while this target supplies only production wiring. */
    const report = await runWorkspaceConformance({
      name: '@archer/files memory Workspace',
      /**
       * Opens the empty generation-zero attachment required by the public suite.
       * @returns Fresh handle, current grants, and borrowed-dependency cleanup.
       */
      async open(): Promise<WorkspaceConformanceFixture> {
        fixtureSequence += 1;
        /**
         * Binds every identity to this exact fresh attachment.
         * @param identity - One-based identity within the current fixture.
         * @returns Deterministic UUIDv4 text unique across the suite run.
         */
        const id = (identity: number): string => fixtureId(fixtureSequence, identity);
        /** Empty canonical tree satisfies the suite's declared starting condition. */
        const store = memoryFileStore();
        /** Empty publication uses the real immutable tree path. */
        const base = await publishTree(store, []);
        if (!base.ok) throw base.error;
        /** Stable attachment identity scopes every grant and current decision. */
        const ledgerId = AuthorityLedgerIdSchema.parse(id(1));
        /** Stable subject is attributed to every suite command. */
        const subject = PrincipalIdSchema.parse(id(2));
        /** Stable private owner is independent from its empty content identity. */
        const workspaceId = WorkspaceIdSchema.parse(id(3));
        /** Stable lineage prevents cross-case snapshot substitution. */
        const lineageId = WorkspaceLineageIdSchema.parse(id(4));
        /** Trusted fact time is fixed before the verification clock. */
        const createdAt = TimestampSchema.parse('2026-08-24T01:00:00.000Z');
        /** Whole-copy read root still requires current verification per method. */
        const readRoot = createBootstrapAuthorizationGrant<WorkspaceReadAction>(WORKSPACE_READ_ACTION, {
          id: AuthorizationGrantIdSchema.parse(id(5)),
          ledgerId,
          subject,
          scope: { kind: 'workspace-read', workspaceId },
          issuedBy: subject,
          createdAt,
        });
        /** Whole-copy write root still requires current verification per command. */
        const writeRoot = createBootstrapAuthorizationGrant<WorkspaceWriteAction>(WORKSPACE_WRITE_ACTION, {
          id: AuthorizationGrantIdSchema.parse(id(6)),
          ledgerId,
          subject,
          scope: { kind: 'workspace-write', workspaceId },
          issuedBy: subject,
          createdAt,
        });
        /** Real broker exercises lookup, subject, action, scope, time, and current state. */
        const authority = createMemoryAuthorityLedger<WorkspaceAction>({
          ledgerId,
          actions: [
            WORKSPACE_READ_ACTION,
            WORKSPACE_WRITE_ACTION,
            WORKSPACE_INGESTION_ACCEPT_ACTION,
            CHANGE_SET_CREATE_ACTION,
          ],
          bootstrap: [readRoot, writeRoot],
          /**
           * Keeps both roots current deterministically.
           * @returns Fixed trusted verification instant.
           */
          now: () => new Date('2026-08-24T01:01:00.000Z'),
        });
        /** Runtime identity counter covers state source and transferable snapshots. */
        let runtimeIdentity = 20;
        /**
         * Supplies deterministic identities local to this fixture.
         * @returns Next valid UUIDv4 text.
         */
        const createId = (): string => id(runtimeIdentity++);
        /** Public constructor verifies the empty base before exposing the candidate handle. */
        const opened = await createMemoryWorkspace({
          workspaceId,
          lineageId,
          base: base.value.ref,
          subject,
          store: borrowed(store),
          authority: borrowed(authority),
          createId,
          /**
           * Keeps snapshots and close evidence deterministic.
           * @returns Fixed trusted Workspace instant.
           */
          now: () => new Date('2026-08-24T01:02:00.000Z'),
        });
        if (!opened.ok) throw opened.error;
        return Object.freeze({
          workspace: opened.value,
          readGrant: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
          writeGrant: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
          /** Releases only dependencies deliberately borrowed by the candidate handle. */
          async dispose() {
            await authority.close();
            await store.close();
          },
        });
      },
    });

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({ required: WORKSPACE_CONFORMANCE_CASES.length, executed: 5, skipped: 0 });
    expect(report.cases).toHaveLength(WORKSPACE_CONFORMANCE_CASES.length);
    expect(report.cases.every((item) => item.status === 'passed')).toBe(true);
  });
});
