/**
 * @file Provides deterministic temporal fixtures shared by core stream tests.
 *
 * Tests advance scheduled work explicitly so assertions never depend on wall
 * time, timer resolution, or host event-loop load.
 */

export {
  ManualTaskScheduler as ManualScheduler,
  createDeferredTask as deferred,
  type DeferredTask as Deferred,
} from '../src/stream/testing.js';
import type { EventEncoding } from '../src/stream/runtime.js';

/**
 * Creates a revisioned JSON byte contract for deterministic JSON-safe fixtures.
 *
 * Production protocols own canonical codecs. Tests use objects with fixed key
 * construction order, so this helper keeps their encoded accounting explicit
 * without obscuring the behavior each scenario proves.
 * @param revision - Stable fixture wire revision bound to the measured values.
 * @returns A frozen event encoding suitable for low-level source construction.
 */
export function fixtureEventEncoding<Event>(revision = 'fixture-event/1'): EventEncoding<Event> {
  return Object.freeze({
    revision,
    /**
     * Copies and freezes each flat fixture value before source admission.
     * @param event - Caller-owned fixture candidate.
     * @returns A source-owned immutable clone.
     */
    normalize: (event: Event) => Object.freeze(structuredClone(event)) as Event,
    /**
     * Measures the fixture's exact JSON bytes under its fixed construction order.
     * @param event - JSON-safe fixture value admitted by the scenario.
     * @returns UTF-8 bytes produced by the fixture wire representation.
     */
    measure: (event: Event) => new TextEncoder().encode(JSON.stringify(event)).byteLength,
  });
}

/**
 * Pulls the next value from an async iterator and proves it has not ended.
 * @param iterator - The retained iterator under test.
 * @returns The next yielded value.
 */
export async function nextValue<Value>(iterator: AsyncIterator<Value>): Promise<Value> {
  /** Captures one explicit consumer pull. */
  const result = await iterator.next();
  if (result.done) throw new Error('Expected the iterator to yield a value');
  return result.value;
}
