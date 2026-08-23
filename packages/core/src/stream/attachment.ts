/**
 * @file Implements versioned current state and race-free asynchronous
 * attachments across state, durable observations, and transient signals.
 */

import { CanonicalDecimalSchema } from '../values.js';
import type { OwnedHandle } from '../ownership.js';
import type {
  AtomicLiveAttachment,
  AtomicLiveAttachmentSource,
  LiveAttachmentCloseEvidence,
  LiveAttachmentOptions,
  LiveState,
  StateUpdateClose,
  StateUpdateSubscription,
  StateVersion,
  StreamCursor,
  Unsubscribe,
  VersionedSnapshot,
} from './contracts.js';
import {
  createLiveState,
  type EventSourceCloseEvidence,
  type LiveStateOptions,
  type ReplayableEventSource,
  type TransientEventSource,
} from './runtime.js';

/** Validates canonical non-negative state versions without safe-integer loss. */
export const StateVersionSchema = CanonicalDecimalSchema.transform((value) => value as unknown as StateVersion);

/** Configures one source-scoped versioned current-state owner. */
export type VersionedLiveStateOptions = LiveStateOptions &
  Readonly<{
    /** Names the logical current-state source. */
    source: string;

    /** Identifies the source generation within which versions are comparable. */
    epoch: string;
  }>;

/** Owns current-state publication together with monotonic source versions. */
export interface VersionedLiveStateSource<State> extends LiveState<State>, OwnedHandle<EventSourceCloseEvidence> {
  /** Names the logical current-state source. */
  readonly source: string;

  /** Identifies the generation within which versions are comparable. */
  readonly epoch: string;

  /** Replaces current state and advances its canonical decimal version. */
  publish(snapshot: State): VersionedSnapshot<State>;

  /** Returns the same versioned object identity until publication. */
  getVersionedSnapshot(): VersionedSnapshot<State>;

  /** Attaches to deferred, coalescing versioned state changes. */
  subscribeVersioned(listener: (snapshot: VersionedSnapshot<State>) => void): Unsubscribe;
}

/**
 * Creates a source-scoped current-state owner with arbitrary-precision versions.
 * @param initial - Immutable current state visible at version zero.
 * @param options - Source identity, scheduling, and listener-failure behavior.
 * @returns A retained versioned state publication capability.
 */
export function createVersionedLiveState<State>(
  initial: State,
  options: VersionedLiveStateOptions,
): VersionedLiveStateSource<State> {
  /** Tracks the exact monotonic version using arbitrary-precision arithmetic. */
  let version = 0n;

  /**
   * Creates an immutable comparison-scoped state envelope.
   * @param snapshot - Immutable state admitted at the current source version.
   * @returns A frozen source, epoch, version, and snapshot envelope.
   */
  const envelope = (snapshot: State): VersionedSnapshot<State> =>
    Object.freeze({
      source: options.source,
      epoch: options.epoch,
      version: StateVersionSchema.parse(version.toString(10)),
      snapshot,
    });

  /** Reuses LiveState's one hot RxJS graph and callback semantics. */
  const state = createLiveState(envelope(initial), options);

  /** Prevents the wrapper from claiming versions the inner source did not admit. */
  let closed = false;

  /** Projects the versioned implementation through both raw and transport views. */
  const source: VersionedLiveStateSource<State> = {
    source: options.source,
    epoch: options.epoch,
    closed: state.closed,
    /**
     * Reads raw current state.
     * @returns Current state by stable identity.
     */
    getSnapshot() {
      return state.getSnapshot().snapshot;
    },
    /**
     * Reads transport-scoped current state.
     * @returns Current versioned envelope by identity.
     */
    getVersionedSnapshot() {
      return state.getSnapshot();
    },
    /**
     * Attaches one raw current-state observer.
     * @param listener - Callback receiving raw state replacement.
     * @returns Synchronous idempotent detachment.
     */
    subscribe(listener) {
      return state.subscribe((snapshot) => listener(snapshot.snapshot));
    },
    /**
     * Attaches one transport-scoped state observer.
     * @param listener - Callback receiving versioned state replacement.
     * @returns Synchronous idempotent detachment.
     */
    subscribeVersioned(listener) {
      return state.subscribe(listener);
    },
    /**
     * Publishes raw state and advances the monotonic source version.
     * @param snapshot - New immutable raw state.
     * @returns The admitted versioned envelope.
     */
    publish(snapshot) {
      if (closed) throw new Error('Cannot publish to a completed versioned state source');
      version += 1n;
      /** Captures this transition once for both current reads and callbacks. */
      const next = envelope(snapshot);
      state.publish(next);
      return next;
    },
    /**
     * Completes the versioned state owner.
     * @returns Shared source close evidence.
     */
    close() {
      closed = true;
      return state.close();
    },
    /** Delegates language disposal to versioned source completion. */
    async [Symbol.asyncDispose]() {
      await source.close();
    },
  };

  return Object.freeze(source);
}

