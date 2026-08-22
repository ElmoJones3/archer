/**
 * @file Proves dependency ownership is an explicit immutable value rather than
 * an inference from method names.
 */

import { describe, expect, it, vi } from 'vitest';

import { borrowed, owned, type OwnedHandle } from '../src/index.js';

/** Close evidence used by the retained fixture. */
type FixtureClose = Readonly<{
  /** Stable terminal status returned by both close paths. */
  kind: 'closed';
}>;

/**
 * Creates a production-shaped retained dependency without testing its close behavior here.
 * @returns A retained fixture whose closure has already settled.
 */
function fixtureHandle(): OwnedHandle<FixtureClose> {
  /** One evidence object shared by the fixture's close promise and method. */
  const evidence: FixtureClose = Object.freeze({ kind: 'closed' });

  /** The already-settled lifecycle signal expected by the ownership wrapper. */
  const closed = Promise.resolve(evidence);

  return {
    closed,
    close: vi.fn(() => closed),
    /** Delegates disposal to the same close path as a real retained handle. */
    async [Symbol.asyncDispose]() {
      await closed;
    },
  };
}

describe('ComponentRef', () => {
  it('marks borrowed dependencies without requiring retained lifecycle behavior', () => {
    /** Represents an application-owned finite service with no close method. */
    const service = Object.freeze({ name: 'application-service' });

    /** Captures the explicit no-transfer ownership decision. */
    const reference = borrowed(service);

    expect(reference).toEqual({ ownership: 'borrowed', value: service });
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it('marks retained dependencies owned without invoking their lifecycle', () => {
    /** Represents the retained dependency whose ownership transfers. */
    const handle = fixtureHandle();

    /** Captures the explicit lifecycle transfer. */
    const reference = owned(handle);

    expect(reference).toEqual({ ownership: 'owned', value: handle });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(handle.close).not.toHaveBeenCalled();
  });
});
