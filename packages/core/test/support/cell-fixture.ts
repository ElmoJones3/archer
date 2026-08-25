/**
 * @file Builds production-reachable Cell protocols and Authority fixtures for conformance tests.
 */

import * as z from 'zod';

import { fromZod } from '../../src/codec.js';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type AuthorityLedger,
  type GrantRef,
} from '../../src/authority/index.js';
import { borrowed } from '../../src/ownership.js';
import { programDecision } from '../../src/program.js';
import { IdempotencyKeySchema } from '../../src/protocol.js';
import { TimestampSchema } from '../../src/values.js';
import {
  CELL_ATTACH_ACTION,
  CELL_CREATE_ACTION,
  CELL_DISPATCH_ACTION,
  CELL_DISCOVER_ACTION,
  CELL_READ_ACTION,
  CellHostIdSchema,
  CellIdSchema,
  CellProtocolRevisionSchema,
  ProgramRevisionSchema,
  StateProjectionRevisionSchema,
  jsonCellCodec,
  type CellAction,
  type CellAttachAction,
  type CellCreateAction,
  type CellDispatchAction,
  type CellDiscoverAction,
  type CellHostBaseOptions,
  type CellProtocol,
  type CellReadAction,
} from '../../src/cells/index.js';

/** Counter state proves durable transitions rather than storage-only writes. */
const CounterStateSchema = z
  .strictObject({ count: z.number().int().nonnegative() })
  .transform((value) => Object.freeze(value))
  .readonly();

/** Counter events include ordinary increments and an explicit wake transition. */
const CounterEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('increment'), amount: z.number().int().positive() }),
    z.strictObject({ type: z.literal('wake') }),
  ])
  .transform((value) => Object.freeze(value))
  .readonly();

/** No-effect schema keeps fixture intent structurally production-reachable. */
const NoEffectSchema = z.never();

/** Delivery state demonstrates acknowledged external effect settlement. */
const DeliveryStateSchema = z
  .strictObject({ status: z.enum(['idle', 'requested', 'delivered']) })
  .transform((value) => Object.freeze(value))
  .readonly();

/** Delivery events distinguish user intent from adapter result. */
const DeliveryEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('request') }),
    z.strictObject({ type: z.literal('delivered') }),
  ])
  .transform((value) => Object.freeze(value))
  .readonly();

/** Delivery effect is durable JSON rather than a process-local callback. */
const DeliveryEffectSchema = z
  .strictObject({ type: z.literal('deliver'), webhookId: z.string().min(1) })
  .transform((value) => Object.freeze(value))
  .readonly();

/** Counter state type restored by the canonical fixture codec. */
export type CounterState = z.output<typeof CounterStateSchema>;

/** Counter event type accepted by the fixture Program. */
export type CounterEvent = z.output<typeof CounterEventSchema>;

/** State used by the acknowledged effect fixture. */
export type DeliveryState = z.output<typeof DeliveryStateSchema>;

/** Event used by the acknowledged effect fixture. */
export type DeliveryEvent = z.output<typeof DeliveryEventSchema>;

/** Effect intent used by the acknowledged effect fixture. */
export type DeliveryEffect = z.output<typeof DeliveryEffectSchema>;

/** Exact CellHost identity shared by the fixture Authority grants. */
export const CELL_HOST_ID = CellHostIdSchema.parse('10000000-0000-4000-8000-000000000001');

/** Exact durable Cell identity used by reference-host tests. */
export const CELL_ID = CellIdSchema.parse('10000000-0000-4000-8000-000000000002');

/** Principal attributed by every fixture action. */
export const CELL_SUBJECT = PrincipalIdSchema.parse('10000000-0000-4000-8000-000000000003');

/** Idempotency identity used by fixture Cell creation. */
export const CELL_CREATE_KEY = IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000004');

/** First external counter command identity. */
export const CELL_COMMAND_KEY = IdempotencyKeySchema.parse('10000000-0000-4000-8000-000000000005');

/** Stable Authority ledger identity for production grant evaluation. */
const CELL_LEDGER_ID = AuthorityLedgerIdSchema.parse('10000000-0000-4000-8000-000000000006');

/** Trusted construction instant shared by all root grants. */
const CREATED_AT = TimestampSchema.parse('2026-08-24T00:00:00.000Z');

/** Exact grant references needed by every protected Cell operation. */
export type CellFixtureGrants = Readonly<{
  /** Authorizes creation in the fixture host. */
  create: GrantRef<CellCreateAction>;

  /** Authorizes attachment in the fixture host. */
  attach: GrantRef<CellAttachAction>;

  /** Authorizes full canonical state reads. */
  read: GrantRef<CellReadAction>;

  /** Authorizes event dispatch to the fixture host. */
  dispatch: GrantRef<CellDispatchAction>;

  /** Authorizes bounded recovery discovery in the fixture host. */
  discover: GrantRef<CellDiscoverAction>;
}>;