/** One pending state consumer pull. */
type StatePull<State> = (result: IteratorResult<VersionedSnapshot<State>>) => void;

/** Owns a single latest-state slot for one atomic attachment. */
class LatestStateSubscription<State> implements StateUpdateSubscription<State> {
  /** Settles with the final version visible to this attachment. */
  readonly closed: Promise<StateUpdateClose>;

  /** Source whose deferred callbacks populate the latest-state slot. */
  readonly #source: VersionedLiveStateSource<State>;

  /** Detaches this lane from future source callbacks. */
  readonly #unsubscribe: Unsubscribe;

  /** Settles the public close signal once. */
  readonly #settle: (evidence: StateUpdateClose) => void;

  /** Retains at most the latest source version for a lagging consumer. */
  #latest: VersionedSnapshot<State> | undefined;

  /** Remembers the seed version so natural close does not redeliver it. */
  #seedVersion: StateVersion | undefined;

  /** Remembers the latest version accepted into this state lane. */
  #lastOfferedVersion: StateVersion | undefined;

  /** Defers natural close evidence until the final latest-state slot drains. */
  #completionEvidence: StateUpdateClose | undefined;

  /** Retains outstanding pulls in call order. */
  readonly #pulls: StatePull<State>[] = [];

  /** Prevents delivery after explicit detachment or source completion. */
  #ended = false;

