/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Implements storage-neutral Cell activation over the shared reactive core.
 *
 * SQLite and S3 supply atomic records; this runtime owns acknowledgement,
 * revision checks, leases, fencing, wakes, effect redrive, and public streams.
 */

import { createHash } from 'node:crypto';

import type { AuthorityBroker, GrantRef } from '../authority/contracts.js';
import type { DiagnosticHub, DiagnosticSpan } from '../diagnostics/contracts.js';
import { IdempotencyKeySchema, toPublicError, type PublicError } from '../protocol.js';
import {
  asReplayableEventStream,
  asTransientEventStream,
  createAtomicLiveAttachmentSource,
  createReplayableEventSource,
  createTransientEventSource,
  createVersionedLiveState,
  type ReplayableEventSource,
  type TransientEventSource,
  type VersionedLiveStateSource,
} from '../stream/index.js';
import {
  CanonicalDecimalSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  type JsonObject,
  type JsonValue,
  type Timestamp,
} from '../values.js';
import {
  CellEffectIdSchema,
  CellError,
  CellIdSchema,
  CellSequenceSchema,
  FenceEpochSchema,
  type Acknowledgement,
  type AcknowledgedEffectAttempt,
  type CellAction,
  type CellAttachAction,
  type CellAttachOutcome,
  type CellAttachRequest,
  type CellClock,
  type CellCreateAction,
  type CellCreateOutcome,
  type CellCreateRequest,
  type CellDispatchAction,
  type CellDispatchOutcome,
  type CellDurability,
  type CellHandle,
  type CellHandleSnapshot,
  type CellHost,
  type CellHostBaseOptions,
  type CellHostCloseEvidence,
  type CellObservation,
  type CellProtocol,
  type CellReadAction,
  type CellReleaseEvidence,
  type CellScheduler,
  type CellStateReadOutcome,
  type CellStateReadRequest,
} from './contracts.js';
import { bindCellProtocol, cellEffectId, compareCellProtocol } from './model.js';
import type {
  CellStore,
  StoredCellEffect,
  StoredCellObservation,
  StoredCellReceipt,
  StoredCellRecord,
  StoredCellVersion,
} from './storage.js';

/** Defaults one active ownership lease to thirty seconds. */
const DEFAULT_LEASE_MILLISECONDS = 30_000;

/** Retains enough history for ordinary UI reconnects without claiming an archive. */
const DEFAULT_OBSERVATION_RETENTION = 2_048;

/** UTF-8 encoder measures public observations and hashes canonical identities. */
const TEXT_ENCODER = new TextEncoder();

/** Runtime construction resolved once for one first-party CellHost. */
type CellRuntimeOptions = Readonly<{
  /** Public host configuration shared across adapter products. */
  base: CellHostBaseOptions;

  /** Exact acknowledgement and recovery claim published by the adapter. */
  durability: CellDurability;

  /** Atomic storage implementation owned by this host runtime. */
  store: CellStore;
}>;

/** Host-owned activation exposed only through its generic public handle. */
interface ManagedActivation {
  /** Settles after overdue durable wake recovery completes. */
  ready(): Promise<void>;

  /** Releases the activation and its process-local work. */
  close(): Promise<CellReleaseEvidence>;
}

/**
 * Schedules native timers without exposing their handle type publicly.
 * @param delayMilliseconds - Non-negative delay selected by lease and wake policy.
 * @param task - Serialized activation callback to admit when the timer fires.
 * @returns Cancellation capability for the one scheduled timer.
 */
