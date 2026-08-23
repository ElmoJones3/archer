/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines Archer's product-neutral temporal vocabulary.
 *
 * These declarations intentionally use only standard JavaScript contracts.
 * RxJS owns the implementation graph without becoming part of the public API.
 * The disposable reference keeps that standard contract self-contained for
 * consumers that do not load ambient Node declarations.
 */

import type { OwnedHandle } from '../ownership.js';
import type { IdempotencyKey, ProtocolFailure, PublicError } from '../protocol.js';
import type { CanonicalDecimal } from '../values.js';

/** Detaches one current-state listener synchronously and idempotently. */
export type Unsubscribe = () => void;

/** Exposes the latest immutable state of one retained owner. */
export interface LiveState<State> {
  /** Returns the same object identity until the source publishes a new snapshot. */
  getSnapshot(): State;

  /** Attaches a listener without causing work or replaying a transition. */
  subscribe(listener: (snapshot: State) => void): Unsubscribe;
}

/** Prevents a cursor from one source family being used with another. */
declare const streamCursorSource: unique symbol;

/** A source-branded replay position whose envelope resumes strictly after it. */
export type StreamCursor<Source extends string> = string & {
  /** Carries compile-time evidence of the cursor source family. */
  readonly [streamCursorSource]: Source;
};

/** Selects independent item and encoded-byte limits for one subscriber. */
export type DeliveryBounds = Readonly<{
  /** Maximum accepted values retained for the subscriber. */
  capacityItems?: number;

  /** Maximum encoded bytes retained for the subscriber. */
  capacityBytes?: number;
}>;

/** Declares the largest queue one source permits a subscriber to request. */
export type DeliveryLimits = Readonly<{
  /** Maximum permitted item capacity for one subscriber queue. */
  capacityItems: number;

  /** Maximum permitted encoded-byte capacity for one subscriber queue. */
  capacityBytes: number;
}>;

/** Configures one durable replay attachment. */
export type ReplayDeliveryOptions<Cursor extends StreamCursor<string>> = DeliveryBounds &
  Readonly<{
    /** Replays retained values strictly after this cursor before joining live delivery. */
    after?: Cursor;

    /** Determines whether overflow reports a safe resume cursor or simply detaches. */
    overflow?: 'resume-required' | 'detach';
  }>;

/** Configures one non-durable presentation or diagnostic attachment. */
export type TransientDeliveryOptions = DeliveryBounds &
  Readonly<{
    /** Determines whether overflow is quantified or closes the attachment. */
    overflow?: 'gap' | 'detach';
  }>;

/** Records the exact transient values discarded for one subscriber. */
export type DeliveryGap = Readonly<{
  /** Discriminates a gap marker from source events. */
  kind: 'gap';

  /** Names the logical stream that lost values. */
  source: string;

  /** Identifies the non-replayable source generation. */
  epoch: string;

  /** Counts discarded source values. */
  lostItems: CanonicalDecimal;

  /** Counts discarded bytes using the source's configured measurement. */
  lostBytes: CanonicalDecimal;
}>;

/** Frames transient application data separately from source-owned control evidence. */
export type TransientEventDelivery<Event> = Readonly<{
  /** Discriminates ordinary application data from a delivery gap. */
  kind: 'event';

  /** Carries one normalized non-authoritative source value. */
  value: Event;
}>;

/** One transient delivery whose outer discriminator cannot be forged by Event. */
export type TransientDelivery<Event> = TransientEventDelivery<Event> | DeliveryGap;

/** Associates one durable value with its resume position. */
export type ReplayableEvent<Event, Cursor extends StreamCursor<string>> = Readonly<{
  /** Resumes strictly after this delivered envelope. */
  cursor: Cursor;

  /** Carries the durable observation. */
  value: Event;
}>;

/** Explains why one replayable attachment can no longer produce values. */
export type ReplayStreamClose<Cursor extends StreamCursor<string>> =
  | Readonly<{
      /** Reports normal source completion after accepted values drain. */
      kind: 'completed';

      /** Identifies the last value returned to this subscriber. */
      after?: Cursor;
    }>
  | Readonly<{
      /** Reports explicit subscriber detachment. */
      kind: 'detached';

      /** Identifies the last value returned before detachment. */
      after?: Cursor;
    }>
  | Readonly<{
      /** Requires reattachment because the subscriber exceeded its bound. */
      kind: 'resume-required';

      /** Identifies the last safe value returned to the subscriber. */
      after: Cursor;
    }>
  | Readonly<{
      /** Requires a fresh state seed rather than cursor replay. */
      kind: 'reseed-required';

      /** Distinguishes retention loss from a replaced source generation. */
      reason: 'cursor-expired' | 'source-replaced';
    }>
  | Readonly<{
      /** Reports a violated cursor or source protocol. */
      kind: 'failed';

      /** Carries bounded public evidence of the violation. */
      failure: ProtocolFailure;
    }>;

