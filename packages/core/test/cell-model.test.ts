/**
 * @file Proves canonical Cell bytes, protocol binding, and deterministic effect identity.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { fromZod, programDecision } from '../src/index.js';
import {
  CELL_CREATE_ACTION,
  CellIdSchema,
  CellHostIdSchema,
  CellProtocolRevisionSchema,
  CellSequenceSchema,
  ProgramRevisionSchema,
  StateProjectionRevisionSchema,
  bindCellProtocol,
  cellEffectId,
  compareCellProtocol,
  createCellServiceAuthority,
  defineJsonCellProtocol,
  jsonCellCodec,
  type CellCreateAction,
  type CellProtocol,
} from '../src/cells/index.js';

/** Optional revision substitutions used by compatibility tests. */
type CounterProtocolOverrides = Readonly<{
  /** Replaces the complete Cell protocol revision. */
  protocol: string;

  /** Replaces the pure Program behavior revision. */
  program: string;

  /** Replaces the public state projection revision. */
  projection: string;
}>;

/** Frozen JSON counter value used across codec and protocol proofs. */
const CounterSchema = z
  .strictObject({ count: z.number().int(), labels: z.strictObject({ beta: z.boolean(), alpha: z.boolean() }) })
  .transform(
    /**
     * Copies validated state so later caller mutation cannot alter codec fixtures.
     * @param value - Validated counter and nested labels.
     * @returns Deeply frozen counter value.
     */
    (value) => Object.freeze({ ...value, labels: Object.freeze(value.labels) }),
  )
  .readonly();

/** Adapts the production-shaped counter through product-neutral validation. */
const counterCodec = jsonCellCodec({ revision: 'counter-json/1', value: fromZod(CounterSchema) });

/**
 * Builds a minimal deterministic protocol whose distinct revisions can be compared.
 * @param overrides - Optional revision substitutions for one mismatch family.
 * @returns Frozen production-shaped counter protocol.
 */
function counterProtocol(overrides: Partial<CounterProtocolOverrides> = {}) {
  return Object.freeze({
    protocolRevision: CellProtocolRevisionSchema.parse(overrides.protocol ?? 'counter-cell/1'),
    programRevision: ProgramRevisionSchema.parse(overrides.program ?? 'counter-program/1'),
    projectionRevision: StateProjectionRevisionSchema.parse(overrides.projection ?? 'counter-view/1'),
    durability: Object.freeze({ type: 'same-filesystem' as const }),
    program: Object.freeze({
      /**
       * Returns acknowledged state unchanged because compatibility is the behavior under test.
       * @param state - Current canonical counter fixture.
       * @returns Pure no-effect decision retaining that state.
       */
      reduce(state: Readonly<z.output<typeof CounterSchema>>) {
        return programDecision<z.output<typeof CounterSchema>, Readonly<Record<string, never>>>(state);
      },
    }),
    /**
     * Returns the immutable canonical state as its own bounded fixture view.
     * @param state - Current canonical counter fixture.
     * @returns Same immutable fixture value.
     */
    projectState(state: Readonly<z.output<typeof CounterSchema>>) {
      return state;
    },
    codecs: Object.freeze({
      state: counterCodec,
      stateView: counterCodec,
      event: jsonCellCodec({ revision: 'counter-event/1', value: fromZod(z.strictObject({}).readonly()) }),
      effect: jsonCellCodec({ revision: 'counter-effect/1', value: fromZod(z.strictObject({}).readonly()) }),
    }),
  }) satisfies CellProtocol<
    z.output<typeof CounterSchema>,
    z.output<typeof CounterSchema>,
    Readonly<Record<string, never>>,
    Readonly<Record<string, never>>
  >;
}

