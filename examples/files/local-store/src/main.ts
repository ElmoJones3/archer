/** @file Runs the local-store example in one safely disposable temporary root. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localStoreDemo } from './demo.js';

/** Exact mkdtemp result is the only directory this executable removes. */
const root = await mkdtemp(join(tmpdir(), 'archer-files-example-'));
try {
  /** Complete evidence is emitted once for deterministic script consumption. */
  const result = await localStoreDemo(root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