function systemCellScheduler(delayMilliseconds: number, task: () => void): () => void {
  /** Holds the platform timer strictly inside the scheduler adapter. */
  const timer = setTimeout(task, delayMilliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Reads host wall time only when construction does not inject a clock.
 * @returns Current platform wall-clock instant.
 */
function systemCellClock(): Date {
  return new Date();
}

/**
 * Generates activation and abort UUIDv4 identities through the host platform.
 * @returns Fresh platform-generated UUIDv4 text.
 */
function systemCellId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Normalizes one trusted Cell clock read to canonical UTC milliseconds.
 * @param now - Host-owned trusted clock capability.
 * @returns Canonical immutable timestamp text.
 */
function cellTimestamp(now: CellClock): Timestamp {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Adds a safe millisecond interval to one trusted instant.
 * @param timestamp - Canonical lease or acknowledgement instant.
 * @param milliseconds - Positive safe integer interval.
 * @returns Canonical UTC lease boundary.
 */
function addMilliseconds(timestamp: Timestamp, milliseconds: number): Timestamp {
  return TimestampSchema.parse(new Date(Date.parse(timestamp) + milliseconds).toISOString());
}

/**
 * Encodes arbitrary Cell bytes for JSON-safe persistence.
 * @param bytes - Canonical codec bytes.
 * @returns Base64 text copied from the supplied bytes.
 */
function storeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Restores fresh bytes from JSON-safe persistence text.
 * @param value - Base64 payload admitted from a CellStore.
 * @returns Fresh byte array with no alias to storage transport buffers.
 */
function restoreBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

/**
 * Hashes one canonical identity without retaining private event or state bytes.
 * @param parts - Exact byte and text components in semantic order.
 * @returns Algorithm-prefixed SHA-256 digest.
 */
function digest(parts: readonly (string | Uint8Array)[]): string {
  /** Length-prefixes each component so concatenation cannot collide structurally. */
  const hash = createHash('sha256');
  /** Adds every semantic identity part in caller-specified order. */
  for (const part of parts) {
    /** Converts text identity to stable UTF-8 before length framing. */
    const bytes = typeof part === 'string' ? TEXT_ENCODER.encode(part) : part;
    hash.update(String(bytes.byteLength));
    hash.update(':');
    hash.update(bytes);
  }
  return Sha256DigestSchema.parse(`sha256:${hash.digest('hex')}`);
}

/**
 * Advances one arbitrary-precision canonical decimal.
 * @param value - Current non-negative canonical decimal.
 * @param amount - Small non-negative increment.
 * @returns Exact next canonical decimal without Number truncation.
 */
function advanceDecimal(value: string, amount = 1): string {
  return CanonicalDecimalSchema.parse((BigInt(value) + BigInt(amount)).toString(10));
}

/**
 * Checks whether the selected host satisfies a protocol's failure boundary.
 * @param durability - Exact first-party host guarantee.
 * @param protocol - Protocol durability requirement.
 * @returns Whether acknowledgement survives the requested failure domain.
 */
function supportsDurability(
  durability: CellDurability,
  protocol: CellProtocol<unknown, unknown, unknown, unknown>,
): boolean {
  return protocol.durability.type === 'same-filesystem' || durability.persistence === 'node-independent';
}

/**
 * Converts a restored stored observation to its public generic form.
 * @param cellId - Cell identity omitted from its storage-local observation rows.
 * @param stored - Durable storage representation.
 * @param protocol - Exact codec needed to restore event values.
 * @returns Frozen public observation or a decoding Error.
 */
function restoreObservation<State, StateView, Event, Effect>(
  cellId: import('./contracts.js').CellId,
  stored: StoredCellObservation,
  protocol: CellProtocol<State, StateView, Event, Effect>,
): CellObservation<Event> {
  if (stored.kind === 'event-acknowledged') {
    /** Re-admits durable event bytes before publication. */
    const event = protocol.codecs.event.decode(restoreBytes(stored.event));
    if (!event.ok) throw event.error;
    return Object.freeze({
      kind: stored.kind,
      cellId,
      sequence: CellSequenceSchema.parse(stored.sequence),
      fence: FenceEpochSchema.parse(stored.fence),
      event: event.value,
      effects: Object.freeze(stored.effects.map((id) => CellEffectIdSchema.parse(id))),
      acknowledgedAt: stored.at,
    });
  }
  if (stored.kind === 'effect-attempt-claimed') {
    return Object.freeze({
      kind: stored.kind,
      cellId,
      effectId: CellEffectIdSchema.parse(stored.effectId),
      attempt: stored.attempt,
      fence: FenceEpochSchema.parse(stored.fence),
      claimedAt: stored.at,
    });
  }
  return Object.freeze({
    kind: stored.kind,
    cellId,
    effectId: CellEffectIdSchema.parse(stored.effectId),
    attempt: stored.attempt,
    failure: stored.failure as PublicError,
    failedAt: stored.at,
  });
}

/**
 * Begins one best-effort wide Cell operation span.
 * @param diagnostics - Optional borrowed observation capability.
 * @param name - Stable operation name.
 * @param hostId - Low-cardinality host correlation identity.
 * @param cellId - Optional durable Cell correlation identity.
 * @returns Open span or absence when diagnostics fail.
 */
function beginCellSpan(
  diagnostics: Pick<DiagnosticHub, 'beginSpan'> | undefined,
  name: string,
  hostId: import('./contracts.js').CellHostId,
  cellId?: import('./contracts.js').CellId,
): DiagnosticSpan | undefined {
  if (diagnostics === undefined) return undefined;
  try {
    return diagnostics.beginSpan({
      name,
      component: 'core.cells',
      correlation: { ...(cellId === undefined ? {} : { cellId }) },
      attributes: { cell: { operation: name, hostId } },
    });
  } catch {
    return undefined;
  }
}

/**
 * Completes one best-effort Cell span without influencing its domain result.
 * @param span - Optional span produced at operation admission.
 * @param outcome - Stable tagged result branch.
 * @param attributes - Bounded terminal facts without state or event bytes.
 */
function completeCellSpan(span: DiagnosticSpan | undefined, outcome: string, attributes: JsonObject = {}): void {
  if (span === undefined) return;
  try {
    span.enrich('cell.result', { outcome, ...attributes });
    span.complete({ outcome });
  } catch {
    // Diagnostics remain non-authoritative over acknowledgement and refusal.
  }
}

/**
 * Fails one best-effort Cell span without replacing its exact implementation Error.
 * @param span - Optional span produced at operation admission.
 * @param error - Error that continues to the host's unavailable branch.
 */
function failCellSpan(span: DiagnosticSpan | undefined, error: unknown): void {
  if (span === undefined) return;
  try {
    span.fail({
      outcome: 'failed',
      error: toPublicError(error, { code: 'cell_operation_failed', message: 'Cell operation failed' }),
    });
  } catch {
    // Diagnostics remain best effort while the storage failure continues.
  }
}

/** Serializes asynchronous mutations for one active Cell. */
class CellCommandQueue {
  /** Retains the tail whether the preceding operation fulfilled or rejected. */
  #tail: Promise<void> = Promise.resolve();

  /**
   * Executes one operation after all previously admitted Cell work settles.
   * @param operation - Mutation or renewal that may reject independently.
   * @returns Exact operation settlement.
   */
  run<Value>(operation: () => Promise<Value>): Promise<Value> {
    /** Begins after both fulfillment and rejection of the prior operation. */
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Process-local transient planes exposed by one Cell attachment. */
type CellActivityPlanes<Progress extends JsonValue> = Readonly<{
  /** Carries lossy effect progress that never changes acknowledged state. */
  activity: import('./contracts.js').CellActivityEvent<Progress>;
}>;

/** Complete dependency set needed to construct one already-owned activation. */
type CellActivationInput<State, StateView, Event, Effect, Progress extends JsonValue> = Readonly<{
  /** Current durable record and compare-and-swap token. */
  current: StoredCellVersion;

  /** Reachable durable observations restored before publication. */
  history: readonly StoredCellObservation[];

  /** Exact pure behavior and codec revisions bound to stored bytes. */
  protocol: CellProtocol<State, StateView, Event, Effect>;

  /** Optional process-local external effect executor. */
  activation?: import('./contracts.js').CellActivationOptions<Effect, Event, Progress>;

  /** Exact persistence guarantee published by the selected host. */
  durability: CellDurability;

  /** Host identity included in Authority scope and diagnostics. */
  hostId: import('./contracts.js').CellHostId;

  /** Atomic persistence implementation backing this activation. */
  store: CellStore;

  /** Current-verification Authority broker borrowed from the host. */
  authority: AuthorityBroker<CellAction>;

  /** Process owner persisted in the already-acquired lease. */
  ownerId: string;

  /** Trusted clock selected at host construction. */
  now: CellClock;

  /** Timer boundary selected at host construction. */
  schedule: CellScheduler;

  /** Positive lease interval shared by acquisition and renewal. */
  leaseMilliseconds: number;

  /** Bounded in-process durable-observation replay window. */
  observationRetentionItems: number;

  /** Optional best-effort diagnostic span producer. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;

  /** Removes this exact activation from the host registry after release. */
  onReleased: () => void;
}>;

/** One retained active Cell over a storage-neutral record. */
class CellActivation<State, StateView, Event, Effect, Progress extends JsonValue>
  implements CellHandle<StateView, Event, Progress>, ManagedActivation
{
  /** Public identity of the durable Program instance. */
  readonly cellId: import('./contracts.js').CellId;

  /** Exact host guarantee backing this activation's acknowledgements. */
  readonly durability: CellDurability;

  /** Host identity used by every protected action and diagnostic correlation. */
  readonly #cellHostId: import('./contracts.js').CellHostId;

  /** Public replay-only view of acknowledged observations. */
  readonly durableEvents: import('../stream/contracts.js').ReplayableEventStream<
    CellObservation<Event>,
    import('./contracts.js').CellCursor
  >;

  /** Public transient-only view of live adapter progress. */
  readonly activityEvents: import('../stream/contracts.js').TransientEventStream<
    import('./contracts.js').CellActivityEvent<Progress>
  >;

  /** Stable retained release settlement visible before close starts. */
  readonly closed: Promise<CellReleaseEvidence>;

  /** Serial startup barrier for overdue wake recovery. */
  readonly #startup: Promise<void>;

  /** Host storage borrowed for the lifetime of this activation. */
  readonly #store: CellStore;

  /** Exact protocol admitted during create or attach. */
  readonly #protocol: CellProtocol<State, StateView, Event, Effect>;

  /** Optional process-local effect execution capability. */
  readonly #effects: import('./contracts.js').CellEffectAdapter<Effect, Event, Progress> | undefined;

  /** Current authority broker borrowed from the host. */
  readonly #authority: AuthorityBroker<CellAction>;

  /** Trusted clock shared with host construction. */
  readonly #now: CellClock;

  /** Timer adapter shared with host construction. */
  readonly #schedule: CellScheduler;

  /** Configured lease interval in safe integer milliseconds. */
  readonly #leaseMilliseconds: number;

  /** Process identity bound into the current stored lease. */
  readonly #ownerId: string;

  /** Best-effort wide diagnostic producer borrowed from the host. */
  readonly #diagnostics: Pick<DiagnosticHub, 'beginSpan'> | undefined;

  /** Notifies the host registry after retained release settles. */
  readonly #onReleased: () => void;

  /** Serializes commands, renewal, wake, effect claims, and settlement. */
  readonly #queue = new CellCommandQueue();

  /** Owns current state publication independently of durable event replay. */
  readonly #state: VersionedLiveStateSource<CellHandleSnapshot<StateView>>;

  /** Owns hydrated durable observations and future commit publication. */
  readonly #durable: ReplayableEventSource<CellObservation<Event>, 'cell'>;

  /** Owns lossy live effect activity. */
  readonly #activity: TransientEventSource<import('./contracts.js').CellActivityEvent<Progress>>;

  /** Owns race-free state, durable, and transient attachment construction. */
  readonly #attachments: import('../stream/contracts.js').AtomicLiveAttachmentSource<
    CellHandleSnapshot<StateView>,
    'cell',
    import('./contracts.js').CellCursor,
    CellObservation<Event>,
    CellActivityPlanes<Progress>
  >;

  /** Resolves stable release evidence once. */
  #settleClosed: ((evidence: CellReleaseEvidence) => void) | undefined;

  /** Rejects retained release observation with the same failure as active close. */
  #rejectClosed: ((reason: unknown) => void) | undefined;

  /** Retains one idempotent release operation. */
  #closePromise: Promise<CellReleaseEvidence> | undefined;

  /** Cancels the currently scheduled renewal or wake callback. */
  #cancelSchedule: (() => void) | undefined;

  /** Current store token and record updated only inside the command queue. */
  #current: StoredCellVersion;

  /** Active finite attempts keyed by deterministic effect identity. */
  readonly #operations = new Map<
    string,
    import('../stream/contracts.js').LiveOperation<
      Progress,
      import('./contracts.js').CellEffectResult<Event>,
      import('./contracts.js').CellEffectAttemptCloseEvidence
    >
  >();

  /** Prevents post-release dispatch, renewal, wake, and publication. */
  #released = false;

  /**
   * Constructs a hot activation only after storage ownership is durable.
   * @param input - Current record, restored observations, protocol, and host capabilities.
   */
  constructor(input: CellActivationInput<State, StateView, Event, Effect, Progress>) {
    this.cellId = CellIdSchema.parse(input.current.record.cellId);
    this.durability = input.durability;
    this.#cellHostId = input.hostId;
    this.#store = input.store;
    this.#protocol = input.protocol;
    this.#effects = input.activation?.effects;
    this.#authority = input.authority;
    this.#ownerId = input.ownerId;
    this.#now = input.now;
    this.#schedule = input.schedule;
    this.#leaseMilliseconds = input.leaseMilliseconds;
    this.#diagnostics = input.diagnostics;
    this.#onReleased = input.onReleased;
    this.#current = input.current;

    /** Restores durable observations before any public subscriber can attach. */
    const restored = input.history.map((observation) => restoreObservation(this.cellId, observation, input.protocol));
    this.#durable = createReplayableEventSource({
      source: 'cell',
      scope: input.current.record.cellId,
      streamId: input.current.record.cellId,
      epoch: input.current.record.binding.protocol,
      retentionItems: input.observationRetentionItems,
      initialEvents: restored,
      eventEncoding: {
        revision: 'archer-cell-observation/1',
        /**
         * Copies the already immutable durable observation into source ownership.
         * @param event - Restored generic Cell observation.
         * @returns Frozen event retained by the replay source.
         */
        normalize(event) {
          return Object.freeze(event);
        },
        /**
         * Measures exact JSON presentation bytes for replay retention.
         * @param event - Source-owned generic Cell observation.
         * @returns Encoded JSON byte length.
         */
        measure(event) {
          return TEXT_ENCODER.encode(JSON.stringify(event)).byteLength;
        },
      },
    });
    this.#activity = createTransientEventSource({
      source: 'cell-activity',
      epoch: `${input.current.record.cellId}:${input.current.record.lease.fence}`,
      eventEncoding: {
        revision: 'archer-cell-activity/1',
        /**
         * Copies transient adapter progress before fan-out.
         * @param event - Adapter progress admitted by the activation contract.
         * @returns Frozen progress event retained by the transient source.
         */
        normalize(event) {
          return Object.freeze(event);
        },
        /**
         * Measures exact JSON presentation bytes for transient queue bounds.
         * @param event - Source-owned adapter progress event.
         * @returns Encoded JSON byte length.
         */
        measure(event) {
          return TEXT_ENCODER.encode(JSON.stringify(event)).byteLength;
        },
      },
    });
    this.#state = createVersionedLiveState(this.#snapshot('active'), {
      source: 'cell-state',
      epoch: `${input.current.record.cellId}:${input.current.record.lease.fence}`,
    });
    this.#attachments = createAtomicLiveAttachmentSource({
      state: this.#state,
      durable: this.#durable,
      transient: { activity: this.#activity },
    });
    this.durableEvents = asReplayableEventStream(this.#durable);
    this.activityEvents = asTransientEventStream(this.#activity);
    this.closed = new Promise(
      /**
       * Captures the only settlement pair for retained activation release evidence.
       * @param resolve - Native Promise resolver retained until release settles.
       * @param reject - Native Promise rejector retained when cleanup cannot settle evidence.
       */
      (resolve, reject) => {
        this.#settleClosed = resolve;
        this.#rejectClosed = reject;
      },
    );

    this.#scheduleNext();
    this.#startup = this.#queue.run(() => this.#runDueWake());
    /** Startup redrive stays detached from handle admission but never leaks a rejected Promise. */
    void this.#startup
      .then(() => this.#queue.run(() => this.#redriveEffects()))
      .catch(
        /**
         * Treats unexpected recovery failure as loss of safe local mutation authority.
         * @param error - Unexpected startup recovery rejection.
         * @returns Nothing after diagnosing and fencing the activation.
         */
        (error: unknown) => this.#failBackground('cell.startup-recovery', error, true),
      );
  }

  /**
   * Waits only for deterministic overdue wake recovery, never for external effects.
   * @returns Startup settlement after any due durable wake is acknowledged.
   */
  ready(): Promise<void> {
    return this.#startup;
  }

  /**
   * Returns stable current state identity until the next acknowledged publication.
   * @returns Current immutable activation snapshot.
   */
  getSnapshot(): CellHandleSnapshot<StateView> {
    return this.#state.getSnapshot();
  }

  /**
   * Attaches a deferred current-state listener without starting Cell work.
   * @param listener - Consumer callback notified after later snapshot changes.
   * @returns Idempotent listener detachment capability.
   */
  subscribe(listener: (snapshot: CellHandleSnapshot<StateView>) => void): () => void {
    return this.#state.subscribe(listener);
  }

  /**
   * Constructs a race-free live state and event attachment.
   * @param options - Replay cursor and optional transient-plane selection.
   * @returns Atomic state seed and selected event subscriptions.
   */
  attachLive<const Planes extends 'activity' = 'activity'>(
    options?: import('../stream/contracts.js').LiveAttachmentOptions<
      import('./contracts.js').CellCursor,
      CellActivityPlanes<Progress>,
      Planes
    >,
  ) {
    return this.#attachments.attachLive(options);
  }

  /**
   * Offers one authorized event and waits for its complete durable decision.
   * @param command - Subject, event, and exact retry identity.
   * @param grant - Current action-specific authority reference.
   * @returns Acknowledgement, refusal, current denial, or unavailability.
   */
  async dispatch(
    command: import('./contracts.js').CellCommand<Event>,
    grant: GrantRef<CellDispatchAction>,
  ): Promise<CellDispatchOutcome> {
    /** Accumulates one wide operation record around authority and settlement. */
    const span = beginCellSpan(this.#diagnostics, 'cell.dispatch', this.#hostId(), this.cellId);
    try {
      /** Checks current authority before event encoding or Program execution. */
      const authority = await this.#authority.verify<CellDispatchAction>({
        grant,
        subject: command.subject,
        scope: { kind: 'cell', hostId: this.#hostId(), cellId: this.cellId },
      });
      if (!authority.allowed) {
        completeCellSpan(span, 'authority-refused', { reason: authority.refusal.reason });
        return Object.freeze({ kind: 'authority-refused', refusal: authority.refusal });
      }
      /** Serializes the durable mutation with renewal, wake, and effect settlement. */
      const outcome = await this.#queue.run(() =>
        this.#applyEvent(command.event, command.subject, command.idempotencyKey),
      );
      completeCellSpan(span, outcome.kind, outcome.kind === 'refused' ? { reason: outcome.reason } : {});
      return outcome;
    } catch (error) {
      failCellSpan(span, error);
      return Object.freeze({
        kind: 'unavailable',
        failure: toPublicError(error, { code: 'cell_dispatch_unavailable', message: 'Cell dispatch is unavailable' }),
      });
    }
  }

  /**
   * Releases ownership, aborts process-local attempts, and closes hot sources once.
   * @returns Shared retained release settlement.
   */
  close(): Promise<CellReleaseEvidence> {
    this.#closePromise ??= this.#queue.run(
      /**
       * Performs the only serialized release mutation and source shutdown.
       * @returns Stable release evidence shared by all close callers.
       */
      async () => {
        this.#released = true;
        this.#cancelSchedule?.();
        this.#cancelSchedule = undefined;

        /** Requests cleanup for every attempt without treating source close as cancellation. */
        await Promise.all(
          [...this.#operations.values()].map(
            /**
             * Requests abort and then retains each operation's cleanup evidence.
             * @param operation - Active finite effect attempt owned by this activation.
             * @returns Settlement after abort admission and cleanup.
             */
            async (operation) => {
              await operation.abort({
                reason: 'Cell activation released',
                idempotencyKey: IdempotencyKeySchema.parse(systemCellId()),
              });
              await operation.close();
            },
          ),
        );
        this.#operations.clear();

        /** Expires the lease only if storage still recognizes this exact owner and fence. */
        const loaded = await this.#store.read(this.cellId);
        /** Falls back to fenced whenever lease release loses its storage race. */
        let disposition: CellReleaseEvidence['disposition'] = 'released';
        if (
          loaded !== undefined &&
          loaded.record.lease.ownerId === this.#ownerId &&
          loaded.record.lease.fence === this.#current.record.lease.fence
        ) {
          /** Makes orderly release immediately acquirable without deleting durable state. */
          const releasedRecord = Object.freeze({
            ...loaded.record,
            lease: Object.freeze({ ...loaded.record.lease, expiresAt: cellTimestamp(this.#now) }),
          });
          /** Conditional lease expiry cannot overwrite a newer owner. */
          const committed = await this.#store.commit(this.cellId, loaded.token, releasedRecord, []);
          if (committed.kind === 'committed') this.#current = committed.current;
          else disposition = 'fenced';
        } else {
          disposition = 'fenced';
        }

        /** Publishes terminal local lifecycle before completing each borrowed source. */
        this.#state.publish(this.#snapshot(disposition === 'fenced' ? 'fenced' : 'released'));
        await Promise.all([this.#state.close(), this.#durable.close(), this.#activity.close()]);
        /** Stable evidence settles both close and the retained closed Promise. */
        const evidence = Object.freeze({
          kind: 'cell-released' as const,
          cellId: this.cellId,
          fence: FenceEpochSchema.parse(this.#current.record.lease.fence),
          disposition,
        });
        this.#settleClosed?.(evidence);
        this.#onReleased();
        return evidence;
      },
    );
    /** Retained closure must reject with the exact cleanup failure returned by close. */
    void this.#closePromise.catch(
      /**
       * Settles retained lifecycle observation without replacing the cleanup failure.
       * @param error - Exact rejection returned by the active close operation.
       * @returns Nothing after rejecting the retained closed Promise.
       */
      (error: unknown) => this.#rejectClosed?.(error),
    );
    return this.#closePromise;
  }

  /** Delegates standard asynchronous disposal to idempotent release. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Resolves the host identity from the authority scope captured by construction.
   * @returns Exact host identity used by protected operations.
   */
  #hostId(): import('./contracts.js').CellHostId {
    return this.#cellHostId;
  }

  /**
   * Projects a fresh bounded state snapshot from current durable bytes.
   * @param lifecycle - Local handle status selected by the caller.
   * @returns Immutable hot state with a cursor consistent with current history.
   */
  #snapshot(lifecycle: 'active' | 'fenced' | 'released'): CellHandleSnapshot<StateView> {
    /** Re-admits canonical state before pure projection. */
    const state = this.#protocol.codecs.state.decode(restoreBytes(this.#current.record.state));
    if (!state.ok) throw state.error;
    /** Applies the explicit projection and round-trips its bounded codec. */
    const projected = this.#protocol.projectState(state.value);
    /** Canonical projected bytes prove the public view remains bounded and valid. */
    const encodedView = this.#protocol.codecs.stateView.encode(projected);
    if (!encodedView.ok) throw encodedView.error;
    /** Re-admitted view severs aliases to pure projection output. */
    const view = this.#protocol.codecs.stateView.decode(encodedView.value);
    if (!view.ok) throw view.error;
    return Object.freeze({
      cellId: this.cellId,
      acknowledged: Object.freeze({
        sequence: CellSequenceSchema.parse(this.#current.record.sequence),
        cursor: this.#durable.currentCursor(),
        fence: FenceEpochSchema.parse(this.#current.record.lease.fence),
        state: view.value,
      }),
      lifecycle:
        lifecycle === 'active'
          ? Object.freeze({ status: 'active' as const, leaseExpiresAt: this.#current.record.lease.expiresAt })
          : lifecycle === 'fenced'
            ? Object.freeze({
                status: 'fenced' as const,
                fence: FenceEpochSchema.parse(this.#current.record.lease.fence),
              })
            : Object.freeze({ status: 'released' as const }),
    });
  }

  /**
   * Applies one caller or effect-result event as a complete atomic decision.
   * @param candidate - Event value offered to the protocol codec.
   * @param subject - Caller subject for idempotency identity, absent for internal effects and wakes.
   * @param idempotencyKey - External command retry identity when one exists.
   * @param settlesEffectId - Effect marked complete in the same resulting acknowledgement.
   * @returns Exact dispatch outcome after publication.
   */
  async #applyEvent(
    candidate: Event,
    subject?: import('../authority/contracts.js').PrincipalId,
    idempotencyKey?: import('../protocol.js').IdempotencyKey,
    settlesEffectId?: string,
  ): Promise<CellDispatchOutcome> {
    if (this.#released) return Object.freeze({ kind: 'refused', reason: 'closed' });

    /** Reloads current storage evidence before trusting the process-local fence. */
    const loaded = await this.#store.read(this.cellId);
    if (
      loaded === undefined ||
      loaded.record.lease.ownerId !== this.#ownerId ||
      loaded.record.lease.fence !== this.#current.record.lease.fence ||
      Date.parse(loaded.record.lease.expiresAt) <= this.#now().getTime()
    ) {
      this.#fence(loaded);
      return Object.freeze({ kind: 'refused', reason: 'fenced' });
    }
    this.#current = loaded;

    /** Owns and validates canonical event bytes before Program execution. */
    const eventBytes = this.#protocol.codecs.event.encode(candidate);
    if (!eventBytes.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-event' });
    /** Restores a fresh canonical event value for deterministic Program input. */
    const event = this.#protocol.codecs.event.decode(eventBytes.value);
    if (!event.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-event' });

    /** Detects exact external retries before reducing acknowledged state. */
    const fingerprint =
      subject === undefined
        ? undefined
        : digest([subject, eventBytes.value, bindCellProtocol(this.#protocol).protocol]);
    if (idempotencyKey !== undefined) {
      /** Finds prior settlement for this exact external command identity. */
      const receipt = loaded.record.receipts.find(
        /**
         * Matches one retained receipt by its package-owned key.
         * @param item - Previously acknowledged external command receipt.
         * @returns Whether the receipt settles the current command identity.
         */
        (item) => item.key === idempotencyKey,
      );
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint)
          return Object.freeze({ kind: 'refused', reason: 'idempotency-conflict' });
        /** Reconstructs the prior acknowledgement without rerunning the Program. */
        const acknowledgement: Acknowledgement = Object.freeze({
          cellId: this.cellId,
          sequence: CellSequenceSchema.parse(receipt.sequence),
          cursor: this.#durable.cursorCodec.encode(CanonicalDecimalSchema.parse(receipt.cursorOffset)),
          fence: FenceEpochSchema.parse(receipt.fence),
          stateDigest: Sha256DigestSchema.parse(receipt.stateDigest),
          replayed: true,
        });
        return Object.freeze({ kind: 'acknowledged', acknowledgement });
      }
    }

    /** Reconstructs fresh acknowledged state before deterministic reduction. */
    const state = this.#protocol.codecs.state.decode(restoreBytes(loaded.record.state));
    if (!state.ok) throw state.error;
    /** Holds the pure Program decision only after reducer execution succeeds. */
    let decision: import('../program.js').ProgramDecision<State, Effect>;
    try {
      decision = this.#protocol.program.reduce(state.value, event.value);
    } catch {
      return Object.freeze({ kind: 'refused', reason: 'invalid-decision' });
    }

    /** Round-trips proposed state so acknowledgement never retains an invalid reducer value. */
    const nextState = this.#protocol.codecs.state.encode(decision.state);
    if (!nextState.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-decision' });
    /** Re-admits the exact bytes that storage will later restore. */
    const restoredState = this.#protocol.codecs.state.decode(nextState.value);
    if (!restoredState.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-decision' });

    /** Advances Program order once regardless of storage-only effect observations. */
    const sequence = advanceDecimal(loaded.record.sequence);
    /** Persists every effect before any adapter is allowed to start. */
    const effects: StoredCellEffect[] = [];
    /** Encodes each effect with its stable decision-relative position. */
    for (const [position, effect] of decision.effects.entries()) {
      /** Canonical durable bytes must exist before effect identity publication. */
      const encoded = this.#protocol.codecs.effect.encode(effect);
      if (!encoded.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-decision' });
      effects.push(
        Object.freeze({
          id: cellEffectId(this.cellId, CellSequenceSchema.parse(sequence), position),
          causedBy: sequence,
          position,
          bytes: storeBytes(encoded.value),
          status: 'pending',
          attempt: 0,
        }),
      );
    }

    /** Encodes a wake derived only from the acknowledged next state. */
    const projectedWake = this.#protocol.projectWake?.(restoredState.value);
    /** Optional canonical wake replaces rather than merges with prior timer intent. */
    let wake: StoredCellRecord['wake'];
    if (projectedWake !== undefined) {
      /** Canonical wake event bytes make scheduler recovery process-independent. */
      const wakeEvent = this.#protocol.codecs.event.encode(projectedWake.event);
      if (!wakeEvent.ok) return Object.freeze({ kind: 'refused', reason: 'invalid-decision' });
      wake = Object.freeze({ at: TimestampSchema.parse(projectedWake.at), event: storeBytes(wakeEvent.value) });
    }

    /** One event observation advances the durable cursor exactly once. */
    const observationOffset = advanceDecimal(loaded.record.observationCount);
    /** Trusted settlement instant shared by lease renewal and durable observation. */
    const acknowledgedAt = cellTimestamp(this.#now);
    /** Redacted state identity returned to callers without state bytes. */
    const stateDigest = digest([nextState.value]);
    /** Marks one settling effect complete in the same decision that accepts its result. */
    const priorEffects = loaded.record.effects.map(
      /**
       * Marks only the causative effect complete in the result-event transaction.
       * @param item - Previously acknowledged effect record.
       * @returns Original effect or a fresh completed replacement.
       */
      (item) => (item.id === settlesEffectId ? Object.freeze({ ...item, status: 'completed' as const }) : item),
    );
    /** Stores external retry evidence only after the exact outcome is known. */
    const receipt: StoredCellReceipt | undefined =
      idempotencyKey === undefined || fingerprint === undefined
        ? undefined
        : Object.freeze({
            key: idempotencyKey,
            fingerprint,
            sequence,
            cursorOffset: observationOffset,
            fence: loaded.record.lease.fence,
            stateDigest,
          });
    /** Rebuilds the required record fields so omission really clears a prior wake. */
    const recordWithoutWake: Omit<StoredCellRecord, 'wake'> = Object.freeze({
      cellId: loaded.record.cellId,
      binding: loaded.record.binding,
      creation: loaded.record.creation,
      sequence: loaded.record.sequence,
      observationCount: loaded.record.observationCount,
      state: loaded.record.state,
      lease: loaded.record.lease,
      receipts: loaded.record.receipts,
      effects: loaded.record.effects,
    });
    /** Complete successor record proposed to the atomic storage boundary. */
    const nextRecord: StoredCellRecord = Object.freeze({
      ...recordWithoutWake,
      sequence,
      observationCount: observationOffset,
      state: storeBytes(nextState.value),
      lease: Object.freeze({
        ...loaded.record.lease,
        expiresAt: addMilliseconds(acknowledgedAt, this.#leaseMilliseconds),
      }),
      receipts: Object.freeze(
        receipt === undefined ? [...loaded.record.receipts] : [...loaded.record.receipts, receipt],
      ),
      effects: Object.freeze([...priorEffects, ...effects]),
      ...(wake === undefined ? {} : { wake }),
    });
    /** Durable event evidence committed atomically with the successor record. */
    const storedObservation: StoredCellObservation = Object.freeze({
      kind: 'event-acknowledged',
      offset: observationOffset,
      sequence,
      fence: loaded.record.lease.fence,
      event: storeBytes(eventBytes.value),
      effects: Object.freeze(
        effects.map(
          /**
           * Projects acknowledged effect identities without retaining intent bytes twice.
           * @param item - Effect persisted by this decision.
           * @returns Deterministic public effect identity.
           */
          (item) => item.id,
        ),
      ),
      at: acknowledgedAt,
    });

    /** Storage CAS is the only acknowledgement boundary. */
    /** Capacity refusal is a deterministic preserved-state outcome, not storage unavailability. */
    let committed: import('./storage.js').CellStoreCommitOutcome;
    try {
      committed = await this.#store.commit(this.cellId, loaded.token, nextRecord, [storedObservation]);
    } catch (error) {
      if (error instanceof CellError && error.code === 'cell_capacity_exceeded') {
        return Object.freeze({ kind: 'refused', reason: 'capacity-exceeded' });
      }
      throw error;
    }
    if (committed.kind === 'conflict') {
      this.#fence(committed.current);
      return Object.freeze({ kind: 'refused', reason: 'fenced' });
    }
    this.#current = committed.current;
    /** Public generic observation decoded from the exact committed representation. */
    const publicObservation = restoreObservation(this.cellId, storedObservation, this.#protocol);
    /** Durable stream envelope supplies the cursor returned by acknowledgement. */
    const envelope = this.#durable.publish(publicObservation);
    this.#state.publish(this.#snapshot('active'));
    this.#scheduleNext();

    /** First-time acknowledgement exposes only redacted state identity and ordering evidence. */
    const acknowledgement: Acknowledgement = Object.freeze({
      cellId: this.cellId,
      sequence: CellSequenceSchema.parse(sequence),
      cursor: envelope.cursor,
      fence: FenceEpochSchema.parse(nextRecord.lease.fence),
      stateDigest: Sha256DigestSchema.parse(stateDigest),
      replayed: false,
    });
    queueMicrotask(
      /** Starts acknowledged effects after the dispatch outcome becomes observable to its caller. */
      () => {
        void this.#queue
          .run(() => this.#redriveEffects())
          .catch(
            /**
             * Treats a failed durable claim as loss of safe local mutation authority.
             * @param error - Unexpected effect-redrive rejection.
             * @returns Nothing after diagnosing and fencing the activation.
             */
            (error: unknown) => this.#failBackground('cell.effect-redrive', error, true),
          );
      },
    );
    return Object.freeze({ kind: 'acknowledged', acknowledgement });
  }

  /** Claims and starts every recoverable effect that has an available adapter. */
  async #redriveEffects(): Promise<void> {
    if (this.#released || this.#effects === undefined) return;
    /** Uses a snapshot because each claim replaces the current record. */
    const candidates = this.#current.record.effects.filter(
      /**
       * Selects unstarted, retryable, or stale-fence claims not already running locally.
       * @param effect - Durable effect record from the current acknowledged snapshot.
       * @returns Whether this activation may attempt a durable claim.
       */
      (effect) =>
        (effect.status === 'pending' ||
          effect.status === 'failed' ||
          (effect.status === 'claimed' && effect.fence !== this.#current.record.lease.fence)) &&
        !this.#operations.has(effect.id),
    );
    /** Claims candidates serially so each CAS begins from the latest head. */
    for (const effect of candidates) await this.#claimEffect(effect.id);
  }

  /**
   * Durably claims one effect before invoking its process-local adapter.
   * @param effectId - Deterministic effect identity selected for redrive.
   */
  async #claimEffect(effectId: string): Promise<void> {
    if (this.#effects === undefined || this.#released) return;
    /** Reloads current ownership before claiming external work. */
    const loaded = await this.#store.read(this.cellId);
    if (
      loaded === undefined ||
      loaded.record.lease.ownerId !== this.#ownerId ||
      loaded.record.lease.fence !== this.#current.record.lease.fence
    ) {
      this.#fence(loaded);
      return;
    }
    /** Finds the exact durable intent selected during redrive. */
    const selected = loaded.record.effects.find(
      /**
       * Matches deterministic effect identity.
       * @param item - Durable effect record in acknowledged order.
       * @returns Whether this record owns the requested effect identity.
       */
      (item) => item.id === effectId,
    );
    /** Allows a newer fence to redrive work stranded by an expired owner. */
    const strandedClaim = selected?.status === 'claimed' && selected.fence !== loaded.record.lease.fence;
    if (selected === undefined || (selected.status !== 'pending' && selected.status !== 'failed' && !strandedClaim))
      return;
    /** Next attempt number is persisted before adapter invocation. */
    const attempt = selected.attempt + 1;
    /** Claim evidence advances durable observation order without advancing Program sequence. */
    const offset = advanceDecimal(loaded.record.observationCount);
    /** Trusted claim instant retained for operational reconstruction. */
    const at = cellTimestamp(this.#now);
    /** Claimed replacement binds this attempt to the current fence. */
    const claimedEffect: StoredCellEffect = Object.freeze({
      ...selected,
      status: 'claimed',
      attempt,
      fence: loaded.record.lease.fence,
    });
    /** Successor record replaces only the selected effect with its claimed form. */
    const nextRecord: StoredCellRecord = Object.freeze({
      ...loaded.record,
      observationCount: offset,
      effects: Object.freeze(
        loaded.record.effects.map(
          /**
           * Replaces the selected effect while preserving acknowledged order.
           * @param item - Existing durable effect record.
           * @returns Claimed replacement or original record.
           */
          (item) => (item.id === effectId ? claimedEffect : item),
        ),
      ),
    });
    /** Durable operational evidence paired with the claimed effect record. */
    const observation: StoredCellObservation = Object.freeze({
      kind: 'effect-attempt-claimed',
      offset,
      effectId,
      attempt,
      fence: loaded.record.lease.fence,
      at,
    });
    /** Claim becomes executable only after storage atomically acknowledges it. */
    const committed = await this.#store.commit(this.cellId, loaded.token, nextRecord, [observation]);
    if (committed.kind === 'conflict') {
      this.#fence(committed.current);
      return;
    }
    this.#current = committed.current;
    this.#durable.publish(restoreObservation(this.cellId, observation, this.#protocol));
    this.#state.publish(this.#snapshot('active'));

    /** Decodes intent only after the claim is durable. */
    const decoded = this.#protocol.codecs.effect.decode(restoreBytes(selected.bytes));
    if (!decoded.ok) {
      await this.#recordEffectFailure(effectId, attempt, decoded.error);
      return;
    }
    /** Adapter input contains only acknowledged intent and stable causality. */
    const acknowledged: AcknowledgedEffectAttempt<Effect> = Object.freeze({
      cellId: this.cellId,
      effectId: CellEffectIdSchema.parse(effectId),
      causedBy: CellSequenceSchema.parse(selected.causedBy),
      position: selected.position,
      effect: decoded.value,
      attempt,
      fence: FenceEpochSchema.parse(loaded.record.lease.fence),
    });

    try {
      /** Adapter construction starts exactly once after durable claim settlement. */
      const operation = await this.#effects.start(acknowledged);
      this.#operations.set(effectId, operation);
      /** Drains presentation progress independently of terminal result settlement. */
      void (async () => {
        /** Transient subscription exists only for the lifetime of this finite attempt. */
        const subscription = operation.events.subscribe();
        try {
          /** Forwards every admitted progress delivery without influencing the result. */
          for await (const delivery of subscription) {
            if (delivery.kind === 'event' && !this.#released) {
              this.#activity.publish(
                Object.freeze({
                  kind: 'effect-progress',
                  cellId: this.cellId,
                  effectId: acknowledged.effectId,
                  attempt,
                  progress: delivery.value,
                }),
              );
            }
          }
        } finally {
          await subscription.close();
        }
      })().catch(
        /**
         * Diagnoses progress-plane failure without changing durable effect settlement.
         * @param error - Unexpected progress subscription rejection.
         * @returns Nothing after best-effort diagnosis.
         */
        (error: unknown) => this.#failBackground('cell.effect-progress', error, false),
      );
      /** Terminal effect settlement re-enters the serialized Cell graph exactly once. */
      void operation.result
        .then(
          /**
           * Re-enters successful external work as an ordinary serialized Program event.
           * @param result - Adapter-proposed effect result event.
           * @returns Settlement after event acknowledgement and attempt cleanup.
           */
          (result) =>
            this.#queue.run(
              /** Serializes effect completion with dispatch, renewal, and other attempts. */
              async () => {
                this.#operations.delete(effectId);
                await this.#applyEvent(result.event, undefined, undefined, effectId);
                await operation.close();
              },
            ),
          /**
           * Retains a redacted failed attempt without inventing a domain event.
           * @param error - Adapter result rejection kept out of durable private details.
           * @returns Settlement after failure evidence and attempt cleanup.
           */
          (error: unknown) =>
            this.#queue.run(
              /** Serializes effect failure with dispatch, renewal, and other attempts. */
              async () => {
                this.#operations.delete(effectId);
                await this.#recordEffectFailure(effectId, attempt, error);
                await operation.close();
              },
            ),
        )
        .catch(
          /**
           * Treats failed durable re-entry as loss of safe local ownership.
           * @param error - Unexpected effect-settlement rejection.
           * @returns Nothing after diagnosing and fencing the activation.
           */
          (error: unknown) => this.#failBackground('cell.effect-settlement', error, true),
        );
    } catch (error) {
      await this.#recordEffectFailure(effectId, attempt, error);
    }
  }

  /**
   * Retains one redacted attempt failure without creating a Program event.
   * @param effectId - Deterministic effect identity eligible for later redrive.
   * @param attempt - Exact failed attempt number.
   * @param error - Adapter or codec failure kept out of durable state.
   */
  async #recordEffectFailure(effectId: string, attempt: number, error: unknown): Promise<void> {
    /** Release already aborted this process-local attempt and surrendered mutation authority. */
    if (this.#released) return;
    /** Reloads current ownership before persisting failed-attempt evidence. */
    const loaded = await this.#store.read(this.cellId);
    if (
      loaded === undefined ||
      loaded.record.lease.ownerId !== this.#ownerId ||
      loaded.record.lease.fence !== this.#current.record.lease.fence
    ) {
      this.#fence(loaded);
      return;
    }
    /** Finds the exact claimed attempt that this adapter settlement belongs to. */
    const selected = loaded.record.effects.find(
      /**
       * Matches deterministic effect identity.
       * @param item - Durable effect record in acknowledged order.
       * @returns Whether this record owns the failed effect identity.
       */
      (item) => item.id === effectId,
    );
    if (selected === undefined || selected.status !== 'claimed' || selected.attempt !== attempt) return;
    /** Failed-attempt evidence advances observation order only. */
    const offset = advanceDecimal(loaded.record.observationCount);
    /** Redacts arbitrary adapter failure before durable persistence. */
    const failure = toPublicError(error, {
      code: 'cell_effect_attempt_failed',
      message: 'Cell effect attempt failed',
    });
    /** Successor record keeps the intent retryable without changing Program state. */
    const nextRecord: StoredCellRecord = Object.freeze({
      ...loaded.record,
      observationCount: offset,
      effects: Object.freeze(
        loaded.record.effects.map(
          /**
           * Marks only the settling attempt failed.
           * @param item - Existing durable effect record.
           * @returns Failed replacement or original record.
           */
          (item) => (item.id === effectId ? Object.freeze({ ...item, status: 'failed' as const }) : item),
        ),
      ),
    });
    /** Durable operational observation contains only redacted public failure data. */
    const observation: StoredCellObservation = Object.freeze({
      kind: 'effect-attempt-failed',
      offset,
      effectId,
      attempt,
      failure: JsonValueSchema.parse(failure) as JsonObject,
      at: cellTimestamp(this.#now),
    });
    /** Atomic storage settlement prevents failure evidence from racing a newer fence. */
    const committed = await this.#store.commit(this.cellId, loaded.token, nextRecord, [observation]);
    if (committed.kind === 'conflict') {
      this.#fence(committed.current);
      return;
    }
    this.#current = committed.current;
    this.#durable.publish(restoreObservation(this.cellId, observation, this.#protocol));
    this.#state.publish(this.#snapshot('active'));
  }

  /** Processes one overdue recoverable wake through ordinary Program acknowledgement. */
  async #runDueWake(): Promise<void> {
    /** Current persisted wake is the only timer intent considered recoverable. */
    const wake = this.#current.record.wake;
    if (wake === undefined || Date.parse(wake.at) > this.#now().getTime() || this.#released) return;
    /** Canonical wake event re-enters the same Program transition boundary. */
    const event = this.#protocol.codecs.event.decode(restoreBytes(wake.event));
    if (!event.ok) throw event.error;
    await this.#applyEvent(event.value);
  }

  /** Renews ownership and runs a due wake under the same serialized activation queue. */
  async #tick(): Promise<void> {
    if (this.#released) return;
    /** Reloads ownership before renewal so stale timers cannot extend an old fence. */
    const loaded = await this.#store.read(this.cellId);
    if (
      loaded === undefined ||
      loaded.record.lease.ownerId !== this.#ownerId ||
      loaded.record.lease.fence !== this.#current.record.lease.fence
    ) {
      this.#fence(loaded);
      return;
    }
    /** Renewal changes only the current lease expiry. */
    const renewed: StoredCellRecord = Object.freeze({
      ...loaded.record,
      lease: Object.freeze({
        ...loaded.record.lease,
        expiresAt: addMilliseconds(cellTimestamp(this.#now), this.#leaseMilliseconds),
      }),
    });
    /** Conditional renewal loses cleanly to a replacement owner. */
    const committed = await this.#store.commit(this.cellId, loaded.token, renewed, []);
    if (committed.kind === 'conflict') {
      this.#fence(committed.current);
      return;
    }
    this.#current = committed.current;
    await this.#runDueWake();
    if (!this.#released) {
      this.#state.publish(this.#snapshot('active'));
      this.#scheduleNext();
    }
  }

  /** Schedules the earlier of lease renewal and a projected wake. */
  #scheduleNext(): void {
    if (this.#released) return;
    this.#cancelSchedule?.();
    /** Renews at half the lease while never allowing a zero-delay spin. */
    const renewalDelay = Math.max(1, Math.floor(this.#leaseMilliseconds / 2));
    /** Wakes may occur earlier than renewal and are clamped for already-due state. */
    const wakeDelay =
      this.#current.record.wake === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Date.parse(this.#current.record.wake.at) - this.#now().getTime());
    /** Earliest recoverable obligation determines the next timer admission. */
    const delay = Math.min(renewalDelay, wakeDelay);
    this.#cancelSchedule = this.#schedule(
      delay,
      /** Admits timer work through the same serialized command queue. */
      () => {
        void this.#queue
          .run(
            /**
             * Renews ownership and processes any now-due wake.
             * @returns Serialized tick settlement.
             */
            () => this.#tick(),
          )
          .catch(
            /** Converts unexpected timer work failure into local fencing. */
            () => {
              this.#fence(undefined);
            },
          );
      },
    );
  }

  /**
   * Diagnoses detached work and optionally surrenders local mutation authority.
   * @param name - Stable background operation identity.
   * @param error - Unexpected rejection kept out of durable Cell values.
   * @param fence - Whether the failed operation makes further local mutation unsafe.
   */
  #failBackground(name: string, error: unknown, fence: boolean): void {
    /** One terminal wide record preserves the failure without creating a log breadcrumb. */
    const span = beginCellSpan(this.#diagnostics, name, this.#hostId(), this.cellId);
    failCellSpan(span, error);
    if (fence) this.#fence(undefined);
  }

  /**
   * Publishes local supersession once and prevents later process work.
   * @param current - Optional winning record observed from storage.
   */
  #fence(current: StoredCellVersion | undefined): void {
    if (this.#released) return;
    this.#released = true;
    this.#cancelSchedule?.();
    if (current !== undefined) this.#current = current;
    this.#state.publish(this.#snapshot('fenced'));
  }
}

/**
 * Creates the shared CellHost runtime over one exact atomic storage adapter.
 * @param options - Base configuration, published durability, and owned store.
 * @returns Retained host whose public methods preserve generic protocol types.
 */
export function createCellHostRuntime(options: CellRuntimeOptions): CellHost {
  /** Validates all bounded construction values before exposing a retained owner. */
  const hostId = options.base.hostId;
  /** Applies the explicit lease interval or the documented runtime default. */
  const leaseMilliseconds = options.base.leaseDurationMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  /** Applies the explicit replay bound or the documented runtime default. */
  const observationRetentionItems = options.base.observationRetentionItems ?? DEFAULT_OBSERVATION_RETENTION;
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 10) {
    throw new RangeError('leaseDurationMilliseconds must be a safe integer of at least 10');
  }
  if (!Number.isSafeInteger(observationRetentionItems) || observationRetentionItems < 1) {
    throw new RangeError('observationRetentionItems must be a positive safe integer');
  }

  /** Captures explicitly owned or borrowed authority without altering its identity. */
  const authorityRef = options.base.authority;
  /** Current-verification broker used at every protected method boundary. */
  const authority = authorityRef.value;
  /** Trusted host clock selected once for consistent lease semantics. */
  const now = options.base.now ?? systemCellClock;
  /** Host timer capability selected once for renewal and wake scheduling. */
  const schedule = options.base.schedule ?? systemCellScheduler;
  /** UUIDv4 factory selected once for durable owner identities. */
  const createId = options.base.createId ?? systemCellId;
  /** Process-local registry prevents duplicate activation inside one host. */
  const active = new Map<string, ManagedActivation>();
  /** Rejects public work synchronously once host closure begins. */
  let closed = false;
  /** Retains the one host cleanup settlement shared by every close caller. */
  let closePromise: Promise<CellHostCloseEvidence> | undefined;
  /** Captures the resolver for public retained closure evidence. */
  let settleClosed: ((evidence: CellHostCloseEvidence) => void) | undefined;
  /** Captures the rejector so retained closure shares active cleanup failure. */
  let rejectClosed: ((reason: unknown) => void) | undefined;
  /** Public retained closure settlement exists before any cleanup starts. */
  const closedPromise = new Promise<CellHostCloseEvidence>(
    /**
     * Captures the single closure settlement pair without initiating work.
     * @param resolve - Native Promise resolver retained until host cleanup settles.
     * @param reject - Native Promise rejector retained when cleanup fails.
     */
    (resolve, reject) => {
      settleClosed = resolve;
      rejectClosed = reject;
    },
  );

  /**
   * Acquires and constructs one generic activation after a durable create or attach.
   * @param current - Record whose lease already names this process owner.
   * @param protocol - Exact compatible protocol supplied by the caller.
   * @param activation - Optional process-local effect adapter.
   * @param ownerId - UUIDv4 owner retained in current lease.
   * @returns Fully hydrated hot handle.
   */
  async function openActivation<State, StateView, Event, Effect, Progress extends JsonValue>(
    current: StoredCellVersion,
    protocol: CellProtocol<State, StateView, Event, Effect>,
    activation: import('./contracts.js').CellActivationOptions<Effect, Event, Progress> | undefined,
    ownerId: string,
  ): Promise<CellHandle<StateView, Event, Progress>> {
    /** Restores durable history before the handle can become visible. */
    const history = await options.store.observations(current.record.cellId);
    /** Removes the registry entry only after this exact activation closes. */
    const handle = new CellActivation({
      current,
      history,
      protocol,
      ...(activation === undefined ? {} : { activation }),
      durability: options.durability,
      hostId,
      store: options.store,
      authority,
      ownerId,
      now,
      schedule,
      leaseMilliseconds,
      observationRetentionItems,
      ...(options.base.diagnostics === undefined ? {} : { diagnostics: options.base.diagnostics }),
      /** Removes only this exact activation, preserving a newer replacement. */
      onReleased() {
        if (active.get(current.record.cellId) === handle) active.delete(current.record.cellId);
      },
    });
    active.set(current.record.cellId, handle);
    try {
      await handle.ready();
      return handle;
    } catch (error) {
      /** A failed startup barrier cannot leave an unreachable registered activation behind. */
      await handle.close().catch(
        /**
         * Leaves lease expiry as the recovery fallback when cleanup also fails.
         * @returns Nothing after preserving the original startup rejection.
         */
        () => undefined,
      );
      if (active.get(current.record.cellId) === handle) active.delete(current.record.cellId);
      throw error;
    }
  }

  /** Public host facade freezes adapter identity and retained lifecycle. */
  const host: CellHost = {
    hostId,
    durability: options.durability,
    closed: closedPromise,
    /**
     * Creates and acquires one absent durable Cell after current Authority verification.
     * @param request - Initial state, exact protocol, subject, and creation identity.
     * @param grant - Current create grant bound to the host and optional Cell scope.
     * @returns Open handle or an explicit refusal/failure branch.
     */
    async create<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
      request: CellCreateRequest<State, StateView, Event, Effect, Progress>,
      grant: GrantRef<CellCreateAction>,
    ): Promise<CellCreateOutcome<StateView, Event, Progress>> {
      /** Wide diagnostic span accumulates creation context through terminal settlement. */
      const span = beginCellSpan(options.base.diagnostics, 'cell.create', hostId, request.cellId);
      if (closed) {
        /** Stable redacted closed-host failure returned without touching storage. */
        const failure = toPublicError(new Error('CellHost is closed'), {
          code: 'cell_host_closed',
          message: 'CellHost is closed',
        });
        completeCellSpan(span, 'unavailable', { reason: 'closed' });
        return Object.freeze({ kind: 'unavailable', failure });
      }
      try {
        /** Current Authority decision precedes durable lookup and codec work. */
        const decision = await authority.verify<CellCreateAction>({
          grant,
          subject: request.subject,
          scope: { kind: 'cell', hostId, cellId: request.cellId },
        });
        if (!decision.allowed) {
          completeCellSpan(span, 'authority-refused', { reason: decision.refusal.reason });
          return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        }
        if (
          !supportsDurability(options.durability, request.protocol as CellProtocol<unknown, unknown, unknown, unknown>)
        ) {
          completeCellSpan(span, 'unavailable', { reason: 'durability' });
          return Object.freeze({
            kind: 'unavailable',
            failure: toPublicError(new Error('CellHost durability is weaker than the protocol requirement'), {
              code: 'cell_durability_mismatch',
              message: 'CellHost durability does not satisfy the protocol',
            }),
          });
        }
        /** Canonical initial bytes establish the durable generation-zero value. */
        const initial = request.protocol.codecs.state.encode(request.initialState);
        if (!initial.ok) throw initial.error;
        /** Proves projection and its bound before any durable create. */
        const decoded = request.protocol.codecs.state.decode(initial.value);
        if (!decoded.ok) throw decoded.error;
        /** Bounded state-view proof prevents creating a Cell that cannot be observed. */
        const projected = request.protocol.codecs.stateView.encode(request.protocol.projectState(decoded.value));
        if (!projected.ok) throw projected.error;
        /** Fresh process owner becomes fence-one lease holder only after storage create. */
        const ownerId = UuidV4Schema.parse(createId());
        /** Trusted creation instant anchors the initial ownership lease. */
        const at = cellTimestamp(now);
        /** Exact retry identity binds subject, protocol, and canonical initial bytes. */
        const fingerprint = digest([
          request.subject,
          JSON.stringify(bindCellProtocol(request.protocol)),
          initial.value,
        ]);
        /** Complete generation-zero record proposed atomically to storage. */
        const record: StoredCellRecord = Object.freeze({
          cellId: request.cellId,
          binding: bindCellProtocol(request.protocol),
          creation: Object.freeze({ idempotencyKey: request.idempotencyKey, fingerprint }),
          sequence: '0',
          observationCount: '0',
          state: storeBytes(initial.value),
          lease: Object.freeze({ ownerId, fence: '1', expiresAt: addMilliseconds(at, leaseMilliseconds) }),
          receipts: Object.freeze([]),
          effects: Object.freeze([]),
          ...(request.protocol.projectWake === undefined
            ? {}
            : (() => {
                /** Pure wake projection is evaluated from re-admitted generation-zero state. */
                const wake = request.protocol.projectWake(decoded.value);
                if (wake === undefined) return {};
                /** Canonical wake bytes make a creation-time timer recoverable. */
                const encoded = request.protocol.codecs.event.encode(wake.event);
                if (!encoded.ok) throw encoded.error;
                return {
                  wake: Object.freeze({ at: TimestampSchema.parse(wake.at), event: storeBytes(encoded.value) }),
                };
              })()),
        });
        /** Atomic create distinguishes generation zero from an existing lineage. */
        const created = await options.store.create(record);
        /** Tracks the exact acquired version that will hydrate the returned handle. */
        let current = created.current;
        if (created.kind === 'already-exists') {
          /** Only byte-equivalent creation intent is eligible for expired-lease reopen. */
          const exactRetry =
            created.current.record.creation.idempotencyKey === request.idempotencyKey &&
            created.current.record.creation.fingerprint === fingerprint;
          if (!exactRetry) {
            completeCellSpan(span, 'already-exists');
            return Object.freeze({ kind: 'already-exists', cellId: request.cellId });
          }
          /** A registered local activation remains unique even if its inert test lease elapsed. */
          if (active.has(request.cellId)) {
            completeCellSpan(span, 'already-exists');
            return Object.freeze({ kind: 'already-exists', cellId: request.cellId });
          }
          /** An exact retry may only reopen after the prior lease expires. */
          if (Date.parse(created.current.record.lease.expiresAt) > now().getTime()) {
            completeCellSpan(span, 'already-exists');
            return Object.freeze({ kind: 'already-exists', cellId: request.cellId });
          }
          /** Reopening an expired exact retry must win the same durable fence acquisition as attach. */
          const reacquiredRecord: StoredCellRecord = Object.freeze({
            ...created.current.record,
            lease: Object.freeze({
              ownerId,
              fence: advanceDecimal(created.current.record.lease.fence),
              expiresAt: addMilliseconds(cellTimestamp(now), leaseMilliseconds),
            }),
          });
          /** CAS acquisition prevents concurrent exact retries from sharing one fence. */
          const reacquired = await options.store.commit(request.cellId, created.current.token, reacquiredRecord, []);
          if (reacquired.kind === 'conflict') {
            completeCellSpan(span, 'already-exists');
            return Object.freeze({ kind: 'already-exists', cellId: request.cellId });
          }
          current = reacquired.current;
        }
        /** Hydrated hot handle is returned only after ownership and due-wake recovery. */
        const handle = await openActivation(current, request.protocol, request.activation, ownerId);
        completeCellSpan(span, 'opened');
        return Object.freeze({ kind: 'opened', handle });
      } catch (error) {
        failCellSpan(span, error);
        return Object.freeze({
          kind: 'unavailable',
          failure: toPublicError(error, { code: 'cell_create_unavailable', message: 'Cell creation is unavailable' }),
        });
      }
    },
    /**
     * Acquires an existing compatible Cell after current Authority verification.
     * @param request - Durable identity, exact protocol, subject, and optional effect adapter.
     * @param grant - Current attach grant bound to the host and optional Cell scope.
     * @returns Open handle or an explicit restore/ownership/failure branch.
     */
    async attach<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
      request: CellAttachRequest<State, StateView, Event, Effect, Progress>,
      grant: GrantRef<CellAttachAction>,
    ): Promise<CellAttachOutcome<StateView, Event, Progress>> {
      /** Wide diagnostic span accumulates attachment context through terminal settlement. */
      const span = beginCellSpan(options.base.diagnostics, 'cell.attach', hostId, request.cellId);
      if (closed) {
        completeCellSpan(span, 'unavailable', { reason: 'closed' });
        return Object.freeze({
          kind: 'unavailable',
          failure: toPublicError(new Error('CellHost is closed'), {
            code: 'cell_host_closed',
            message: 'CellHost is closed',
          }),
        });
      }
      try {
        /** Current Authority decision precedes durable lookup. */
        const decision = await authority.verify<CellAttachAction>({
          grant,
          subject: request.subject,
          scope: { kind: 'cell', hostId, cellId: request.cellId },
        });
        if (!decision.allowed) {
          completeCellSpan(span, 'authority-refused', { reason: decision.refusal.reason });
          return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        }
        /** Current durable record carries both compatibility and lease evidence. */
        const loaded = await options.store.read(request.cellId);
        if (loaded === undefined) {
          completeCellSpan(span, 'not-found');
          return Object.freeze({ kind: 'not-found', cellId: request.cellId });
        }
        /** Exact revision comparison prevents interpreting bytes under changed behavior. */
        const refusal = compareCellProtocol(loaded.record.binding, bindCellProtocol(request.protocol));
        if (refusal !== undefined) {
          completeCellSpan(span, 'restore-refused', { reason: refusal.reason, field: refusal.field });
          return Object.freeze({ kind: 'restore-refused', refusal });
        }
        if (
          !supportsDurability(options.durability, request.protocol as CellProtocol<unknown, unknown, unknown, unknown>)
        ) {
          /** Stable restore refusal names the guarantee mismatch without storage details. */
          const durabilityRefusal = Object.freeze({ reason: 'durability' as const, field: 'durability' });
          completeCellSpan(span, 'restore-refused', { reason: 'durability' });
          return Object.freeze({ kind: 'restore-refused', refusal: durabilityRefusal });
        }
        if (active.has(request.cellId) || Date.parse(loaded.record.lease.expiresAt) > now().getTime()) {
          completeCellSpan(span, 'active-elsewhere');
          return Object.freeze({ kind: 'active-elsewhere', retryAfter: loaded.record.lease.expiresAt });
        }
        /** Fresh owner identity is persisted with the next fence before activation. */
        const ownerId = UuidV4Schema.parse(createId());
        /** Proposed successor advances the fence and refreshes lease expiry together. */
        const acquiredRecord: StoredCellRecord = Object.freeze({
          ...loaded.record,
          lease: Object.freeze({
            ownerId,
            fence: advanceDecimal(loaded.record.lease.fence),
            expiresAt: addMilliseconds(cellTimestamp(now), leaseMilliseconds),
          }),
        });
        /** Conditional commit ensures only one replacement owns the next fence. */
        const acquired = await options.store.commit(request.cellId, loaded.token, acquiredRecord, []);
        if (acquired.kind === 'conflict') {
          completeCellSpan(span, 'active-elsewhere');
          return Object.freeze({ kind: 'active-elsewhere', retryAfter: acquired.current.record.lease.expiresAt });
        }
        /** Hydrated hot handle is returned only after due-wake recovery. */
        const handle = await openActivation(acquired.current, request.protocol, request.activation, ownerId);
        completeCellSpan(span, 'opened');
        return Object.freeze({ kind: 'opened', handle });
      } catch (error) {
        failCellSpan(span, error);
        return Object.freeze({
          kind: 'unavailable',
          failure: toPublicError(error, { code: 'cell_attach_unavailable', message: 'Cell attachment is unavailable' }),
        });
      }
    },
    /**
     * Reads canonical acknowledged state without acquiring an activation lease.
     * @param request - Cell identity, subject, protocol revision, and state codec.
     * @param grant - Current state-read grant for this scope.
     * @returns Decoded state or an explicit refusal/failure branch.
     */
    async readState<State>(
      request: CellStateReadRequest<State>,
      grant: GrantRef<CellReadAction>,
    ): Promise<CellStateReadOutcome<State>> {
      /** Wide diagnostic span accumulates read context through terminal settlement. */
      const span = beginCellSpan(options.base.diagnostics, 'cell.read-state', hostId, request.cellId);
      if (closed) {
        completeCellSpan(span, 'unavailable', { reason: 'closed' });
        return Object.freeze({
          kind: 'unavailable',
          failure: toPublicError(new Error('CellHost is closed'), {
            code: 'cell_host_closed',
            message: 'CellHost is closed',
          }),
        });
      }
      try {
        /** Current Authority decision precedes durable lookup and decoding. */
        const decision = await authority.verify<CellReadAction>({
          grant,
          subject: request.subject,
          scope: { kind: 'cell', hostId, cellId: request.cellId },
        });
        if (!decision.allowed) {
          completeCellSpan(span, 'authority-refused', { reason: decision.refusal.reason });
          return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        }
        /** Current record is read without changing its lease or observation position. */
        const loaded = await options.store.read(request.cellId);
        if (loaded === undefined) {
          completeCellSpan(span, 'not-found');
          return Object.freeze({ kind: 'not-found', cellId: request.cellId });
        }
        if (loaded.record.binding.protocol !== request.protocolRevision) {
          /** Stable refusal prevents reading state under another protocol revision. */
          const refusal = Object.freeze({ reason: 'protocol-revision' as const, field: 'protocol' });
          completeCellSpan(span, 'restore-refused', { reason: refusal.reason });
          return Object.freeze({ kind: 'restore-refused', refusal });
        }
        if (loaded.record.binding.stateCodec !== request.stateCodec.revision) {
          /** Stable refusal prevents decoding state under another codec revision. */
          const refusal = Object.freeze({ reason: 'codec-revision' as const, field: 'stateCodec' });
          completeCellSpan(span, 'restore-refused', { reason: refusal.reason });
          return Object.freeze({ kind: 'restore-refused', refusal });
        }
        if (request.at !== undefined && request.at !== loaded.record.sequence) {
          /** Stable refusal makes unsupported historical state retention explicit. */
          const refusal = Object.freeze({ reason: 'protocol-revision' as const, field: 'historical-state-retention' });
          completeCellSpan(span, 'restore-refused', { reason: refusal.reason });
          return Object.freeze({ kind: 'restore-refused', refusal });
        }
        /** Caller-selected compatible codec restores a fresh canonical state value. */
        const state = request.stateCodec.decode(restoreBytes(loaded.record.state));
        if (!state.ok) throw state.error;
        completeCellSpan(span, 'found');
        return Object.freeze({
          kind: 'found',
          sequence: CellSequenceSchema.parse(loaded.record.sequence),
          state: state.value,
        });
      } catch (error) {
        failCellSpan(span, error);
        return Object.freeze({
          kind: 'unavailable',
          failure: toPublicError(error, { code: 'cell_read_unavailable', message: 'Cell state read is unavailable' }),
        });
      }
    },
    /**
     * Returns one retained host cleanup settlement and releases only owned dependencies.
     * @returns Shared host closure settlement.
     */
    close() {
      closePromise ??= (async () => {
        closed = true;
        /** Cleanup failures are retained while every owned resource still receives closure. */
        const failures: unknown[] = [];
        /** Active activation cleanup runs concurrently because each Cell owns its own queue. */
        const releases = await Promise.allSettled(
          [...active.values()].map(
            /**
             * Releases one process-local activation without deleting durable state.
             * @param activation - Host-owned active Cell handle.
             * @returns Retained activation release settlement.
             */
            (activation) => activation.close(),
          ),
        );
        /** Preserves each activation cleanup rejection for final host settlement. */
        for (const release of releases) if (release.status === 'rejected') failures.push(release.reason);
        active.clear();
        try {
          await options.store.close();
        } catch (error) {
          failures.push(error);
        }
        if (authorityRef.ownership === 'owned') {
          try {
            await authorityRef.value.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          /** One failure keeps its exact identity; several preserve all cleanup evidence. */
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'CellHost cleanup failed');
        }
        /** Stable evidence settles both close and the retained closed Promise. */
        const evidence = Object.freeze({ kind: 'cell-host-closed' as const, hostId });
        settleClosed?.(evidence);
        return evidence;
      })();
      /** Retained closure rejects with the same object returned by the active close Promise. */
      void closePromise.catch(
        /**
         * Settles retained lifecycle observation without replacing cleanup evidence.
         * @param error - Exact cleanup rejection returned by host close.
         * @returns Nothing after rejecting the retained closed Promise.
         */
        (error: unknown) => rejectClosed?.(error),
      );
      return closePromise;
    },
    /** Routes language-level disposal through the same retained host cleanup. */
    async [Symbol.asyncDispose]() {
      await host.close();
    },
  };
  return Object.freeze(host);
}
