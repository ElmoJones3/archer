/**
 * @file Proves Program decisions preserve pure state transitions, exact effect
 * order, and caller-owned input state.
 */

import { describe, expect, it } from 'vitest';

import { programDecision, type EffectIntent, type Program } from '../src/index.js';

/** State used to make nested input mutation visible. */
type CounterState = Readonly<{
  /** Current counter value. */
  count: number;

  /** Prior values retained as immutable transition history. */
  history: readonly number[];
}>;

/** Accepted event for the representative pure Program. */
type CounterEvent = Readonly<{
  /** Amount added by this explicit event. */
  amount: number;
}>;

/** Payload recorded when the counter reaches its reporting threshold. */
type CounterEffectPayload = Readonly<{
  /** Counter value that crossed the reporting threshold. */
  count: number;
}>;

/** Effect produced only when the counter reaches its reporting threshold. */
type CounterEffect = EffectIntent<'report-threshold', CounterEffectPayload>;

/** A production-shaped Program that derives fresh state and deterministic effects. */
const counterProgram: Program<CounterState, CounterEvent, CounterEffect> = {
  /**
   * Computes the next value without reading ambient state or mutating history.
   * @param state - Previously acknowledged counter state.
   * @param event - Explicit increment accepted by the caller.
   * @returns Fresh state and the effect forced by the threshold, if any.
   */
  reduce(state, event) {
    /** The exact next count shared by state and any resulting effect. */
    const count = state.count + event.amount;
    return programDecision(
      { count, history: [...state.history, count] },
      count >= 3 ? [{ kind: 'report-threshold', payload: { count } }] : [],
    );
  },
};

describe('Program', () => {
  it('returns exact fresh state and effects without mutating acknowledged input', () => {
    /** Represents state that a Cell could have acknowledged before reduction. */
    const initial: CounterState = { count: 1, history: [1] };

    /** Captures the one pure decision under test. */
    const decision = counterProgram.reduce(initial, { amount: 2 });

    expect(decision).toEqual({
      state: { count: 3, history: [1, 3] },
      effects: [{ kind: 'report-threshold', payload: { count: 3 } }],
    });
    expect(initial).toEqual({ count: 1, history: [1] });
    expect(decision.state).not.toBe(initial);
  });

  it('copies and freezes effect order without claiming ownership of generic state', () => {
    /** Remains mutable to prove the decision owns a separate effect list. */
    const effects: CounterEffect[] = [{ kind: 'report-threshold', payload: { count: 3 } }];

    /** Uses a recognizable state object to prove it passes through by identity. */
    const state: CounterState = { count: 3, history: [1, 3] };

    /** Holds the immutable decision envelope created from caller-owned inputs. */
    const decision = programDecision(state, effects);
    effects.push({ kind: 'report-threshold', payload: { count: 4 } });

    expect(decision.state).toBe(state);
    expect(decision.effects).toEqual([{ kind: 'report-threshold', payload: { count: 3 } }]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.effects)).toBe(true);
  });
});