/** Explains why one transient attachment can no longer produce values. */
export type TransientStreamClose =
  | Readonly<{
      /** Reports normal source completion after accepted values drain. */
      kind: 'completed';
    }>
  | Readonly<{
      /** Reports explicit subscriber detachment or overflow detachment. */
      kind: 'detached';
    }>
  | Readonly<{
      /** Reports an implementation protocol failure. */
      kind: 'failed';

      /** Carries bounded public evidence of the violation. */
      failure: ProtocolFailure;
    }>;

/** The inspectable bound and overflow policy selected for one attachment. */
export type DeliveryConfiguration<Overflow extends string> = Readonly<{
  /** Maximum accepted values retained by this attachment. */
  capacityItems: number;

  /** Maximum encoded bytes retained by this attachment. */
  capacityBytes: number;

  /** Source-capability-specific response to bound exhaustion. */
  overflow: Overflow;
}>;

/** Owns one bounded queue attached to a shared hot source. */
export interface EventSubscription<Event, Close, Overflow extends string>
  extends AsyncIterable<Event>, AsyncDisposable {
  /** Makes the selected queue guarantee inspectable to callers and transports. */
  readonly delivery: DeliveryConfiguration<Overflow>;

  /** Settles once this attachment reaches immutable close evidence. */
  readonly closed: Promise<Close>;

  /** Detaches only this subscriber and returns its terminal evidence. */
  close(): Promise<Close>;
}

/** Exposes durable observations through source-branded cursor replay. */
export interface ReplayableEventStream<Event, Cursor extends StreamCursor<string>> {
  /** Discriminates durable delivery from transient presentation. */
  readonly kind: 'replayable';

  /** Attaches an independent bounded queue without starting source work. */
  subscribe(
    options?: ReplayDeliveryOptions<Cursor>,
  ): EventSubscription<ReplayableEvent<Event, Cursor>, ReplayStreamClose<Cursor>, 'resume-required' | 'detach'>;
}

/** Exposes non-authoritative presentation or diagnostic values with explicit loss. */
export interface TransientEventStream<Event> {
  /** Discriminates transient delivery from durable replay. */
  readonly kind: 'transient';

  /** Attaches an independent bounded queue without starting source work. */
  subscribe(
    options?: TransientDeliveryOptions,
  ): EventSubscription<TransientDelivery<Event>, TransientStreamClose, 'gap' | 'detach'>;
}

/** Prevents an arbitrary decimal from posing as a state-source version. */
declare const stateVersionBrand: unique symbol;

/** A canonical monotonic decimal within one state source and epoch. */
export type StateVersion = string & {
  /** Carries compile-time evidence of state-version admission. */
  readonly [stateVersionBrand]: true;
};

/** Captures current state together with its comparison scope and version. */
export type VersionedSnapshot<State> = Readonly<{
  /** Names the logical current-state source. */
  source: string;

  /** Identifies the source generation within which versions are comparable. */
  epoch: string;

  /** Orders state changes monotonically inside the source generation. */
  version: StateVersion;

  /** Carries the immutable current state. */
  snapshot: State;
}>;

/** Explains why an atomic attachment's latest-state lane ended. */
export type StateUpdateClose =
  | Readonly<{
      /** Reports normal source completion. */
      kind: 'completed';

      /** Identifies the final source generation. */
      epoch: string;

      /** Identifies the final state version. */
      version: StateVersion;
    }>
  | Readonly<{
      /** Reports explicit atomic attachment detachment. */
      kind: 'detached';

      /** Identifies the generation current at detachment. */
      epoch: string;

      /** Identifies the version current at detachment. */
      version: StateVersion;
    }>
  | Readonly<{
      /** Reports a state-source protocol failure. */
      kind: 'failed';

      /** Carries bounded public evidence of the violation. */
      failure: ProtocolFailure;
    }>;

/** Owns the coalescing current-state lane of an atomic live attachment. */
export interface StateUpdateSubscription<State> extends AsyncIterable<VersionedSnapshot<State>>, AsyncDisposable {
  /** Settles with the final version or protocol failure for this attachment. */
  readonly closed: Promise<StateUpdateClose>;

  /** Detaches only this state lane and returns its terminal evidence. */
  close(): Promise<StateUpdateClose>;
}

/** The race-free seed captured after all requested queues attach. */
export type LiveStateSeed<
  State,
  Source extends string,
  Cursor extends StreamCursor<Source>,
  Transient extends Readonly<Record<string, unknown>>,