/** Production Authority and exact action references used by one test host. */
export type CellAuthorityFixture = Readonly<{
  /** Real current-verification ledger registered with every Cell action. */
  ledger: AuthorityLedger<CellAction>;

  /** Action-specific grant references passed at the protected boundary. */
  grants: CellFixtureGrants;
}>;

/**
 * Builds one real Authority ledger with host-wide Cell grants.
 * @param now - Trusted current time used for each verification.
 * @returns Ledger and action-specific references with no fake permission cache.
 */
export function createCellAuthorityFixture(now: () => Date): CellAuthorityFixture {
  /** Distinct UUIDv4 grant identities preserve action-category typing. */
  const grantIds = [
    '10000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000014',
  ].map((id) => AuthorizationGrantIdSchema.parse(id));
  /** Host-wide scope permits individual Cell requests without hiding containment semantics. */
  const scope = Object.freeze({ kind: 'cell' as const, hostId: CELL_HOST_ID });
  /** Each root retains its exact action generic before entering the union ledger. */
  const bootstrap = [
    createBootstrapAuthorizationGrant<CellCreateAction>(CELL_CREATE_ACTION, {
      id: grantIds[0]!,
      ledgerId: CELL_LEDGER_ID,
      subject: CELL_SUBJECT,
      scope,
      issuedBy: CELL_SUBJECT,
      createdAt: CREATED_AT,
    }),
    createBootstrapAuthorizationGrant<CellAttachAction>(CELL_ATTACH_ACTION, {
      id: grantIds[1]!,
      ledgerId: CELL_LEDGER_ID,
      subject: CELL_SUBJECT,
      scope,
      issuedBy: CELL_SUBJECT,
      createdAt: CREATED_AT,
    }),
    createBootstrapAuthorizationGrant<CellReadAction>(CELL_READ_ACTION, {
      id: grantIds[2]!,
      ledgerId: CELL_LEDGER_ID,
      subject: CELL_SUBJECT,
      scope,
      issuedBy: CELL_SUBJECT,
      createdAt: CREATED_AT,
    }),
    createBootstrapAuthorizationGrant<CellDispatchAction>(CELL_DISPATCH_ACTION, {
      id: grantIds[3]!,
      ledgerId: CELL_LEDGER_ID,
      subject: CELL_SUBJECT,
      scope,
      issuedBy: CELL_SUBJECT,
      createdAt: CREATED_AT,
    }),
    createBootstrapAuthorizationGrant<CellDiscoverAction>(CELL_DISCOVER_ACTION, {
      id: grantIds[4]!,
      ledgerId: CELL_LEDGER_ID,
      subject: CELL_SUBJECT,
      scope,
      issuedBy: CELL_SUBJECT,
      createdAt: CREATED_AT,
    }),
  ] as const;
  /** Real in-memory ledger evaluates every fixture grant through production logic. */
  const ledger = createMemoryAuthorityLedger<CellAction>({
    ledgerId: CELL_LEDGER_ID,
    actions: [CELL_CREATE_ACTION, CELL_ATTACH_ACTION, CELL_READ_ACTION, CELL_DISPATCH_ACTION, CELL_DISCOVER_ACTION],
    bootstrap,
    now,
  });
  return Object.freeze({
    ledger,
    grants: Object.freeze({
      create: Object.freeze({ grantId: grantIds[0]!, action: 'cell-create' }),
      attach: Object.freeze({ grantId: grantIds[1]!, action: 'cell-attach' }),
      read: Object.freeze({ grantId: grantIds[2]!, action: 'cell-read' }),
      dispatch: Object.freeze({ grantId: grantIds[3]!, action: 'cell-dispatch' }),
      discover: Object.freeze({ grantId: grantIds[4]!, action: 'cell-discover' }),
    }),
  });
}

/**
 * Builds a deterministic counter protocol with optional wake projection.
 * @param wakeAt - Due instant projected until the counter reaches ten.
 * @returns Exact revision-bound Program and canonical codecs.
 */