describe('Cell pure model', () => {
  it('defines the common JSON protocol from one revision and product-neutral codecs', () => {
    /** Common construction keeps every derived persistence binding inspectable. */
    const protocol = defineJsonCellProtocol({
      revision: 'counter/1',
      durability: 'same-filesystem',
      program: Object.freeze({
        /**
         * Returns the same valid value so this test can isolate protocol construction.
         * @param state - Valid counter supplied by the protocol fixture.
         * @returns A no-effect decision containing that counter.
         */
        reduce(state: Readonly<z.output<typeof CounterSchema>>) {
          return programDecision<z.output<typeof CounterSchema>, Readonly<Record<string, never>>>(state);
        },
      }),
      codecs: Object.freeze({
        state: fromZod(CounterSchema),
        event: fromZod(z.strictObject({}).readonly()),
        effect: fromZod(z.strictObject({}).readonly()),
      }),
    });
    /** Mutable application input proves the default projection admits a fresh value. */
    const mutable = { count: 2, labels: { alpha: true, beta: false } };
    /** Projected state must not retain the caller's mutable object identity. */
    const projected = protocol.projectState(mutable);

    expect(bindCellProtocol(protocol)).toEqual({
      protocol: 'counter/1',
      program: 'counter/1/program',
      projection: 'counter/1/projection',
      stateCodec: 'counter/1/state',
      stateViewCodec: 'counter/1/state',
      eventCodec: 'counter/1/event',
      effectCodec: 'counter/1/effect',
    });
    expect(projected).toEqual(mutable);
    expect(projected).not.toBe(mutable);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it('creates explicit host-wide service authority without application grant boilerplate', async () => {
    /** Seven UUIDv4 values cover the ledger, Principal, and five action grants. */
    const ids = [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000005',
      '20000000-0000-4000-8000-000000000006',
      '20000000-0000-4000-8000-000000000007',
    ];
    /** Advances the deterministic UUID fixture through the production factory path. */
    let index = 0;
    /**
     * Returns the next distinct UUIDv4 required by service Authority construction.
     * @returns Next deterministic UUIDv4 fixture.
     */
    const createId = () => ids[index++]!;
    /** Stable host identity scopes every generated grant to one durability service. */
    const hostId = CellHostIdSchema.parse('20000000-0000-4000-8000-000000000008');
    /**
     * Fixed time proves generated roots use the same real verification ledger.
     * @returns Stable grant construction and verification instant.
     */
    const now = () => new Date('2026-08-24T12:00:00.000Z');
    /** Convenience result still exposes normal Authority and exact grant references. */
    const authority = createCellServiceAuthority({
      hostId,
      createId,
      now,
    });
    /** Real current verification proves the factory did not bypass Authority. */
    const decision = await authority.ledger.verify<CellCreateAction>({
      grant: authority.grants.create,
      subject: authority.subject,
      scope: { kind: 'cell', hostId },
    });

    expect(decision.allowed).toBe(true);
    expect(authority.ledger.ledgerId).toBe(ids[0]);
    expect(authority.grants.create.action).toBe(CELL_CREATE_ACTION.action);

    await authority.ledger.close();
  });

  it('owns canonical JSON bytes and restores a fresh immutable value', () => {
    /** Deliberately reverses canonical key order and remains mutable after encoding. */
    const input = { labels: { beta: true, alpha: false }, count: 3 };

    /** Captures exact durable bytes before caller mutation. */
    const encoded = counterCodec.encode(input);
    expect(encoded).toEqual({
      ok: true,
      value: new TextEncoder().encode('{"count":3,"labels":{"alpha":false,"beta":true}}'),
    });
    if (!encoded.ok) throw encoded.error;

    input.count = 9;
    input.labels.alpha = true;
    /** Decodes bytes captured before mutation to prove transport ownership. */
    const decoded = counterCodec.decode(encoded.value);

    expect(decoded).toEqual({ ok: true, value: { count: 3, labels: { alpha: false, beta: true } } });
    if (!decoded.ok) throw decoded.error;
    expect(decoded.value).not.toBe(input);
    expect(Object.isFrozen(decoded.value)).toBe(true);
    expect(Object.isFrozen(decoded.value.labels)).toBe(true);
  });

  it('returns the exact decode failure without manufacturing state', () => {
    /** Uses malformed UTF-8/JSON that production storage can return after corruption. */
    const decoded = counterCodec.decode(Uint8Array.from([0xff, 0x7b]));

    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error('Malformed bytes unexpectedly decoded');
    expect(decoded.error).toBeInstanceOf(Error);
    expect(decoded.error.message).toBe('Invalid canonical Cell JSON bytes');
  });

  it('binds every interpretation revision and names the first mismatch', () => {
    /** Represents the exact protocol persisted at creation. */
    const stored = bindCellProtocol(counterProtocol());

    expect(compareCellProtocol(stored, bindCellProtocol(counterProtocol()))).toBeUndefined();
    expect(compareCellProtocol(stored, bindCellProtocol(counterProtocol({ program: 'counter-program/2' })))).toEqual({
      reason: 'program-revision',
      field: 'program',
    });
  });

  it('derives stable distinct effect identities from cell, sequence, and position', () => {
    /** Uses a valid v4 identity so runtime admission matches production creation. */
    const cellId = CellIdSchema.parse('0190f4cc-3c64-4b68-9a4a-900a27d0f198');
    /** Represents the durable event that caused two ordered effects. */
    const sequence = CellSequenceSchema.parse('7');

    expect(cellEffectId(cellId, sequence, 0)).toBe(cellEffectId(cellId, sequence, 0));
    expect(cellEffectId(cellId, sequence, 0)).not.toBe(cellEffectId(cellId, sequence, 1));
  });
});
