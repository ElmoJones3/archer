/** @file Proves the public directory suite executes every claim against the reference adapter. */

import { describe, expect, it } from 'vitest';

import {
  DIRECTORY_MATERIALIZER_CONFORMANCE_CASES,
  runDirectoryMaterializerConformance,
} from '../src/materializer/index.js';
import { disposeDirectoryFixture, openDirectoryFixture } from './support/directory-fixture.js';

describe('directory Materializer conformance', () => {
  it('executes every required case against independent local-directory attachments', async () => {
    /** Public runner owns commands and claims; target supplies one exact production fixture per case. */
    const report = await runDirectoryMaterializerConformance({
      name: '@archer/files directory Materializer',
      /**
       * Opens the exact logical roots, absent physical target, and current grants required by the suite.
       * @returns Fresh candidate attachment with cleanup limited to its unique temporary parent.
       */
      async open() {
        /** Shared support prevents first-party behavior tests and conformance from drifting apart. */
        const fixture = await openDirectoryFixture();
        return Object.freeze({
          materializer: fixture.materializer,
          store: fixture.store,
          input: fixture.input,
          materializeGrant: fixture.materialize,
          ingestGrant: fixture.ingest,
          /** Releases only dependencies deliberately borrowed by the Materializer. */
          async dispose() {
            await disposeDirectoryFixture(fixture);
          },
        });
      },
    });

    expect(report.cases).toEqual(
      DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.map((definition) => ({ id: definition.id, status: 'passed' })),
    );
    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({
      required: DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.length,
      executed: 5,
      skipped: 0,
    });
    expect(report.cases).toHaveLength(DIRECTORY_MATERIALIZER_CONFORMANCE_CASES.length);
  });
});
