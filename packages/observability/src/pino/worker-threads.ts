/**
 * @file Publishes the Node 26 worker transfer alias still referenced by Pino
 * 10.3.1's thread-stream declaration through the adapter's declaration graph.
 */

import type { Transferable } from 'node:worker_threads';

/**
 * WARNING: Reevaluate this augmentation whenever Pino, thread-stream, or
 * `@types/node` changes. Remove it once thread-stream stops referencing the
 * missing alias or Node restores that alias; retaining it after restoration can
 * produce a duplicate type declaration.
 */
declare module 'worker_threads' {
  /** Keeps thread-stream's public signature equivalent to Node 26's transfer list. */
  type TransferListItem = Transferable;
}
