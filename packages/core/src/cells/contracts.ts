/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines the storage-neutral contract for durable Archer Cells.
 *
 * A Cell owns acknowledged Program state, ordered observations, effect attempts,
 * fencing, wakes, and recovery. Storage products implement `CellHost`; they do
 * not change what acknowledgement, closure, or stale ownership means.
 */

import * as z from 'zod';

import { fromZod, type Codec } from '../codec.js';
import type { DiagnosticHub } from '../diagnostics/contracts.js';
import { ArcherError } from '../errors.js';
import type { ComponentRef, OwnedHandle } from '../ownership.js';
import type { Program } from '../program.js';
import type { IdempotencyKey, PublicError } from '../protocol.js';
import type { Result as ResultValue } from '../result.js';
import type {
  AtomicLiveAttachmentSource,
  LiveOperation,
  LiveState,
  ReplayableEventStream,
  StreamCursor,
  TransientEventStream,
} from '../stream/contracts.js';
import {
  CanonicalDecimalSchema,
  Sha256DigestSchema,
  UuidV4Schema,
  type CanonicalDecimal,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '../values.js';
import {
  defineAuthorityAction,
  type AuthorityActionDefinition,
  type AuthorityBroker,
  type AuthorityRefusal,
  type GrantRef,
  type PrincipalId,
  type ProtectedAction,
} from '../authority/contracts.js';

/** Prevents an ordinary UUIDv4 from naming a Cell. */
declare const cellIdBrand: unique symbol;

/** Identifies one durable Program instance independently of its current host. */
export type CellId = UuidV4 & {
  /** Carries compile-time evidence of Cell identity admission. */
  readonly [cellIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a CellHost attachment. */
declare const cellHostIdBrand: unique symbol;

/** Identifies one configured durability service and its authority target. */
export type CellHostId = UuidV4 & {
  /** Carries compile-time evidence of CellHost identity admission. */
  readonly [cellHostIdBrand]: true;
};

/** Canonical runtime admission for Cell UUIDv4 identities. */
export const CellIdSchema = UuidV4Schema.transform((value) => value as CellId);

/** Canonical runtime admission for CellHost UUIDv4 identities. */
export const CellHostIdSchema = UuidV4Schema.transform((value) => value as CellHostId);

/** Prevents an arbitrary decimal from being used as acknowledged Cell order. */
declare const cellSequenceBrand: unique symbol;

/** Monotonic Program-event order within one Cell. */
export type CellSequence = CanonicalDecimal & {
  /** Carries compile-time evidence of Cell sequence admission. */
  readonly [cellSequenceBrand]: true;
};

/** Canonical runtime admission for non-negative Cell sequences. */
export const CellSequenceSchema = CanonicalDecimalSchema.transform((value) => value as CellSequence);

/** Prevents an arbitrary decimal from posing as current ownership evidence. */
declare const fenceEpochBrand: unique symbol;

/** Monotonic ownership generation that rejects work from superseded activations. */
export type FenceEpoch = CanonicalDecimal & {
  /** Carries compile-time evidence of fence-epoch admission. */
  readonly [fenceEpochBrand]: true;
};

/** Canonical runtime admission for non-negative Cell fence epochs. */
export const FenceEpochSchema = CanonicalDecimalSchema.transform((value) => value as FenceEpoch);

/** Prevents an arbitrary string from selecting a Cell protocol revision. */
declare const cellProtocolRevisionBrand: unique symbol;

/** Binds the complete persisted Cell interpretation contract. */
export type CellProtocolRevision = string & {
  /** Carries compile-time evidence of non-empty revision admission. */
  readonly [cellProtocolRevisionBrand]: true;
};

/** Prevents an arbitrary string from selecting Program behavior. */
declare const programRevisionBrand: unique symbol;

/** Binds deterministic state and effect decisions to one implementation revision. */
export type ProgramRevision = string & {
  /** Carries compile-time evidence of non-empty revision admission. */
  readonly [programRevisionBrand]: true;
};

/** Prevents an arbitrary string from selecting a public state projection. */
declare const stateProjectionRevisionBrand: unique symbol;

/** Binds the bounded public state view to one projection implementation. */
export type StateProjectionRevision = string & {
  /** Carries compile-time evidence of non-empty revision admission. */
  readonly [stateProjectionRevisionBrand]: true;
};

/** Prevents an arbitrary string from selecting durable bytes. */
declare const cellCodecRevisionBrand: unique symbol;

/** Binds one durable value family to an exact byte encoding. */
export type CellCodecRevision = string & {
  /** Carries compile-time evidence of non-empty revision admission. */
  readonly [cellCodecRevisionBrand]: true;
};

/** Shared bounded runtime admission for every human-authored Cell revision. */
const CellRevisionSchema = z.string().trim().min(1).max(128);

/** Canonical runtime admission for complete Cell protocol revisions. */
export const CellProtocolRevisionSchema = CellRevisionSchema.transform((value) => value as CellProtocolRevision);

/** Canonical runtime admission for deterministic Program revisions. */
export const ProgramRevisionSchema = CellRevisionSchema.transform((value) => value as ProgramRevision);

/** Canonical runtime admission for public state-projection revisions. */
export const StateProjectionRevisionSchema = CellRevisionSchema.transform((value) => value as StateProjectionRevision);

/** Canonical runtime admission for durable byte-codec revisions. */
export const CellCodecRevisionSchema = CellRevisionSchema.transform((value) => value as CellCodecRevision);

/** Prevents arbitrary digests from being confused with deterministic effect identity. */
declare const cellEffectIdBrand: unique symbol;

/** Identifies one effect intent from its causing Cell sequence and position. */
export type CellEffectId = Sha256Digest & {
  /** Carries compile-time evidence of deterministic Cell effect identity. */
  readonly [cellEffectIdBrand]: true;
};

/** Canonical runtime admission for deterministic effect identities. */
export const CellEffectIdSchema = Sha256DigestSchema.transform((value) => value as CellEffectId);

/** Prevents a cursor for another replay family from resuming Cell observations. */
export type CellCursor = StreamCursor<'cell'>;

/** Stable Error categories for invalid Cell construction and broken adapters. */
export type CellErrorCode =
  | 'cell_invalid_configuration'
  | 'cell_invalid_protocol'
  | 'cell_invalid_value'
  | 'cell_program_failed'
  | 'cell_projection_failed'
  | 'cell_storage_failed'
  | 'cell_storage_protocol_failed'
  | 'cell_effect_adapter_failed'
  | 'cell_capacity_exceeded';

/** Optional redaction-safe context retained by a Cell implementation Error. */
type CellErrorOptions = ErrorOptions & {
  /** Carries admitted machine-readable details without state or credential bytes. */
  readonly details?: JsonObject;
};

/** Reports invalid construction or a violated Cell implementation boundary. */
export class CellError extends ArcherError {
  /** Narrows the inherited machine code to the stable Cell failure set. */
  declare readonly code: CellErrorCode;

  /**
   * Constructs one redaction-safe Cell failure.
   * @param code - Stable failure category suitable for adapter handling.
   * @param message - Bounded explanation without state, event, effect, or credential data.
   * @param options - Optional admitted details and process-local cause.
   */
  constructor(code: CellErrorCode, message: string, options: CellErrorOptions = {}) {
    super(message, {
      code,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/** Encodes and restores one durable Cell value without exposing a validator product. */
export interface CellCodec<Value> {
  /** Identifies the exact durable byte representation used by this codec. */
  readonly revision: CellCodecRevision;

  /**
   * Copies and validates an application value into canonical durable bytes.
   * Implementations must return fresh bytes and must not retain mutable input.
   */
  encode(value: Readonly<Value>): ResultValue<Uint8Array, Error>;

  /** Restores a fresh trusted value or returns exact bounded decoding failure. */
  decode(bytes: Uint8Array): ResultValue<Value, Error>;
}

/** Declares the minimum failure domain a protocol requires from its selected host. */
export type CellDurabilityRequirement =
  | Readonly<{
      /** Accepts durability tied to one filesystem and its configured host process. */
      type: 'same-filesystem';
    }>
  | Readonly<{
      /** Requires ownership and recovery to survive loss of any one worker node. */
      type: 'node-independent';
    }>;

/** Exact embedded SQLite guarantee visible to configuration and inspection. */
export type EmbeddedSqliteCellDurability = Readonly<{
  /** Selects the built-in same-filesystem implementation. */
  type: 'embedded-sqlite';

  /** Names the physical failure boundary that retains acknowledged state. */
  persistence: 'same-filesystem';

  /** Defines success as one committed SQLite transaction. */
  acknowledgement: 'sqlite-transaction';
}>;

/** Exact direct-object-store guarantee visible to configuration and inspection. */
export type S3CasCellDurability = Readonly<{
  /** Selects the direct S3 conditional-object implementation. */
  type: 's3-cas';

  /** States that any worker can restore from the configured object store. */
  persistence: 'node-independent';

  /** Defines success as immutable revision publication followed by head CAS. */
  acknowledgement: 'immutable-revision-head-cas';

  /** Caps canonical mutable record bytes before any remote write begins. */
  stateLimitBytes: number;

  /** Makes durable wake discovery cost and completeness explicit. */
  wakeDiscovery: Readonly<{
    /** Selects the v1 prefix scanner rather than implying a free alarm service. */
    type: 'bounded-scan';

    /** Limits head objects inspected during one scan pass. */
    maxHeadsPerScan: number;
  }>;
}>;

/** Guarantees currently published by first-party CellHost implementations. */
export type CellDurability = EmbeddedSqliteCellDurability | S3CasCellDurability;

/** One deterministic future event derived from acknowledged Program state. */
export type CellWake<Event> = Readonly<{
  /** Determines when a resident timer or recovering host may claim the wake. */
  at: Timestamp;

  /** Re-enters the same Program through ordinary acknowledged event handling. */
  event: Event;
}>;

/**
 * Complete interpretation contract required to create or restore one Cell.
 * Every function is deterministic and every durable value crosses its codec.
 */
export type CellProtocol<State, StateView, Event, Effect> = Readonly<{
  /** Binds all protocol-owned behavior and durable layout expectations. */
  protocolRevision: CellProtocolRevision;

  /** Binds the pure Program implementation independently of storage. */
  programRevision: ProgramRevision;

  /** Binds the bounded hot state projection independently of canonical state. */
  projectionRevision: StateProjectionRevision;

  /** Rejects hosts whose declared failure boundary is weaker than required. */
  durability: CellDurabilityRequirement;

  /** Owns deterministic state and effect decisions for accepted events. */
  program: Program<State, Event, Effect>;

  /** Produces a bounded immutable view without reconstructing state from observations. */
  projectState(state: Readonly<State>): StateView;

  /** Optionally derives one recoverable future event from acknowledged state. */
  projectWake?: (state: Readonly<State>) => CellWake<Event> | undefined;

  /** Owns exact durable bytes for every generic protocol value. */
  codecs: Readonly<{
    /** Persists complete canonical Program state. */
    state: CellCodec<State>;

    /** Bounds and restores the public state view retained in hot snapshots. */
    stateView: CellCodec<StateView>;

    /** Persists ordered input and effect-result events. */
    event: CellCodec<Event>;

    /** Persists effect intents before any adapter starts them. */
    effect: CellCodec<Effect>;
  }>;
}>;

/** Scope shared by Cell creation, attachment, read, and dispatch actions. */
export type CellActionScope = Readonly<{
  /** Keeps Cell scopes distinct from other UUID-addressed resources. */
  kind: 'cell';

  /** Prevents a grant from crossing durability services. */
  hostId: CellHostId;

  /** Optionally narrows a host-wide grant to one exact Cell. */
  cellId?: CellId;
}>;

/** Protected permission to create one Cell identity. */
export type CellCreateAction = ProtectedAction<'cell-create', CellActionScope>;

/** Protected permission to acquire one retained Cell activation. */
export type CellAttachAction = ProtectedAction<'cell-attach', CellActionScope>;

/** Protected permission to read canonical stored Cell state. */
export type CellReadAction = ProtectedAction<'cell-read', CellActionScope>;

/** Protected permission to dispatch an event to one active Cell. */
export type CellDispatchAction = ProtectedAction<'cell-dispatch', CellActionScope>;

/** Protected permission to discover recoverable Cells within one host. */
export type CellDiscoverAction = ProtectedAction<'cell-discover', CellActionScope>;

/** Canonical runtime admission for Cell authority scopes. */
const CellActionScopeSchema = z
  .strictObject({
    kind: z.literal('cell'),
    hostId: CellHostIdSchema,
    cellId: CellIdSchema.optional(),
  })
  .transform((value) => Object.freeze(value) as CellActionScope)
  .readonly();

/** Product-neutral codec facade used by every built-in Cell action. */
const cellActionScopeCodec: Codec<CellActionScope> = fromZod(CellActionScopeSchema);

/**
 * Decides whether one host-wide or Cell-specific grant contains a request.
 * @param granted - Scope retained by the current authorization grant.
 * @param requested - Exact scope checked at the protected operation.
 * @returns Whether host identity matches and any granted Cell bound contains the request.
 */
function allowsCellScope(granted: CellActionScope, requested: CellActionScope): boolean {
  return (
    granted.hostId === requested.hostId &&
    (granted.cellId === undefined || (requested.cellId !== undefined && granted.cellId === requested.cellId))
  );
}

/** Built-in action definition used to authorize Cell creation. */
export const CELL_CREATE_ACTION: AuthorityActionDefinition<CellCreateAction> = defineAuthorityAction<CellCreateAction>({
  action: 'cell-create',
  scope: cellActionScopeCodec,
  allows: allowsCellScope,
});

/** Built-in action definition used to authorize Cell attachment. */
export const CELL_ATTACH_ACTION: AuthorityActionDefinition<CellAttachAction> = defineAuthorityAction<CellAttachAction>({
  action: 'cell-attach',
  scope: cellActionScopeCodec,
  allows: allowsCellScope,
});

/** Built-in action definition used to authorize canonical state reads. */
export const CELL_READ_ACTION: AuthorityActionDefinition<CellReadAction> = defineAuthorityAction<CellReadAction>({
  action: 'cell-read',
  scope: cellActionScopeCodec,
  allows: allowsCellScope,
});

/** Built-in action definition used to authorize Cell event dispatch. */
export const CELL_DISPATCH_ACTION: AuthorityActionDefinition<CellDispatchAction> =
  defineAuthorityAction<CellDispatchAction>({
    action: 'cell-dispatch',
    scope: cellActionScopeCodec,
    allows: allowsCellScope,
  });

/** Built-in action definition used to discover recoverable Cell identities. */
export const CELL_DISCOVER_ACTION: AuthorityActionDefinition<CellDiscoverAction> =
  defineAuthorityAction<CellDiscoverAction>({
    action: 'cell-discover',
    scope: cellActionScopeCodec,
    allows: allowsCellScope,
  });

/** Complete Cell-owned action union registered by first-party Authority ledgers. */
export type CellAction = CellCreateAction | CellAttachAction | CellReadAction | CellDispatchAction | CellDiscoverAction;

/** Authorized bounded scan request for expired recoverable Cells. */
export type CellDiscoveryRequest = Readonly<{
  /** Attributes storage disclosure to one exact Principal. */
  subject: PrincipalId;

  /** Uses this trusted boundary instead of accepting a caller-defined lease clock. */
  at: Timestamp;

  /** Caps head objects inspected by this page. */
  limit?: number;

  /** Continues one provider-specific bounded listing. */
  cursor?: string;
}>;

/** Exact result of one protected recoverable-Cell scan. */
export type CellDiscoveryOutcome =
  | Readonly<{
      /** Returns currently recoverable identities and optional continuation. */
      kind: 'found';

      /** Contains Cells whose lease expired and whose wake is due or work is stranded. */
      cellIds: readonly CellId[];

      /** Continues the bounded provider listing when another page exists. */
      cursor?: string;
    }>
  | Readonly<{
      /** Reports current Authority denial before object listing. */
      kind: 'authority-refused';

      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<CellDiscoverAction>;
    }>
  | Readonly<{
      /** Reports storage failure without partial discovery results. */
      kind: 'unavailable';

      /** Carries bounded redacted failure evidence. */
      failure: PublicError;
    }>;

/** Supplies trusted wall time to leases, acknowledgements, wakes, and diagnostics. */
export type CellClock = () => Date;

/** Cancels one scheduled Cell activation callback idempotently. */
export type CancelCellSchedule = () => void;

/** Schedules process-local renewal or wake work after a bounded delay. */
export type CellScheduler = (delayMilliseconds: number, task: () => void) => CancelCellSchedule;

/** Construction shared by first-party and third-party CellHost adapters. */
export type CellHostBaseOptions = Readonly<{
  /** Names this configured durability service and its authority scope. */
  hostId: CellHostId;

  /** Retains current authorization with explicit lifecycle ownership. */
  authority: ComponentRef<AuthorityBroker<CellAction>>;

  /** Selects how long one activation may advance state without renewal. */
  leaseDurationMilliseconds?: number;

  /** Caps durable observations hydrated into one active replay source. */
  observationRetentionItems?: number;

  /** Supplies deterministic activation identities in tests and custom hosts. */
  createId?: () => string;

  /** Supplies the only trusted clock used by Cell mechanics. */
  now?: CellClock;

  /** Supplies deterministic timer control without exposing RxJS schedulers. */
  schedule?: CellScheduler;

  /** Receives best-effort wide spans without gaining Cell authority. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/** One stored effect intent awaiting, undergoing, or surviving an attempt. */
export type AcknowledgedEffectAttempt<Effect> = Readonly<{
  /** Names the Cell that durably requested this external work. */
  cellId: CellId;

  /** Identifies the effect independently of retries and workers. */
  effectId: CellEffectId;

  /** Identifies the Program event that caused this intent. */
  causedBy: CellSequence;

  /** Preserves deterministic within-decision activation order. */
  position: number;

  /** Carries the codec-restored effect intent. */
  effect: Effect;

  /** Counts this admitted attempt beginning at one. */
  attempt: number;

  /** Rejects terminal settlement from a superseded activation. */
  fence: FenceEpoch;
}>;

/** Terminal adapter result proposed back to the Program as an ordinary event. */
export type CellEffectResult<Event> = Readonly<{
  /** Distinguishes a Program event from process-local progress or failure. */
  kind: 'event';

  /** Enters canonical state only after a later Cell acknowledgement. */
  event: Event;
}>;

/** Close evidence retained by one finite effect attempt. */
export type CellEffectAttemptCloseEvidence = Readonly<{
  /** Distinguishes attempt cleanup from durable effect settlement. */
  kind: 'effect-attempt-closed';

  /** Repeats deterministic effect identity for lifecycle correlation. */
  effectId: CellEffectId;

  /** Identifies the exact attempt whose process resources were released. */
  attempt: number;
}>;

/** Starts acknowledged external work without receiving Cell mutation authority. */
export interface CellEffectAdapter<Effect, Event, Progress extends JsonValue = JsonValue> {
  /**
   * Constructs one already-running attempt after durable claim settlement.
   * Subscribing to progress must never start, retry, or duplicate the effect.
   */
  start(
    attempt: AcknowledgedEffectAttempt<Effect>,
  ): Promise<LiveOperation<Progress, CellEffectResult<Event>, CellEffectAttemptCloseEvidence>>;
}

/** Process-local activation dependencies supplied whenever a Cell is opened. */
export type CellActivationOptions<Effect, Event, Progress extends JsonValue = JsonValue> = Readonly<{
  /** Omission leaves acknowledged effects pending for a later capable activation. */
  effects?: CellEffectAdapter<Effect, Event, Progress>;
}>;

/** Command that offers one application event to an active Cell. */
export type CellCommand<Event> = Readonly<{
  /** Attributes the protected action to the exact grant subject. */
  subject: PrincipalId;

  /** Carries caller-owned input admitted through the protocol event codec. */
  event: Event;

  /** Deduplicates this exact command at the Cell boundary. */
  idempotencyKey: IdempotencyKey;
}>;

/** Evidence that one Program event and its complete decision became durable. */
export type Acknowledgement = Readonly<{
  /** Names the Cell whose canonical history advanced. */
  cellId: CellId;

  /** Identifies the accepted Program-event position. */
  sequence: CellSequence;

  /** Resumes durable observations after this acknowledgement. */
  cursor: CellCursor;

  /** Identifies the activation fence that committed the decision. */
  fence: FenceEpoch;

  /** Binds the acknowledgement to exact canonical state bytes. */
  stateDigest: Sha256Digest;

  /** Distinguishes original settlement from exact command replay. */
  replayed: boolean;
}>;

/** Stable domain refusal categories that preserve acknowledged Cell state. */
export type CellDispatchRefusalReason =
  'closed' | 'fenced' | 'idempotency-conflict' | 'invalid-event' | 'invalid-decision' | 'capacity-exceeded';

/** Result of one protected event dispatch. */
export type CellDispatchOutcome =
  | Readonly<{
      /** Confirms the complete Program decision became durable. */
      kind: 'acknowledged';

      /** Carries exact sequence, cursor, fence, and state identity. */
      acknowledgement: Acknowledgement;
    }>
  | Readonly<{
      /** Confirms an expected domain rule preserved prior state. */
      kind: 'refused';

      /** Names the exact rule that prevented acknowledgement. */
      reason: CellDispatchRefusalReason;
    }>
  | Readonly<{
      /** Reports current Authority denial before codec or Program execution. */
      kind: 'authority-refused';

      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<CellDispatchAction>;
    }>
  | Readonly<{
      /** Reports a redacted storage or adapter failure with uncertain availability. */
      kind: 'unavailable';

      /** Carries bounded public evidence without state or credentials. */
      failure: PublicError;
    }>;

/** Durable observation emitted only after its corresponding storage commit. */
export type CellObservation<Event> =
  | Readonly<{
      /** Identifies one acknowledged Program event. */
      kind: 'event-acknowledged';

      /** Names the Cell whose canonical history advanced. */
      cellId: CellId;

      /** Orders the accepted Program event. */
      sequence: CellSequence;

      /** Records the committing ownership generation. */
      fence: FenceEpoch;

      /** Carries the codec-restored durable event. */
      event: Event;

      /** Lists deterministic effects created by this decision in activation order. */
      effects: readonly CellEffectId[];

      /** Records storage acknowledgement time rather than Program decision time. */
      acknowledgedAt: Timestamp;
    }>
  | Readonly<{
      /** Identifies one durably claimed external attempt. */
      kind: 'effect-attempt-claimed';

      /** Names the Cell owning the effect. */
      cellId: CellId;

      /** Identifies the effect independently of attempt count. */
      effectId: CellEffectId;

      /** Counts the admitted attempt beginning at one. */
      attempt: number;

      /** Records the fence under which live work may settle. */
      fence: FenceEpoch;

      /** Records durable claim time for recovery and diagnosis. */
      claimedAt: Timestamp;
    }>
  | Readonly<{
      /** Identifies one attempt failure retained for redrive. */
      kind: 'effect-attempt-failed';

      /** Names the Cell owning the effect. */
      cellId: CellId;

      /** Identifies the effect eligible for later redrive. */
      effectId: CellEffectId;

      /** Identifies the exact failed attempt. */
      attempt: number;

      /** Carries redacted failure suitable for durable observation. */
      failure: PublicError;

      /** Records terminal failure observation time. */
      failedAt: Timestamp;
    }>;

/** Non-authoritative activity emitted while an acknowledged effect is live. */
export type CellActivityEvent<Progress extends JsonValue = JsonValue> = Readonly<{
  /** Keeps live progress distinct from durable Cell observations. */
  kind: 'effect-progress';

  /** Names the Cell whose active adapter reported progress. */
  cellId: CellId;

  /** Identifies the durable effect attempt producing this signal. */
  effectId: CellEffectId;

  /** Identifies the exact attempt producing this signal. */
  attempt: number;

  /** Carries bounded adapter-owned presentation data. */
  progress: Progress;
}>;

/** Hot current projection of one retained Cell activation. */
export type CellHandleSnapshot<StateView> = Readonly<{
  /** Names the Cell independently of its current storage location. */
  cellId: CellId;

  /** Contains only state that the selected host acknowledged durably. */
  acknowledged: Readonly<{
    /** Orders Program events without conflating storage-only revisions. */
    sequence: CellSequence;

    /** Resumes durable observation after the current snapshot barrier. */
    cursor: CellCursor;

    /** Identifies the ownership generation that produced this projection. */
    fence: FenceEpoch;

    /** Carries the protocol's bounded immutable projection. */
    state: StateView;
  }>;

  /** Exposes activation changes that may occur without a caller command. */
  lifecycle:
    | Readonly<{
        /** Confirms this handle currently owns an unexpired activation. */
        status: 'active';

        /** States when another worker may attempt fenced recovery. */
        leaseExpiresAt: Timestamp;
      }>
    | Readonly<{
        /** Confirms another activation superseded this handle. */
        status: 'fenced';

        /** Identifies the last fence this process believed it owned. */
        fence: FenceEpoch;
      }>
    | Readonly<{
        /** Confirms this attachment released process-local ownership. */
        status: 'released';
      }>;
}>;

/** Immutable evidence returned when one Cell activation releases ownership. */
export type CellReleaseEvidence = Readonly<{
  /** Distinguishes attachment release from durable Cell cancellation or deletion. */
  kind: 'cell-released';

  /** Names the Cell whose activation stopped accepting work. */
  cellId: CellId;

  /** Identifies the final fence held or observed by this handle. */
  fence: FenceEpoch;

  /** Distinguishes orderly release from supersession or failed recovery. */
  disposition: 'released' | 'fenced' | 'recovery-required';
}>;

/** Retained reactive activation returned by every successful host open. */
export interface CellHandle<StateView, Event, Progress extends JsonValue = JsonValue>
  extends
    LiveState<CellHandleSnapshot<StateView>>,
    AtomicLiveAttachmentSource<
      CellHandleSnapshot<StateView>,
      'cell',
      CellCursor,
      CellObservation<Event>,
      Readonly<{
        /** Names the lossy process-local adapter-progress plane. */
        activity: CellActivityEvent<Progress>;
      }>
    >,
    OwnedHandle<CellReleaseEvidence> {
  /** Names the durable Cell independently of current activation ownership. */
  readonly cellId: CellId;

  /** Publishes the exact host guarantee backing acknowledgements from this handle. */
  readonly durability: CellDurability;

  /** Exposes acknowledged observations through bounded cursor replay. */
  readonly durableEvents: ReplayableEventStream<CellObservation<Event>, CellCursor>;

  /** Exposes lossy adapter progress without granting it domain authority. */
  readonly activityEvents: TransientEventStream<CellActivityEvent<Progress>>;

  /** Offers one authorized event and returns only after durable settlement or refusal. */
  dispatch(command: CellCommand<Event>, grant: GrantRef<CellDispatchAction>): Promise<CellDispatchOutcome>;
}

/** Trusted input that creates one previously absent Cell. */
export type CellCreateRequest<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue> = Readonly<{
  /** Supplies stable Cell identity before any persistence effect. */
  cellId: CellId;

  /** Attributes creation to the exact grant subject. */
  subject: PrincipalId;

  /** Supplies canonical generation-zero Program state. */
  initialState: State;

  /** Binds future restoration to exact behavior and codecs. */
  protocol: CellProtocol<State, StateView, Event, Effect>;

  /** Supplies process-local effect execution capability for this activation. */
  activation?: CellActivationOptions<Effect, Event, Progress>;

  /** Deduplicates create at this host and Cell identity. */
  idempotencyKey: IdempotencyKey;
}>;

/** Input that restores and acquires one existing Cell. */
export type CellAttachRequest<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue> = Readonly<{
  /** Selects the durable Cell to restore. */
  cellId: CellId;

  /** Attributes attachment to the exact grant subject. */
  subject: PrincipalId;

  /** Must match every stored protocol and codec revision. */
  protocol: CellProtocol<State, StateView, Event, Effect>;

  /** Supplies process-local effect execution capability for this activation. */
  activation?: CellActivationOptions<Effect, Event, Progress>;
}>;

/** Input that restores canonical state without acquiring an activation. */
export type CellStateReadRequest<State> = Readonly<{
  /** Selects the durable Cell to inspect. */
  cellId: CellId;

  /** Attributes the protected read to the exact grant subject. */
  subject: PrincipalId;

  /** Must match the complete protocol revision stored with the Cell. */
  protocolRevision: CellProtocolRevision;

  /** Must match and decode the stored canonical state bytes. */
  stateCodec: CellCodec<State>;

  /** Optionally requests an historical Program-event sequence when retained. */
  at?: CellSequence;
}>;

/** Explains why stored state could not be interpreted by a caller's protocol. */
export type CellRestoreRefusal = Readonly<{
  /** Stable compatibility category suitable for migration policy. */
  reason: 'protocol-revision' | 'program-revision' | 'projection-revision' | 'codec-revision' | 'durability';

  /** Names only the mismatching field and never exposes durable value bytes. */
  field: string;
}>;

/** Successful opened Cell and its current retained handle. */
export type OpenedCell<StateView, Event, Progress extends JsonValue = JsonValue> = Readonly<{
  /** Selects the only branch that transfers a retained Cell handle. */
  kind: 'opened';

  /** Owns the newly acquired activation until explicit close. */
  handle: CellHandle<StateView, Event, Progress>;
}>;

/** Result of protected Cell creation. */
export type CellCreateOutcome<StateView, Event, Progress extends JsonValue = JsonValue> =
  | OpenedCell<StateView, Event, Progress>
  | Readonly<{
      /** Reports an existing Cell identity without changing it. */
      kind: 'already-exists';

      /** Repeats the conflicting durable identity. */
      cellId: CellId;
    }>
  | Readonly<{
      /** Reports current Authority denial before durable lookup or mutation. */
      kind: 'authority-refused';

      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<CellCreateAction>;
    }>
  | Readonly<{
      /** Reports host or adapter failure without a partial handle. */
      kind: 'unavailable';

      /** Carries bounded redacted failure evidence. */
      failure: PublicError;
    }>;

/** Result of protected Cell attachment. */
export type CellAttachOutcome<StateView, Event, Progress extends JsonValue = JsonValue> =
  | OpenedCell<StateView, Event, Progress>
  | Readonly<{
      /** Reports ordinary durable absence. */
      kind: 'not-found';

      /** Repeats the missing Cell identity. */
      cellId: CellId;
    }>
  | Readonly<{
      /** Reports stored state that the supplied protocol cannot restore. */
      kind: 'restore-refused';

      /** Names the incompatible revision or durability field. */
      refusal: CellRestoreRefusal;
    }>
  | Readonly<{
      /** Reports another current activation whose lease has not expired. */
      kind: 'active-elsewhere';

      /** Exposes only the lease boundary needed for an informed retry. */
      retryAfter: Timestamp;
    }>
  | Readonly<{
      /** Reports current Authority denial before durable lookup or acquisition. */
      kind: 'authority-refused';

      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<CellAttachAction>;
    }>
  | Readonly<{
      /** Reports host or adapter failure without a partial handle. */
      kind: 'unavailable';

      /** Carries bounded redacted failure evidence. */
      failure: PublicError;
    }>;

/** Result of protected canonical state inspection. */
export type CellStateReadOutcome<State> =
  | Readonly<{
      /** Confirms canonical state was found and decoded. */
      kind: 'found';

      /** Identifies the Program-event sequence represented by state. */
      sequence: CellSequence;

      /** Carries a fresh codec-restored canonical value. */
      state: State;
    }>
  | Readonly<{
      /** Reports ordinary durable absence. */
      kind: 'not-found';

      /** Repeats the missing Cell identity. */
      cellId: CellId;
    }>
  | Readonly<{
      /** Reports stored state incompatible with the supplied revision or codec. */
      kind: 'restore-refused';

      /** Names the incompatible boundary. */
      refusal: CellRestoreRefusal;
    }>
  | Readonly<{
      /** Reports current Authority denial before durable state disclosure. */
      kind: 'authority-refused';

      /** Preserves exact current refusal evidence. */
      refusal: AuthorityRefusal<CellReadAction>;
    }>
  | Readonly<{
      /** Reports host or adapter failure without partial state. */
      kind: 'unavailable';

      /** Carries bounded redacted failure evidence. */
      failure: PublicError;
    }>;

/** Immutable close evidence for one retained CellHost attachment. */
export type CellHostCloseEvidence = Readonly<{
  /** Distinguishes host cleanup from any Cell release or cancellation. */
  kind: 'cell-host-closed';

  /** Names the durability service that stopped accepting operations. */
  hostId: CellHostId;
}>;

/** Replaceable durability service that creates, restores, and reads Cells. */
export interface CellHost extends OwnedHandle<CellHostCloseEvidence> {
  /** Names the exact authority and diagnostics target for this host. */
  readonly hostId: CellHostId;

  /** Publishes the real acknowledgement and recovery guarantee. */
  readonly durability: CellDurability;

  /** Creates and acquires one previously absent Cell. */
  create<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
    request: CellCreateRequest<State, StateView, Event, Effect, Progress>,
    grant: GrantRef<CellCreateAction>,
  ): Promise<CellCreateOutcome<StateView, Event, Progress>>;

  /** Restores and acquires one existing compatible Cell. */
  attach<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
    request: CellAttachRequest<State, StateView, Event, Effect, Progress>,
    grant: GrantRef<CellAttachAction>,
  ): Promise<CellAttachOutcome<StateView, Event, Progress>>;

  /** Reads canonical state without creating an activation or starting effects. */
  readState<State>(
    request: CellStateReadRequest<State>,
    grant: GrantRef<CellReadAction>,
  ): Promise<CellStateReadOutcome<State>>;
}
