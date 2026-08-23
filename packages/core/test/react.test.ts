// @vitest-environment jsdom

/**
 * @file Proves the optional React binding consumes generic LiveState without
 * owning domain state or requiring an RxJS-facing component contract.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useLiveState } from '../src/react.js';
import { createLiveState, type LiveState } from '../src/stream/index.js';
import { ManualScheduler } from './temporal-fixtures.js';

/** Immutable state rendered by the representative framework consumer. */
type FixtureState = Readonly<{
  /** Current task status shown by the view. */
  status: 'queued' | 'running';
}>;

describe('useLiveState', () => {
  it('renders the current snapshot and reacts through the standard store bridge', async () => {
    /** Controls Archer listener delivery while React controls render scheduling. */
    const scheduler = new ManualScheduler();

    /** Owns state outside React so the hook remains a pure binding. */
    const state = createLiveState<FixtureState>({ status: 'queued' }, { schedule: scheduler.schedule });

    /**
     * Renders only the generic state returned by the optional binding.
     * @returns Current status text from the external store.
     */
    function Fixture(): string {
      return useLiveState(state).status;
    }

    /** Mounts the representative consumer through React's supported DOM renderer. */
    render(createElement(Fixture));
    expect(screen.getByText('queued')).toBeTruthy();

    await act(async () => {
      state.publish({ status: 'running' });
      scheduler.flushAll();
    });
    expect(screen.getByText('running')).toBeTruthy();

    await act(async () => {
      cleanup();
    });
    await state.close();
  });

  it('closes the subscribe setup race and detaches on unmount', async () => {
    /** Changes during subscribe so React must read again after attachment. */
    let snapshot: FixtureState = Object.freeze({ status: 'queued' });

    /** Proves the framework owns only observation detachment. */
    const unsubscribe = vi.fn();

    /** Supplies the minimal generic contract without an Archer runtime class. */
    const state: LiveState<FixtureState> = {
      /**
       * Reads whichever immutable snapshot is current.
       * @returns Current fixture state.
       */
      getSnapshot: () => snapshot,
      /**
       * Advances state during setup before returning the retained detacher.
       * @returns The observable detachment spy.
       */
      subscribe: () => {
        snapshot = Object.freeze({ status: 'running' });
        return unsubscribe;
      },
    };

    /**
     * Renders current status through the same generic hook.
     * @returns Current fixture status text.
     */
    function Fixture(): string {
      return useLiveState(state).status;
    }

    /** Retains the supported DOM unmount operation for lifecycle proof. */
    const rendered = render(createElement(Fixture));
    expect(screen.getByText('running')).toBeTruthy();

    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])('preserves an explicit nullish server snapshot %s', (serverSnapshot) => {
    /** Supplies different client state so an accidental fallback remains visible. */
    const state: LiveState<string | null | undefined> = {
      /**
       * Returns client-only state during the server render probe.
       * @returns A value distinguishable from either nullish server snapshot.
       */
      getSnapshot: () => 'client',
      /**
       * Returns an inert detacher because server rendering never subscribes.
       * @returns A no-op unsubscribe callback.
       */
      subscribe: () => () => undefined,
    };

    /**
     * Renders the exact server snapshot selected by the caller.
     * @returns A stable marker for each nullish value.
     */
    function Fixture(): string {
      return useLiveState(state, () => serverSnapshot) === null ? 'null' : 'undefined';
    }

    expect(renderToString(createElement(Fixture))).toContain(serverSnapshot === null ? 'null' : 'undefined');
  });
});