  /**
   * Attaches synchronously to versioned state before an atomic seed is read.
   * @param source - Borrowed versioned state owner.
   */
  constructor(source: VersionedLiveStateSource<State>) {
    this.#source = source;
    /** Captures the native resolver without exposing mutable lifecycle state. */
    let settlePromise: ((evidence: StateUpdateClose) => void) | undefined;
    this.closed = new Promise((resolve) => {
      settlePromise = resolve;
    });
    /**
     * Settles state-lane lifecycle once.
     * @param evidence - Immutable final state version or failure.
     * @returns Nothing; native Promise settlement is the side effect.
     */
    this.#settle = (evidence) => settlePromise?.(Object.freeze(evidence));
    this.#unsubscribe = source.subscribeVersioned((snapshot) => this.#offer(snapshot));
    void source.closed.then(() => this.#complete());
  }

  /**
   * Records the atomic seed captured after this queue attached.
   * @param seed - Versioned snapshot already returned separately to the caller.
   */
  seed(seed: VersionedSnapshot<State>): void {
    this.#seedVersion = seed.version;
  }

  /**
   * Detaches this state lane and preserves the source's current version.
   * @returns Stable detachment evidence.
   */
  close(): Promise<StateUpdateClose> {
    if (!this.#ended) {
      /** Captures the version current at explicit detachment. */
      const current = this.#source.getVersionedSnapshot();
      this.#finish({ kind: 'detached', epoch: current.epoch, version: current.version });
    }
    return this.closed;
  }

  /** Delegates language-level disposal to the idempotent detachment path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Returns one iterator whose return path detaches the state lane.
   * @returns The latest-state iterator.
   */
  [Symbol.asyncIterator](): AsyncIterator<VersionedSnapshot<State>> {
    return {
      /**
       * Pulls the latest pending or future state.
       * @returns The next state result.
       */
      next: () => this.#next(),
      /**
       * Detaches state iteration early.
       * @returns A completed iterator result.
       */
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Replaces the pending slot or satisfies one waiting pull immediately.
   * @param snapshot - Latest versioned source state.
   */
  #offer(snapshot: VersionedSnapshot<State>): void {
    if (this.#ended) return;
    this.#lastOfferedVersion = snapshot.version;
    /** Removes the oldest waiting pull for FIFO consumer settlement. */
    const pull = this.#pulls.shift();
    if (pull !== undefined) {
      pull({ done: false, value: snapshot });
      this.#finishCompletionIfDrained();
      return;
    }
    this.#latest = snapshot;
  }

  /**
   * Returns the latest pending state or waits for a future replacement.
   * @returns The pending state iterator result.
   */
  #next(): Promise<IteratorResult<VersionedSnapshot<State>>> {
    if (this.#latest !== undefined) {
      /** Captures the current latest slot before clearing it. */
      const snapshot = this.#latest;
      this.#latest = undefined;
      this.#finishCompletionIfDrained();
      return Promise.resolve({ done: false, value: snapshot });
    }
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#pulls.push(resolve));
  }

  /** Completes naturally at the source's final version. */
  #complete(): void {
    if (this.#ended) return;
    /** Captures the source's final comparable version. */
    const current = this.#source.getVersionedSnapshot();
    this.#unsubscribe();
    this.#completionEvidence = Object.freeze({ kind: 'completed', epoch: current.epoch, version: current.version });
    if (current.version !== this.#seedVersion && current.version !== this.#lastOfferedVersion) this.#offer(current);
    this.#finishCompletionIfDrained();
  }

  /** Completes natural source closure only after its final state has been returned. */
  #finishCompletionIfDrained(): void {
    if (this.#completionEvidence === undefined || this.#latest !== undefined) return;
    /** Captures completion before the common finish path clears mutable state. */
    const evidence = this.#completionEvidence;
    this.#completionEvidence = undefined;
    this.#finish(evidence);
  }

  /**
   * Stops callbacks, clears pending state, completes pulls, and settles evidence.
   * @param evidence - Immutable completion, detachment, or failure record.
   */
  #finish(evidence: StateUpdateClose): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#unsubscribe();
    this.#latest = undefined;
    this.#completionEvidence = undefined;
    /** Completes every outstanding state pull after detachment. */
    for (const pull of this.#pulls.splice(0)) pull({ done: true, value: undefined });
    this.#settle(evidence);
  }
}

/** Maps transient event payload types to their retained publisher capabilities. */
export type TransientEventSources<Transient extends Readonly<Record<string, unknown>>> = Readonly<{
  [Plane in keyof Transient]: TransientEventSource<Transient[Plane]>;
}>;

/** Configures one borrowed set of sources exposed through atomic attachment. */
export type AtomicLiveAttachmentSourceOptions<
  State,
  Source extends string,
  DurableEvent,
  Transient extends Readonly<Record<string, unknown>>,
> = Readonly<{
  /** Supplies source-scoped versioned current state. */
  state: VersionedLiveStateSource<State>;

  /** Supplies durable replay when this retained handle has a durable plane. */
  durable: ReplayableEventSource<DurableEvent, Source>;

  /** Supplies every named transient plane exposed by the retained handle. */
  transient: TransientEventSources<Transient>;
}>;

/** Configures an atomic bridge for a handle with no durable observation plane. */
export type AtomicLiveAttachmentSourceWithoutDurableOptions<
  State,
  Transient extends Readonly<Record<string, unknown>>,
> = Readonly<{
  /** Supplies source-scoped versioned current state. */
  state: VersionedLiveStateSource<State>;

  /** Prevents callers from accidentally supplying an incompatible durable source. */
  durable?: undefined;

  /** Supplies every named transient plane exposed by the retained handle. */
  transient: TransientEventSources<Transient>;
}>;

/** Immutable evidence shared by both atomic attachment close paths. */
const detachedAttachmentEvidence: LiveAttachmentCloseEvidence = Object.freeze({ kind: 'detached' });

/**
 * Creates a bridge factory over borrowed hot sources without owning their work.
 * @param sources - Versioned state and event sources attached as one barrier.
 * @returns A factory whose attach method synchronously installs queues.
 */
export function createAtomicLiveAttachmentSource<State, Transient extends Readonly<Record<string, unknown>>>(
  sources: AtomicLiveAttachmentSourceWithoutDurableOptions<State, Transient>,
): AtomicLiveAttachmentSource<State, string, never, never, Transient>;

/**
 * Creates a bridge factory for a handle with durable and transient observations.
 * @param sources - Versioned state plus durable and transient event sources.
 * @returns A factory whose attachment includes source-branded durable replay.
 */
export function createAtomicLiveAttachmentSource<
  State,
  Source extends string,
  DurableEvent,
  Transient extends Readonly<Record<string, unknown>>,
>(
  sources: AtomicLiveAttachmentSourceOptions<State, Source, DurableEvent, Transient>,
): AtomicLiveAttachmentSource<State, Source, StreamCursor<Source>, DurableEvent, Transient>;

/**
 * Implements both durable and transient-only overloads through one atomic sequence.
 * @param sources - Borrowed state and event publishers for one retained handle.
 * @returns A typed factory matching the presence or absence of durable history.
 */
export function createAtomicLiveAttachmentSource<
  State,
  Source extends string,
  DurableEvent,
  Transient extends Readonly<Record<string, unknown>>,
>(
  sources:
    | AtomicLiveAttachmentSourceOptions<State, Source, DurableEvent, Transient>
    | AtomicLiveAttachmentSourceWithoutDurableOptions<State, Transient>,
):
  | AtomicLiveAttachmentSource<State, Source, StreamCursor<Source>, DurableEvent, Transient>
  | AtomicLiveAttachmentSource<State, string, never, never, Transient> {
  /**
   * Installs event and state queues before capturing their shared seed.
   * @param options - Delivery selections for the attached planes.
   * @returns A promise already containing the synchronously assembled attachment.
   */
  const attachLive = async <const Planes extends keyof Transient = keyof Transient>(
    options: LiveAttachmentOptions<StreamCursor<Source>, Transient, Planes> = {},
  ) => {
    /** Tracks each queue in construction order for reverse rollback on failure. */
    const attached: OwnedHandle<unknown>[] = [];

    try {
      /** Attaches durable delivery before the seed captures its current cursor. */
      const durable = sources.durable?.subscribe(options.durable);
      if (durable !== undefined) attached.push(durable);

      /** Gives runtime plane lookup one indexable view after TypeScript key validation. */
      const transientSources = sources.transient as Readonly<Record<string, TransientEventSource<unknown>>>;

      /** Selects every plane by default and only named planes when selection is explicit. */
      const selectedPlanes =
        options.transient === undefined ? Object.keys(transientSources) : Object.keys(options.transient);

      /** Attaches every selected transient lane before any seed identity is read. */
      const transientEntries = selectedPlanes.map((plane) => {
        /** Resolves the source selected by this already type-checked plane name. */
        const transientSource = transientSources[plane];
        if (transientSource === undefined) throw new RangeError(`Unknown transient plane: ${plane}`);
        /** Owns this plane's queue until attachment close or construction rollback. */
        const subscription = transientSource.subscribe(options.transient?.[plane as Planes]);
        attached.push(subscription);
        return [plane, subscription] as const;
      });

      /** Attaches the state lane before reading its versioned seed. */
      const stateUpdates = new LatestStateSubscription(sources.state);
      attached.push(stateUpdates);

      /** Captures the state side of the barrier exactly once. */
      const stateSeed = sources.state.getVersionedSnapshot();
      stateUpdates.seed(stateSeed);

      /** Captures the barrier only after every requested queue exists. */
      const seed = Object.freeze({
        state: stateSeed,
        ...(sources.durable === undefined
          ? {}
          : { durable: Object.freeze({ source: sources.durable.source, at: sources.durable.currentCursor() }) }),
        transient: Object.freeze(
          Object.fromEntries(
            selectedPlanes.map((plane) => {
              /** Resolves the same selected source used to construct its queue. */
              const transientSource = transientSources[plane];
              if (transientSource === undefined) throw new RangeError(`Unknown transient plane: ${plane}`);
              return [plane, Object.freeze({ source: transientSource.source, epoch: transientSource.epoch })];
            }),
          ),
        ),
      });

      /** Settles coordinated detachment independently of borrowed sources. */
      let closePromise: Promise<LiveAttachmentCloseEvidence> | undefined;

      /** Resolves the stable `closed` promise when coordinated detachment finishes. */
      let settleClosed: ((evidence: LiveAttachmentCloseEvidence) => void) | undefined;

      /** Rejects the stable `closed` promise when any child close rejects. */
      let rejectClosed: ((reason: unknown) => void) | undefined;

      /** Exposes one lifecycle promise before or after close begins. */
      const closed = new Promise<LiveAttachmentCloseEvidence>((resolve, reject) => {
        settleClosed = resolve;
        rejectClosed = reject;
      });

      /** Owns exactly the queues assembled for this attachment. */
      const attachment = {
        seed,
        stateUpdates,
        durable,
        transient: Object.freeze(Object.fromEntries(transientEntries)),
        closed,
        /**
         * Detaches every queue without closing a borrowed source.
         * @returns Shared attachment evidence.
         */
        close() {
          closePromise ??= Promise.all([
            stateUpdates.close(),
            ...(durable === undefined ? [] : [durable.close()]),
            ...transientEntries.map(([, subscription]) => subscription.close()),
          ]).then(() => detachedAttachmentEvidence);
          /** Mirrors the one coordinated close settlement through lifecycle observation. */
          void closePromise.then(
            (evidence) => settleClosed?.(evidence),
            (error: unknown) => rejectClosed?.(error),
          );
          return closePromise;
        },
        /** Delegates language disposal to coordinated detachment. */
        async [Symbol.asyncDispose]() {
          await attachment.close();
        },
      } as
        | AtomicLiveAttachment<State, Source, StreamCursor<Source>, DurableEvent, Pick<Transient, Planes>>
        | AtomicLiveAttachment<State, string, never, never, Pick<Transient, Planes>>;

      return Object.freeze(attachment);
    } catch (error) {
      /** Releases every successfully constructed queue in reverse ownership order. */
      for (const handle of attached.reverse()) {
        try {
          await handle.close();
        } catch {
          /** Preserves the original construction failure rather than masking its cause. */
        }
      }
      throw error;
    }
  };

  return Object.freeze({ attachLive }) as
    | AtomicLiveAttachmentSource<State, Source, StreamCursor<Source>, DurableEvent, Transient>
    | AtomicLiveAttachmentSource<State, string, never, never, Transient>;
}