> = Readonly<{
  /** Captures current state at the attachment barrier. */
  state: VersionedSnapshot<State>;

  /** Identifies the durable point consistent with the captured state. */
  durable?: Readonly<{
    /** Names the durable source family. */
    source: Source;

    /** Resumes strictly after the seed-consistent durable observation. */
    at: Cursor;
  }>;

  /** Captures every requested transient source generation at the same barrier. */
  transient: Readonly<{
    [Plane in keyof Transient]: Readonly<{
      /** Names this transient plane's logical source. */
      source: string;

      /** Identifies this transient plane's current generation. */
      epoch: string;
    }>;
  }>;
}>;

/** Selects the durable and transient queues included in an atomic attachment. */
export type LiveAttachmentOptions<
  Cursor extends StreamCursor<string>,
  Transient extends Readonly<Record<string, unknown>>,
  Planes extends keyof Transient = keyof Transient,
> = Readonly<{
  /** Configures durable delivery when the source exposes durable observations. */
  durable?: [Cursor] extends [never] ? never : ReplayDeliveryOptions<Cursor>;

  /** Selects and configures exactly the named transient planes a transport needs. */
  transient?: Readonly<Record<Planes, TransientDeliveryOptions>>;
}>;

/** Explains coordinated detachment of one atomic state-and-event bridge. */
export type LiveAttachmentCloseEvidence = Readonly<{
  /** Identifies the only terminal state of an attachment owner. */
  kind: 'detached';
}>;

/** Owns a race-free state seed and its coordinated event attachments. */
export interface AtomicLiveAttachment<
  State,
  Source extends string,
  Cursor extends StreamCursor<Source>,
  DurableEvent,
  Transient extends Readonly<Record<string, unknown>>,
> extends OwnedHandle<LiveAttachmentCloseEvidence> {
  /** Carries the one state-and-cursor barrier captured during attachment. */
  readonly seed: LiveStateSeed<State, Source, Cursor, Transient>;

  /** Delivers only the latest version when state changes outrun a consumer. */
  readonly stateUpdates: StateUpdateSubscription<State>;

  /** Delivers durable observations when this handle has a durable plane. */
  readonly durable: [Cursor] extends [never]
    ? undefined
    : EventSubscription<ReplayableEvent<DurableEvent, Cursor>, ReplayStreamClose<Cursor>, 'resume-required' | 'detach'>;

  /** Delivers each requested non-authoritative plane independently. */
  readonly transient: Readonly<{
    [Plane in keyof Transient]: EventSubscription<
      TransientDelivery<Transient[Plane]>,
      TransientStreamClose,
      'gap' | 'detach'
    >;
  }>;
}

/** Creates atomic state-and-event attachments without starting source work. */
export interface AtomicLiveAttachmentSource<
  State,
  Source extends string,
  Cursor extends StreamCursor<Source>,
  DurableEvent,
  Transient extends Readonly<Record<string, unknown>>,
> {
  /** Attaches queues before capturing and returning their consistent seed. */
  attachLive<const Planes extends keyof Transient = keyof Transient>(
    options?: LiveAttachmentOptions<Cursor, Transient, Planes>,
  ): Promise<AtomicLiveAttachment<State, Source, Cursor, DurableEvent, Pick<Transient, Planes>>>;
}

/** Requests active termination of one finite attempt. */
export type AttemptAbortCommand = Readonly<{
  /** Records bounded operator context for the abort request. */
  reason: string;

  /** Makes retries of the same abort command idempotent. */
  idempotencyKey: IdempotencyKey;
}>;

/** Terminal adapter classification after an accepted abort signal. */
export type AttemptAbortDisposition =
  | Readonly<{
      /** Proves the finite attempt reached one tagged terminal result. */
      kind: 'attempt-settled';

      /** Distinguishes an aborted result from work that won the abort race. */
      outcome: 'aborted' | 'completed';
    }>
  | Readonly<{
      /** Reports that terminal cleanup could not be proved. */
      kind: 'cleanup-unproved';

      /** Carries bounded public evidence rather than an adapter Error. */
      failure: PublicError;
    }>;

/** Proves the terminal result of one idempotent finite-attempt abort command. */
export type AttemptAbortEvidence =
  | (AttemptAbortDisposition &
      Readonly<{
        /** Echoes the accepted command identity for idempotent retries. */
        idempotencyKey: IdempotencyKey;
      }>)
  | Readonly<{
      /** Reports that the attempt was already terminal before this command. */
      kind: 'already-settled';

      /** Echoes the command identity used for this late request. */
      idempotencyKey: IdempotencyKey;
    }>;

/** Owns one finite admitted attempt with shared hot progress and explicit abort. */
export interface LiveOperation<Event, Result, CloseEvidence> extends OwnedHandle<CloseEvidence> {
  /** Exposes bounded non-authoritative progress for the existing attempt. */
  readonly events: TransientEventStream<Event>;

  /** Settles exactly once after progress acceptance has stopped. */
  readonly result: Promise<Result>;

  /** Requests attempt termination without aliasing observation close. */
  abort(command: AttemptAbortCommand): Promise<AttemptAbortEvidence>;
}
