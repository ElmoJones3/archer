/**
 * @file Demonstrates deterministic immutable publication and Merkle sharing
 * through only the public, product-neutral `@archer/files` entry point.
 */

import { memoryFileStore, publishTree, type FileStore, type ImmutableTree, type TreeRef } from '@archer/files';

/** Portable result printed by the runnable immutable-tree example. */
export type ImmutableTreeDemoResult = Readonly<{
  /** Confirms equivalent caller order produced one root identity. */
  orderIndependent: boolean;

  /** Confirms an unrelated subtree retained identity after one source edit. */
  docsShared: boolean;

  /** Names the stable failure raised before invalid logical input is published. */
  invalidPathCode: string;

  /** Confirms explicit retained-store cleanup completed. */
  closed: boolean;
}>;

/** Minimal Result shape consumed without importing a later layer or hidden helper. */
type ExampleResult<Value> =
  | Readonly<{
      /** Selects the successful branch. */
      ok: true;

      /** Carries the exact successful public value. */
      value: Value;
    }>
  | Readonly<{
      /** Selects the failed branch. */
      ok: false;

      /** Preserves the exact public Error instance. */
      error: Error;
    }>;

/**
 * Requires one successful file Result without turning failure into a sentinel.
 * @param result - Public file operation outcome.
 * @returns Exact successful value.
 */
function expectOk<Value>(result: ExampleResult<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Reads one direct directory reference from a canonical root.
 * @param store - Store retaining the root's canonical bytes.
 * @param tree - Published tree whose direct child is selected.
 * @param name - Stable direct directory name used by the sharing proof.
 * @returns Exact child reference embedded by the root.
 */
async function childTree(store: FileStore, tree: ImmutableTree, name: string): Promise<TreeRef> {
  /** Loads through the public verified TreeStore boundary. */
  const root = expectOk(await store.trees.get(tree.ref));
  /** Selects the recognizable directory without depending on array position. */
  const child = root.entries.find((entry) => entry.kind === 'directory' && entry.name === name);
  if (child?.kind !== 'directory') throw new Error(`Missing child tree: ${name}`);
  return child.tree;
}

/**
 * Runs one deterministic in-memory immutable-tree demonstration.
 * @returns Identity, failure, structural-sharing, and cleanup evidence.
 */
export async function immutableTreeDemo(): Promise<ImmutableTreeDemoResult> {
  /** Memory is a retained storage choice, not part of immutable tree identity. */
  const store = memoryFileStore();
  /** Publishes one logical hierarchy from deliberately reversed flat input. */
  const first = expectOk(
    await publishTree(store, [
      { path: 'src/index.ts', content: 'before' },
      { path: 'docs/readme.md', content: 'stable' },
    ]),
  );
  /** Reorders equivalent input to prove caller arrays do not determine identity. */
  const reordered = expectOk(
    await publishTree(store, [
      { path: 'docs/readme.md', content: 'stable' },
      { path: 'src/index.ts', content: 'before' },
    ]),
  );
  /** Changes only one branch so unchanged-directory identity can be observed. */
  const changed = expectOk(
    await publishTree(store, [
      { path: 'docs/readme.md', content: 'stable' },
      { path: 'src/index.ts', content: 'after' },
    ]),
  );
  /** Invalid root control paths fail before bytes enter the store. */
  const invalid = await publishTree(store, [{ path: '.archer/state.json', content: 'forbidden' }]);
  /** Captures both child identities through ordinary verified reads. */
  const [beforeDocs, afterDocs] = await Promise.all([
    childTree(store, first, 'docs'),
    childTree(store, changed, 'docs'),
  ]);
  /** Releases process-local retained bytes after all evidence has been derived. */
  const close = await store.close();
  return Object.freeze({
    orderIndependent: reordered.ref.digest === first.ref.digest,
    docsShared: beforeDocs.digest === afterDocs.digest,
    invalidPathCode: invalid.ok ? 'unexpected-success' : invalid.error.code,
    closed: close.kind === 'closed',
  });
}