export function createCounterProtocol(wakeAt?: string): CellProtocol<CounterState, CounterState, CounterEvent, never> {
  /** Canonical codecs copy, freeze, and bind every durable generic family. */
  const state = jsonCellCodec({ revision: 'counter-state/1', value: fromZod(CounterStateSchema) });
  /** Event codec admits both external increments and recovered wakes. */
  const event = jsonCellCodec({ revision: 'counter-event/1', value: fromZod(CounterEventSchema) });
  return Object.freeze({
    protocolRevision: CellProtocolRevisionSchema.parse('counter-cell/1'),
    programRevision: ProgramRevisionSchema.parse('counter-program/1'),
    projectionRevision: StateProjectionRevisionSchema.parse('counter-projection/1'),
    durability: Object.freeze({ type: 'same-filesystem' }),
    program: Object.freeze({
      /**
       * Applies ordinary increments and a visible ten-point wake transition.
       * @param current - Previously acknowledged counter state.
       * @param input - Explicit external or recovered wake event.
       * @returns Fresh state with no external effects.
       */
      reduce(current: Readonly<CounterState>, input: Readonly<CounterEvent>) {
        return programDecision(
          Object.freeze({ count: input.type === 'increment' ? current.count + input.amount : current.count + 10 }),
          [],
        );
      },
    }),
    /**
     * Copies acknowledged counter state into the public fixture view.
     * @param current - Current acknowledged counter state.
     * @returns Fresh immutable state projection.
     */
    projectState(current) {
      return Object.freeze({ ...current });
    },
    ...(wakeAt === undefined
      ? {}
      : {
          /**
           * Projects one recoverable wake until the fixture reaches its terminal count.
           * @param current - Current acknowledged counter state.
           * @returns Wake intent or absence after terminal count.
           */
          projectWake(current: Readonly<CounterState>) {
            return current.count >= 10
              ? undefined
              : Object.freeze({
                  at: wakeAt as import('../../src/values.js').Timestamp,
                  event: Object.freeze({ type: 'wake' as const }),
                });
          },
        }),
    codecs: Object.freeze({
      state,
      stateView: state,
      event,
      effect: jsonCellCodec({ revision: 'no-effect/1', value: fromZod(NoEffectSchema) }),
    }),
  });
}

/**
 * Builds a protocol whose first event acknowledges an external delivery intent.
 * @returns Revision-bound protocol used to prove effect claim and result acknowledgement.
 */
export function createDeliveryProtocol(): CellProtocol<DeliveryState, DeliveryState, DeliveryEvent, DeliveryEffect> {
  /** Canonical delivery state codec backs both durable state and its public view. */
  const state = jsonCellCodec({ revision: 'delivery-state/1', value: fromZod(DeliveryStateSchema) });
  return Object.freeze({
    protocolRevision: CellProtocolRevisionSchema.parse('delivery-cell/1'),
    programRevision: ProgramRevisionSchema.parse('delivery-program/1'),
    projectionRevision: StateProjectionRevisionSchema.parse('delivery-projection/1'),
    durability: Object.freeze({ type: 'same-filesystem' }),
    program: Object.freeze({
      /**
       * Produces one effect from user intent and accepts its later result as an event.
       * @param current - Previously acknowledged delivery state.
       * @param input - User request or adapter result event.
       * @returns Fresh state and exact new effect intent.
       */
      reduce(current: Readonly<DeliveryState>, input: Readonly<DeliveryEvent>) {
        return input.type === 'request'
          ? programDecision(Object.freeze({ status: 'requested' as const }), [
              Object.freeze({ type: 'deliver' as const, webhookId: 'webhook-1' }),
            ])
          : programDecision(Object.freeze({ status: 'delivered' as const }), []);
      },
    }),
    /**
     * Copies acknowledged delivery state into the public fixture view.
     * @param current - Current acknowledged delivery state.
     * @returns Fresh immutable state projection.
     */
    projectState(current) {
      return Object.freeze({ ...current });
    },
    codecs: Object.freeze({
      state,
      stateView: state,
      event: jsonCellCodec({ revision: 'delivery-event/1', value: fromZod(DeliveryEventSchema) }),
      effect: jsonCellCodec({ revision: 'delivery-effect/1', value: fromZod(DeliveryEffectSchema) }),
    }),
  });
}

/**
 * Builds shared host options with a borrowed production Authority ledger.
 * @param fixture - Ledger and grant fixture for this host.
 * @param now - Trusted mutable or fixed test clock.
 * @param schedule - Optional deterministic scheduler.
 * @returns Complete common host options.
 */
export function cellHostOptions(
  fixture: CellAuthorityFixture,
  now: () => Date,
  schedule?: CellHostBaseOptions['schedule'],
): CellHostBaseOptions {
  return Object.freeze({
    hostId: CELL_HOST_ID,
    authority: borrowed(fixture.ledger),
    leaseDurationMilliseconds: 100,
    observationRetentionItems: 32,
    /**
     * Supplies one deterministic UUIDv4 owner unless a case overrides it.
     * @returns Valid deterministic UUIDv4 text.
     */
    createId: () => '10000000-0000-4000-8000-000000000020',
    now,
    ...(schedule === undefined ? {} : { schedule }),
  });
}
