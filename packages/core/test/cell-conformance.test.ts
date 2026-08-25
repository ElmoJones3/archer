/** @file Executes the public CellHost conformance catalogue against embedded SQLite. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCellHostConformance, type CellHostConformanceTarget } from '../src/cells/conformance.js';
import { embeddedSqliteCells } from '../src/cells/embedded-sqlite/index.js';
import type { CellHost } from '../src/cells/index.js';
import { CELL_SUBJECT, cellHostOptions, createCellAuthorityFixture } from './support/cell-fixture.js';

/** Candidate target uses real SQLite workers, real Authority, and isolated files. */
const EMBEDDED_SQLITE_CONFORMANCE_TARGET: CellHostConformanceTarget = Object.freeze({
  name: '@archer/core embedded SQLite Cells',
  /**
   * Opens one fresh shared-storage topology for an independent required case.
   * @returns Real SQLite worker fixture and deterministic controls.
   */
  async open() {
    /** Mutable trusted clock moves only when the conformance suite requests expiry. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Trusted test clock reads the explicitly controlled instant.
     * @returns Current deterministic fixture instant.
     */
    const now = () => new Date(instant);
    /**
     * Inert timers ensure lease movement belongs only to explicit suite control.
     * @returns No-op cancellation capability.
     */
    const schedule = () => () => undefined;
    /** Real current-verification Authority fixture protects every host method. */
    const authority = createCellAuthorityFixture(now);
    /** Unique directory is owned by this one conformance case. */
    const directory = await mkdtemp(resolve(tmpdir(), 'archer-cell-conformance-'));
    /** Shared SQLite file lets restart and peer hosts observe one durable lineage. */
    const databasePath = resolve(directory, 'cells.sqlite');
    /** All opened hosts are retained for unconditional cleanup. */
    const hosts: CellHost[] = [];
    /** Owner suffix advances deterministically for every replacement host. */
    let owner = 0x30;
    /**
     * Opens one distinct process owner against the same SQLite file.
     * @returns Newly opened embedded SQLite host.
     */
    const openHost = async () => {
      /** Distinct UUIDv4 suffix becomes the host activation owner. */
      const suffix = (owner++).toString(16).padStart(2, '0');
      /** Real worker-backed host shares only this case's SQLite file. */
      const host = await embeddedSqliteCells({
        ...cellHostOptions(authority, now, schedule),
        databasePath,
        /**
         * Generates the deterministic owner captured for this host construction.
         * @returns Distinct valid UUIDv4 text.
         */
        createId: () => `10000000-0000-4000-8000-0000000000${suffix}`,
      });
      hosts.push(host);
      return host;
    };
    /** Initial candidate host used by the required case executor. */
    const host = await openHost();
    return Object.freeze({
      host,
      subject: CELL_SUBJECT,
      grants: authority.grants,
      /** Advances beyond the fixture's one-hundred-millisecond lease. */
      expireLease() {
        instant += 200;
      },
      openPeer: openHost,
      restart: openHost,
      /** Closes all possible peers before removing only this unique directory. */
      async dispose() {
        await Promise.all(
          hosts.map(
            /**
             * Releases one host while preserving the shared durable file until all settle.
             * @param candidate - Host opened during this isolated case.
             * @returns Retained host close settlement.
             */
            (candidate) => candidate.close(),
          ),
        );
        await authority.ledger.close();
        await rm(directory, { recursive: true, force: true });
      },
    });
  },
});

describe('CellHost conformance', () => {
  it('executes every required case against the embedded SQLite reference host', async () => {
    /** Complete report proves required/executed/skipped cardinality as well as status. */
    const report = await runCellHostConformance(EMBEDDED_SQLITE_CONFORMANCE_TARGET);

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({ required: 8, executed: 8, skipped: 0 });
    expect(report.cases).toHaveLength(8);
    expect(
      report.cases.every(
        /**
         * Requires each case result rather than trusting aggregate status alone.
         * @param result - One required conformance case result.
         * @returns Whether this exact case passed.
         */
        (result) => result.status === 'passed',
      ),
    ).toBe(true);
  });
});
