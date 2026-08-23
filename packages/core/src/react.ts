/**
 * @file Adapts generic Archer LiveState to React's standard external-store
 * contract without owning or reconstructing domain state.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { LiveState } from './stream/contracts.js';

/**
 * Reads and subscribes to any Archer current-state source through React.
 * @param source - Generic current-state contract owned outside React.
 * @param getServerSnapshot - Optional server-render snapshot reader.
 * @returns The source's current immutable snapshot.
 */
export function useLiveState<State>(source: LiveState<State>, getServerSnapshot?: () => State): State {
  /** Converts Archer's value callback into React's invalidation callback. */
  const subscribe = useCallback((notify: () => void) => source.subscribe(() => notify()), [source]);

  /** Preserves source identity semantics for React's snapshot comparison. */
  const getSnapshot = useCallback(() => source.getSnapshot(), [source]);

  /** Uses explicit server state verbatim, including legitimate nullish snapshots. */
  const getServer = useCallback(
    () => (getServerSnapshot === undefined ? source.getSnapshot() : getServerSnapshot()),
    [getServerSnapshot, source],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServer);
}
