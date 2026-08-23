/**
 * @file Defines the pure decision contract that every durable Archer Cell runs.
 *
 * Programs own domain meaning only. Time, randomness, authority, diagnostics,
 * persistence, and adapter output must arrive as explicit events before a
 * Program may consider them.
 */

import type { JsonValue } from './values.js';

/** A durable request for external work that has not started yet. */
export type EffectIntent<Kind extends string = string, Payload extends JsonValue = JsonValue> = Readonly<{
  /** Selects the adapter behavior after a Cell acknowledges the decision. */
  kind: Kind;

  /** Carries replayable input rather than a process-local callback or resource. */
  payload: Payload;
}>;

/** The complete state and ordered effect intents owed by one accepted event. */
export type ProgramDecision<State, Effect> = Readonly<{
  /** The next canonical aggregate value proposed for atomic acknowledgement. */
  state: State;

  /** External work in deterministic activation order. */
  effects: readonly Effect[];
}>;

/** A deterministic domain decision unit with no I/O authority. */
export interface Program<State, Event, Effect> {
  /**
   * Interprets one accepted event against acknowledged state. Implementations
   * must return fresh changed data and must not mutate either argument.
   */
  reduce(state: Readonly<State>, event: Readonly<Event>): ProgramDecision<State, Effect>;
}

/**
 * Creates an immutable decision envelope and copies the effect list so later
 * caller mutation cannot change activation order.
 * @param state - The complete next state produced by a Program.
 * @param effects - Effect intents in the exact order they must be recorded.
 * @returns A frozen decision envelope with a frozen copy of the effects.
 */
export function programDecision<State, Effect>(
  state: State,
  effects: readonly Effect[] = [],
): ProgramDecision<State, Effect> {
  return Object.freeze({ state, effects: Object.freeze([...effects]) });
}
