/**
 * @file Implements Archer's bounded public event bridge over shared hot RxJS
 * graphs without exporting RxJS types.
 */

import { Subject } from 'rxjs';

import { toProtocolFailure } from '../protocol.js';
import type { OwnedHandle } from '../ownership.js';
import { CanonicalDecimalSchema } from '../values.js';
import { createStreamCursorCodec, type StreamCursorCodec } from './cursor.js';
import type {
  DeliveryBounds,
  DeliveryConfiguration,
  DeliveryGap,
  DeliveryLimits,
  EventSubscription,
  LiveState,
  ReplayableEvent,
  ReplayableEventStream,
  ReplayDeliveryOptions,
  ReplayStreamClose,
  StreamCursor,
  TransientDeliveryOptions,
  TransientDelivery,
  TransientEventStream,
  TransientStreamClose,
  Unsubscribe,
} from './contracts.js';

/** Schedules notification work outside a producer's publication stack. */
export type ScheduleTask = (task: () => void) => void;

/** Measures one event using its versioned wire representation. */
export type MeasureEvent<Event> = (event: Event) => number;

/** Copies and validates caller input into one source-owned immutable event. */
export type NormalizeEvent<Event> = (event: Event) => Event;

/** Binds source-owned normalization and byte accounting to one protocol revision. */
export type EventEncoding<Event> = Readonly<{
  /** Identifies the canonical wire representation whose bytes are measured. */
  revision: string;

  /** Owns event identity before byte measurement, retention, or fan-out. */
  normalize: NormalizeEvent<Event>;

  /** Measures one event using that exact canonical wire representation. */
  measure: MeasureEvent<Event>;
}>;

/** Reports a current-state listener failure without failing the state source. */
export type ListenerErrorReporter = (error: unknown) => void;

/** Explains normal completion of a core-owned hot source. */
export type EventSourceCloseEvidence = Readonly<{
  /** Identifies normal source completion. */
  kind: 'completed';
}>;

/** Configures callback scheduling and isolated error reporting for current state. */
export type LiveStateOptions = Readonly<{
  /** Defers each coalesced listener callback outside the publication stack. */
  schedule?: ScheduleTask;

  /** Receives callback failures after Archer isolates the throwing listener. */
  onListenerError?: ListenerErrorReporter;
}>;

/** Owns publication and completion for one shared current-state graph. */
export interface LiveStateSource<State> extends LiveState<State>, OwnedHandle<EventSourceCloseEvidence> {
  /** Replaces current state by identity and schedules coalesced observation. */
  publish(snapshot: State): void;
}

/** Default delivery selected when a subscriber supplies no narrower options. */
export type ReplayDeliveryDefaults = DeliveryConfiguration<'resume-required' | 'detach'>;

/** Configures one retained durable observation source. */
export type ReplayableEventSourceOptions<Event, Source extends string> = Readonly<{
  /** Brands this family of cursor at compile time and on the wire. */
  source: Source;

  /** Distinguishes logical streams inside one cursor family. */
  streamId: string;

  /** Binds cursor replay to one tenant, project, or authorization scope. */
  scope?: string;

  /** Identifies the replaceable generation of this logical stream. */
  epoch: string;

  /** Limits the number of envelopes available for later replay. */
  retentionItems: number;

  /** Binds event ownership, byte limits, and cursors to one protocol revision. */
  eventEncoding: EventEncoding<Event>;

  /** Selects safe per-subscriber bounds and overflow behavior. */
  delivery?: Partial<ReplayDeliveryDefaults>;

  /** Caps caller overrides independently of the source's safe defaults. */
  maximumDelivery?: DeliveryBounds;
}>;

/** Owns publication, replay history, and completion for one durable hot graph. */
export interface ReplayableEventSource<Event, Source extends string>
  extends ReplayableEventStream<Event, StreamCursor<Source>>, OwnedHandle<EventSourceCloseEvidence> {
  /** Names the cursor source family for atomic seeds and transport routing. */
  readonly source: Source;

  /** Declares the largest subscriber queue this source permits. */
  readonly deliveryLimits: DeliveryLimits;

  /** Publishes the official encoder and verifier for this source's cursors. */
  readonly cursorCodec: StreamCursorCodec<Source>;

  /** Publishes the exact normalization and encoded-byte protocol used. */
  readonly eventEncoding: EventEncoding<Event>;

  /** Returns the cursor consistent with all events accepted before this call. */
  currentCursor(): StreamCursor<Source>;

  /** Records and fans out one durable observation exactly once. */
  publish(event: Event): ReplayableEvent<Event, StreamCursor<Source>>;
}

/**
 * Stages durable event typing so source identity still infers from configuration.
 * @returns A source factory requiring only the event type up front.
 */
export function replayableEventSource<Event>() {
  return <const Source extends string>(options: ReplayableEventSourceOptions<Event, Source>) =>
    createReplayableEventSource<Event, Source>(options);
}

/** Default delivery selected when a transient subscriber supplies no options. */
export type TransientDeliveryDefaults = DeliveryConfiguration<'gap' | 'detach'>;

/** Configures one non-durable presentation or diagnostic source. */
export type TransientEventSourceOptions<Event> = Readonly<{
  /** Names the logical signal plane in gap evidence. */
  source: string;

  /** Identifies the replaceable generation of this signal plane. */
  epoch: string;

  /** Binds event ownership and byte limits to one protocol revision. */
  eventEncoding: EventEncoding<Event>;

  /** Selects safe per-subscriber bounds and overflow behavior. */
  delivery?: Partial<TransientDeliveryDefaults>;

  /** Caps caller overrides independently of the source's safe defaults. */
  maximumDelivery?: DeliveryBounds;
}>;

/** Owns publication and completion for one transient shared hot graph. */
export interface TransientEventSource<Event>
  extends TransientEventStream<Event>, OwnedHandle<EventSourceCloseEvidence> {
  /** Identifies this non-replayable source generation for atomic seeds. */
  readonly epoch: string;

  /** Names this signal plane for loss accounting and transport routing. */
  readonly source: string;

  /** Declares the largest subscriber queue this source permits. */
  readonly deliveryLimits: DeliveryLimits;

  /** Publishes the exact normalization and encoded-byte protocol used. */
  readonly eventEncoding: EventEncoding<Event>;

  /** Fans out one non-authoritative value without awaiting subscribers. */
  publish(event: Event): void;
}

/**
 * Stages transient event typing without forcing unrelated source generics.
 * @returns A source factory requiring only the event type up front.
 */
export function transientEventSource<Event>() {
  return (options: TransientEventSourceOptions<Event>) => createTransientEventSource<Event>(options);
}

/**
 * Narrows a state publisher to observation capability at a consumer boundary.
 * @param source - Retained current-state publisher owned by its parent.
 * @returns A frozen read-and-subscribe facade with no publication or close authority.
 */
export function asLiveState<State>(source: LiveState<State>): LiveState<State> {
  return Object.freeze({
    /**
     * Reads the publisher's current snapshot through the narrowed facade.
     * @returns Current immutable state.
     */
    getSnapshot: () => source.getSnapshot(),
    /**
     * Attaches one current-state observer through the narrowed facade.
     * @param listener - Callback receiving deferred state replacement.
     * @returns Synchronous idempotent detachment.
     */
    subscribe: (listener: (snapshot: State) => void) => source.subscribe(listener),
  });
}

/**
 * Narrows a durable publisher to replay observation capability.
 * @param source - Retained durable publisher owned by its parent.
 * @returns A frozen subscribe-only facade with no publication or close authority.
 */
export function asReplayableEventStream<Event, Cursor extends StreamCursor<string>>(
  source: ReplayableEventStream<Event, Cursor>,
): ReplayableEventStream<Event, Cursor> {
  return Object.freeze({
    kind: 'replayable',
    /**
     * Attaches one bounded durable observer through the narrowed facade.
     * @param options - Cursor replay and delivery selections.
     * @returns The independent replay subscription.
     */
    subscribe: (options?: ReplayDeliveryOptions<Cursor>) => source.subscribe(options),
  });
}

/**
 * Narrows a transient publisher to presentation observation capability.
 * @param source - Retained transient publisher owned by its parent.
 * @returns A frozen subscribe-only facade with no publication or close authority.
 */
export function asTransientEventStream<Event>(source: TransientEventStream<Event>): TransientEventStream<Event> {
  return Object.freeze({
    kind: 'transient',
    /**
     * Attaches one bounded transient observer through the narrowed facade.
     * @param options - Loss and delivery selections.
     * @returns The independent transient subscription.
     */
    subscribe: (options?: TransientDeliveryOptions) => source.subscribe(options),
  });
}

/** A manually settled promise used to coordinate idempotent lifecycle evidence. */
type Deferred<Value> = Readonly<{
  /** Promise observed by the public lifecycle contract. */
  promise: Promise<Value>;

  /** Settles the promise exactly once through native Promise semantics. */
  resolve(value: Value): void;
}>;

/**
 * Creates a retained promise and its settlement capability.
 * @returns A frozen deferred pair.
 */
function deferred<Value>(): Deferred<Value> {
  /** Captures the native resolver during promise construction. */
  let settle: ((value: Value) => void) | undefined;

  /** Exposes lifecycle settlement before closure begins. */
  const promise = new Promise<Value>((resolve) => {
    settle = resolve;
  });

  return Object.freeze({
    promise,
    /**
     * Settles the retained lifecycle promise once.
     * @param value - Immutable terminal evidence.
     */
    resolve(value: Value) {
      settle?.(value);
    },
  });
}

/**
 * Uses the platform microtask queue as the production notification boundary.
 * @param task - Deferred work that must run after the publication stack.
 * @returns Nothing; the host owns later execution.
 */
const defaultSchedule: ScheduleTask = (task) => queueMicrotask(task);

/** Immutable evidence shared by every normally completed source. */
const completedSourceEvidence: EventSourceCloseEvidence = Object.freeze({ kind: 'completed' });

/** Mutable listener bookkeeping hidden behind the immutable LiveState contract. */
interface ListenerSlot<State> {
  /** Prevents detached listeners from receiving already-scheduled work. */
  active: boolean;

  /** Coalesces arbitrarily many publications into one scheduled callback. */
  scheduled: boolean;

  /** Receives the latest snapshot when scheduled work executes. */
  listener(snapshot: State): void;
}

/**
 * Creates a shared hot current-state source with deferred, coalescing callbacks.
 * @param initial - Immutable current state visible before the first publication.
 * @param options - Optional scheduling and listener-failure integration.
 * @returns The retained source capability used by an owning handle.
 */
export function createLiveState<State>(initial: State, options: LiveStateOptions = {}): LiveStateSource<State> {
  /** Owns the single RxJS activation graph for current-state changes. */
  const graph = new Subject<State>();

  /** Tracks public listeners independently of RxJS declarations. */
  const listeners = new Set<ListenerSlot<State>>();

  /** Settles the retained lifecycle for both close access paths. */
  const lifecycle = deferred<EventSourceCloseEvidence>();

  /** Defers callbacks through the configured host scheduling boundary. */
  const schedule = options.schedule ?? defaultSchedule;

  /** Preserves object identity until a producer explicitly replaces state. */
  let snapshot = initial;

  /** Prevents publication and listener attachment after completion. */
  let closed = false;

  graph.subscribe((next) => {
    snapshot = next;
    /** Visits each listener exactly once for the current publication. */
    for (const slot of listeners) {
      if (slot.scheduled) continue;
      slot.scheduled = true;
      schedule(() => {
        slot.scheduled = false;
        if (!slot.active || closed) return;
        try {
          slot.listener(snapshot);
        } catch (error) {
          options.onListenerError?.(error);
        }
      });
    }
  });

  /** Returns one frozen structural interface without exposing the Subject. */
  const source: LiveStateSource<State> = {
    closed: lifecycle.promise,
    /**
     * Reads the stable current snapshot.
     * @returns Current state by identity.
     */
    getSnapshot() {
      return snapshot;
    },
    /**
     * Attaches one deferred current-state listener.
     * @param listener - Callback receiving the latest coalesced snapshot.
     * @returns Synchronous idempotent detachment.
     */
    subscribe(listener): Unsubscribe {
      if (closed) return () => undefined;
      /** Owns this callback's detachment and coalescing state. */
      const slot: ListenerSlot<State> = { active: true, scheduled: false, listener };
      listeners.add(slot);
      return () => {
        if (!slot.active) return;
        slot.active = false;
        listeners.delete(slot);
      };
    },
    /**
     * Replaces current state without awaiting observers.
     * @param next - New immutable snapshot.
     */
    publish(next) {
      if (closed) return;
      graph.next(next);
    },
    /**
     * Completes this publisher idempotently.
     * @returns Shared source close evidence.
     */
    close() {
      if (!closed) {
        closed = true;
        /** Marks every listener inactive before lifecycle settlement. */
        for (const slot of listeners) slot.active = false;
        listeners.clear();
        graph.complete();
        lifecycle.resolve(completedSourceEvidence);
      }
      return lifecycle.promise;
    },
    /** Delegates language disposal to source completion. */
    async [Symbol.asyncDispose]() {
      await source.close();
    },
  };

  return Object.freeze(source);
}

/** One value retained in a subscriber-local bounded queue. */
type Queued<Value> = Readonly<{
  /** Public value returned to the iterator. */
  value: Value;

  /** Encoded bytes charged against this subscriber. */
  bytes: number;
}>;

/** Resolves one outstanding iterator pull. */
type Pull<Value> = (result: IteratorResult<Value>) => void;

/**
 * Owns a single-subscriber queue and contains all mutable iterator lifecycle.
 * Source-specific wrappers decide what overflow and terminal evidence mean.
 */
class BoundedQueue<Value, Close, Overflow extends string> implements EventSubscription<Value, Close, Overflow> {
  /** Exposes immutable selected bounds through the public subscription. */
  readonly delivery: DeliveryConfiguration<Overflow>;

  /** Settles once this queue detaches or drains a sealed source. */
  readonly closed: Promise<Close>;

  /** Retains accepted values in exact source order. */
  readonly #queue: Queued<Value>[] = [];

  /** Retains concurrent consumer pulls in call order. */
  readonly #pulls: Pull<Value>[] = [];

  /** Owns immutable close settlement. */
  readonly #lifecycle = deferred<Close>();

  /** Creates subscriber-specific evidence for explicit close. */
  readonly #detached: () => Close;

  /** Runs when a pull makes bounded capacity available again. */
  readonly #onCapacity: () => void;

  /** Records delivery-dependent evidence such as the last returned cursor. */
  readonly #onDelivered: (value: Value) => void;

  /** Tracks the encoded bytes currently retained in the queue. */
  #queuedBytes = 0;

  /** Prevents acceptance after immediate termination or source sealing. */
  #accepting = true;

  /** Prevents duplicate close settlement and iterator completion. */
  #finished = false;

  /** Defers source terminal evidence until accepted values drain. */
  #sealedEvidence: (() => Close) | undefined;

  /**
   * Creates one independent queue with source-specific lifecycle callbacks.
   * @param delivery - Selected immutable bound and overflow policy.
   * @param detached - Creates evidence for explicit subscriber detachment.
   * @param onDelivered - Observes values only after they reach the consumer.
   * @param onCapacity - Allows gap markers to claim newly available capacity.
   */
  constructor(
    delivery: DeliveryConfiguration<Overflow>,
    detached: () => Close,
    onDelivered: (value: Value) => void = () => undefined,
    onCapacity: () => void = () => undefined,
  ) {
    this.delivery = delivery;
    this.closed = this.#lifecycle.promise;
    this.#detached = detached;
    this.#onDelivered = onDelivered;
    this.#onCapacity = onCapacity;
  }

  /**
   * Returns whether this queue still accepts source values.
   * @returns Current acceptance state.
   */
  get accepting(): boolean {
    return this.#accepting;
  }

  /**
   * Returns whether one value can fit under the item bound.
   * @returns True when item capacity remains.
   */
  get hasItemCapacity(): boolean {
    return this.#queue.length < this.delivery.capacityItems;
  }

  /**
   * Offers a value without blocking the producer.
   * @param value - Public value in source order.
   * @param bytes - Non-negative encoded byte size charged to this subscriber.
   * @returns True when accepted directly or into the bounded queue.
   */
  offer(value: Value, bytes: number): boolean {
    if (!this.#accepting) return false;
    /** Removes the oldest waiting pull so source delivery remains FIFO. */
    const pull = this.#pulls.shift();
    if (pull !== undefined) {
      this.#onDelivered(value);
      pull({ done: false, value });
      return true;
    }

    if (this.#queue.length >= this.delivery.capacityItems || bytes > this.delivery.capacityBytes - this.#queuedBytes) {
      return false;
    }

    this.#queue.push({ value, bytes });
    this.#queuedBytes += bytes;
    return true;
  }

  /**
   * Stops acceptance immediately and discards queued observations.
   * @param evidence - Immutable source-specific terminal evidence.
   */
  terminate(evidence: Close): void {
    if (this.#finished) return;
    this.#accepting = false;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#finish(evidence);
  }

  /**
   * Stops acceptance while allowing already accepted values to drain in FIFO order.
   * @param evidence - Creates evidence after the final value is delivered.
   */
  seal(evidence: () => Close): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#sealedEvidence = evidence;
    if (this.#queue.length === 0) this.#finish(evidence());
  }

  /**
   * Detaches this subscriber immediately without changing its source.
   * @returns Shared terminal evidence.
   */
  close(): Promise<Close> {
    this.terminate(this.#detached());
    return this.closed;
  }

  /** Delegates language-level disposal to the same idempotent close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Returns one iterator whose return path detaches this subscription.
   * @returns The subscription iterator.
   */
  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      /**
       * Pulls one queued or future source value.
       * @returns The next iterator result.
       */
      next: () => this.#next(),
      /**
       * Detaches iteration early.
       * @returns A completed iterator result.
       */
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Pulls a queued value or waits for the next accepted source value.
   * @returns The pending iterator result.
   */
  #next(): Promise<IteratorResult<Value>> {
    /** Removes the oldest accepted queue entry for delivery. */
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      this.#queuedBytes -= queued.bytes;
      this.#onDelivered(queued.value);
      this.#onCapacity();
      if (this.#queue.length === 0 && this.#sealedEvidence !== undefined) this.#finish(this.#sealedEvidence());
      return Promise.resolve({ done: false, value: queued.value });
    }

    if (this.#finished || !this.#accepting) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#pulls.push(resolve));
  }

  /**
   * Settles close evidence and every outstanding pull exactly once.
   * @param evidence - Immutable terminal record for this subscriber.
   */
  #finish(evidence: Close): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#accepting = false;
    this.#sealedEvidence = undefined;
    /** Completes every pending consumer pull during terminal settlement. */
    for (const pull of this.#pulls.splice(0)) pull({ done: true, value: undefined });
    this.#lifecycle.resolve(Object.freeze(evidence));
  }
}

/**
 * Validates and freezes a subscriber's effective delivery configuration.
 * @param defaults - Source-selected delivery defaults.
 * @param options - Subscriber-selected delivery overrides.
 * @param limits - Optional source-declared maxima for subscriber overrides.
 * @returns A validated immutable effective configuration.
 */
function deliveryConfiguration<Overflow extends string>(
  defaults: DeliveryConfiguration<Overflow>,
  options: DeliveryBounds &
    Readonly<{
      /** Selects the source-specific response to queue exhaustion. */
      overflow?: Overflow;
    }> = {},
  limits?: DeliveryLimits,
): DeliveryConfiguration<Overflow> {
  /** Applies caller narrowing or expansion over source defaults. */
  const selected = {
    capacityItems: options.capacityItems ?? defaults.capacityItems,
    capacityBytes: options.capacityBytes ?? defaults.capacityBytes,
    overflow: options.overflow ?? defaults.overflow,
  };

  if (!Number.isSafeInteger(selected.capacityItems) || selected.capacityItems < 1) {
    throw new RangeError('capacityItems must be a positive safe integer');
  }
  if (!Number.isSafeInteger(selected.capacityBytes) || selected.capacityBytes < 1) {
    throw new RangeError('capacityBytes must be a positive safe integer');
  }
  if (limits !== undefined && selected.capacityItems > limits.capacityItems) {
    throw new RangeError('capacityItems exceeds the source-declared maximum');
  }
  if (limits !== undefined && selected.capacityBytes > limits.capacityBytes) {
    throw new RangeError('capacityBytes exceeds the source-declared maximum');
  }
  return Object.freeze(selected);
}

/**
 * Validates source-declared queue maxima against their safe defaults.
 * @param defaults - Effective source defaults inherited by subscribers.
 * @param requested - Optional larger source-owned maxima.
 * @returns Immutable item and byte maxima.
 */
function sourceDeliveryLimits<Overflow extends string>(
  defaults: DeliveryConfiguration<Overflow>,
  requested: DeliveryBounds | undefined,
): DeliveryLimits {
  /** Uses each safe default as its own maximum unless the source opts into more. */
  const selected = deliveryConfiguration(defaults, {
    capacityItems: requested?.capacityItems ?? defaults.capacityItems,
    capacityBytes: requested?.capacityBytes ?? defaults.capacityBytes,
  });
  if (selected.capacityItems < defaults.capacityItems || selected.capacityBytes < defaults.capacityBytes) {
    throw new RangeError('source-declared maximum delivery cannot be smaller than its default');
  }
  return Object.freeze({ capacityItems: selected.capacityItems, capacityBytes: selected.capacityBytes });
}

/**
 * Measures one event before source mutation and rejects dishonest protocol sizes.
 * @param measure - Source protocol's encoded-byte measurement.
 * @param event - Candidate source value.
 * @returns A finite non-negative safe-integer byte size.
 */
function measureEvent<Event>(measure: MeasureEvent<Event>, event: Event): number {
  /** Evaluates the source protocol once so admission and fan-out share one size. */
  const bytes = measure(event);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('event measurement must be a non-negative safe integer');
  }
  return bytes;
}

/** One normalized event paired with the byte charge derived from that value. */
type AdmittedEvent<Event> = Readonly<{
  /** Source-owned immutable value retained and delivered after admission. */
  event: Event;

  /** Exact safe-integer byte charge for this individual value. */
  bytes: number;
}>;

/**
 * Normalizes and measures one candidate before any source state changes.
 * @param encoding - Source-owned normalization and wire measurement contract.
 * @param candidate - Caller-owned event offered for admission.
 * @returns The source-owned event and its exact individual byte charge.
 */
function admitEvent<Event>(encoding: EventEncoding<Event>, candidate: Event): AdmittedEvent<Event> {
  /** Breaks caller aliasing before retained evidence or fan-out can observe the value. */
  const event = encoding.normalize(candidate);
  return Object.freeze({ event, bytes: measureEvent(encoding.measure, event) });
}

/**
 * Validates and freezes one caller-supplied event encoding contract.
 * @param encoding - Protocol revision, source normalization, and encoded-byte measurement.
 * @returns An immutable encoding reused by source admission and public inspection.
 */
function eventEncoding<Event>(encoding: EventEncoding<Event>): EventEncoding<Event> {
  if (encoding.revision.trim().length === 0) {
    throw new RangeError('event encoding revision must not be empty');
  }
  if (typeof encoding.measure !== 'function') {
    throw new TypeError('event encoding measurement must be a function');
  }
  if (typeof encoding.normalize !== 'function') {
    throw new TypeError('event encoding normalization must be a function');
  }
  return Object.freeze({ revision: encoding.revision, normalize: encoding.normalize, measure: encoding.measure });
}

/** Mutable durable history record retained by one replay source. */
type Retained<Event, Source extends string> = Readonly<{
  /** Monotonic position used for retention and replay comparisons. */
  offset: bigint;

  /** Public envelope delivered to subscribers. */
  envelope: ReplayableEvent<Event, StreamCursor<Source>>;

  /** Encoded bytes charged to subscriber queues. */
  bytes: number;
}>;

/**
 * Creates a bounded durable stream with source-validated cursor replay.
 * @param options - Source identity, retention, normalization, measurement, and delivery defaults.
 * @returns A retained publisher and replayable public stream.
 */
export function createReplayableEventSource<Event, Source extends string>(
  options: ReplayableEventSourceOptions<Event, Source>,
): ReplayableEventSource<Event, Source> {
  if (!Number.isSafeInteger(options.retentionItems) || options.retentionItems < 1) {
    throw new RangeError('retentionItems must be a positive safe integer');
  }

  /** Owns the single live RxJS graph shared by every replay subscriber. */
  const graph = new Subject<Retained<Event, Source>>();

  /** Retains only the configured replay suffix. */
  const history: Retained<Event, Source>[] = [];

  /** Settles the source owner independently of subscriber drain. */
  const lifecycle = deferred<EventSourceCloseEvidence>();

  /** Binds source admission and cursors to one inspected protocol encoding. */
  const encoding = eventEncoding(options.eventEncoding);

  /** Selects immutable defaults inherited by each subscriber. */
  const defaults = deliveryConfiguration<'resume-required' | 'detach'>(
    { capacityItems: 256, capacityBytes: 1024 * 1024, overflow: 'resume-required' },
    options.delivery,
  );

  /** Caps subscriber overrides at the maximum explicitly owned by this source. */
  const limits = sourceDeliveryLimits(defaults, options.maximumDelivery);

  /** Owns official cursor construction and identity verification for this source. */
  const cursorCodec = createStreamCursorCodec({
    revision: encoding.revision,
    source: options.source,
    scope: options.scope ?? 'local',
    streamId: options.streamId,
    epoch: options.epoch,
  });

  /** Tracks the current monotonic source position without numeric truncation. */
  let offset = 0n;

  /** Prevents event acceptance after source completion. */
  let closed = false;

  /**
   * Creates the cursor consistent with the current accepted offset.
   * @returns The current durable replay barrier.
   */
  const currentCursor = (): StreamCursor<Source> => cursorCodec.encode(offset);

  /**
   * Returns a failed subscription for a structurally invalid cursor.
   * @param code - Stable public protocol failure category.
   * @param message - Bounded public explanation of the violation.
   * @returns An already-failed independent subscription.
   */
  const failedSubscription = (
    code: string,
    message: string,
  ): EventSubscription<
    ReplayableEvent<Event, StreamCursor<Source>>,
    ReplayStreamClose<StreamCursor<Source>>,
    'resume-required' | 'detach'
  > => {
    /** Uses selected defaults because no valid replay attachment was established. */
    const queue = new BoundedQueue<
      ReplayableEvent<Event, StreamCursor<Source>>,
      ReplayStreamClose<StreamCursor<Source>>,
      'resume-required' | 'detach'
    >(defaults, () => ({ kind: 'detached' }));
    queue.terminate({
      kind: 'failed',
      failure: toProtocolFailure(new Error(message), { code, message }),
    });
    return queue;
  };

  /** Constructs one public source facade around private history and Subject state. */
  const source: ReplayableEventSource<Event, Source> = {
    kind: 'replayable',
    source: options.source,
    deliveryLimits: limits,
    cursorCodec,
    eventEncoding: encoding,
    closed: lifecycle.promise,
    currentCursor,
    /**
     * Attaches one bounded replay queue to the existing source graph.
     * @param replayOptions - Cursor and delivery selections.
     * @returns The independent durable event subscription.
     */
    subscribe(replayOptions: ReplayDeliveryOptions<StreamCursor<Source>> = {}) {
      /** Captures the seed position used when no value has reached the consumer. */
      const start = replayOptions.after ?? currentCursor();

      /** Tracks the last envelope actually returned rather than merely queued. */
      let delivered: StreamCursor<Source> | undefined;

      if (replayOptions.after !== undefined) {
        /** Decodes the caller's cursor once before source and retention checks. */
        const decoded = cursorCodec.decode(replayOptions.after);
        if (!decoded.ok) return failedSubscription(decoded.error.code, decoded.error.message);
        /** Retains decoded identity and position after public codec verification. */
        const parsed = decoded.value;
        if (parsed.epoch !== options.epoch) {
          /** A minimal closed queue carries the explicit source replacement outcome. */
          const replaced = new BoundedQueue<
            ReplayableEvent<Event, StreamCursor<Source>>,
            ReplayStreamClose<StreamCursor<Source>>,
            'resume-required' | 'detach'
          >(defaults, () => ({ kind: 'detached' }));
          replaced.terminate({ kind: 'reseed-required', reason: 'source-replaced' });
          return replaced;
        }
        /** Converts the validated arbitrary-precision position without number loss. */
        const parsedOffset = BigInt(parsed.offset);
        /** Finds the first retained position for cursor-expiration comparison. */
        const earliest = history[0]?.offset ?? offset + 1n;
        if (parsedOffset < earliest - 1n) {
          /** Retention loss cannot be repaired by silently joining live delivery. */
          const expired = new BoundedQueue<
            ReplayableEvent<Event, StreamCursor<Source>>,
            ReplayStreamClose<StreamCursor<Source>>,
            'resume-required' | 'detach'
          >(defaults, () => ({ kind: 'detached' }));
          expired.terminate({ kind: 'reseed-required', reason: 'cursor-expired' });
          return expired;
        }
        if (parsedOffset > offset)
          return failedSubscription('cursor_ahead', 'The replay cursor is ahead of its source');
      }

      /** Applies this subscriber's independent bound and overflow policy. */
      const delivery = deliveryConfiguration(defaults, replayOptions, limits);

      /** Owns the subscriber queue and delivery-dependent cursor evidence. */
      const queue = new BoundedQueue<
        ReplayableEvent<Event, StreamCursor<Source>>,
        ReplayStreamClose<StreamCursor<Source>>,
        'resume-required' | 'detach'
      >(
        delivery,
        () => ({ kind: 'detached', ...(delivered === undefined ? {} : { after: delivered }) }),
        (envelope) => {
          delivered = envelope.cursor;
        },
      );

      /**
       * Offers one retained value and applies this subscriber's overflow contract.
       * @param record - Retained durable envelope and encoded size.
       */
      const offer = (record: Retained<Event, Source>): void => {
        if (queue.offer(record.envelope, record.bytes)) return;
        if (!queue.accepting) return;
        if (delivery.overflow === 'resume-required') {
          queue.terminate({ kind: 'resume-required', after: delivered ?? start });
        } else {
          queue.terminate({ kind: 'detached', ...(delivered === undefined ? {} : { after: delivered }) });
        }
      };

      /** Joins the live graph before replaying retained history in the same stack. */
      const live = graph.subscribe({
        next: offer,
        /** Seals accepted values when the shared durable source completes. */
        complete: () => {
          queue.seal(() => ({ kind: 'completed', ...(delivered === undefined ? {} : { after: delivered }) }));
        },
      });
      void queue.closed.then(() => live.unsubscribe());

      if (replayOptions.after !== undefined) {
        /** Runtime parsing already succeeded in the validation branch above. */
        const decoded = cursorCodec.decode(replayOptions.after);
        /** Replays each retained successor in monotonic source order. */
        for (const record of history) {
          if (decoded.ok && record.offset > BigInt(decoded.value.offset)) offer(record);
        }
      }

      if (closed) queue.seal(() => ({ kind: 'completed', ...(delivered === undefined ? {} : { after: delivered }) }));
      return queue;
    },
    /**
     * Admits one durable observation before live fan-out.
     * @param event - Durable value admitted by the owning source.
     * @returns The immutable cursor envelope recorded for replay.
     */
    publish(event) {
      if (closed) throw new Error('Cannot publish to a completed replayable source');
      /** Owns and measures the admitted value before advancing durable position. */
      const admitted = admitEvent(encoding, event);
      offset += 1n;
      /** Owns the immutable envelope and its source admission metadata. */
      const record: Retained<Event, Source> = Object.freeze({
        offset,
        envelope: Object.freeze({ cursor: currentCursor(), value: admitted.event }),
        bytes: admitted.bytes,
      });
      history.push(record);
      if (history.length > options.retentionItems) history.shift();
      graph.next(record);
      return record.envelope;
    },
    /**
     * Completes the durable source without waiting for subscribers.
     * @returns Shared source evidence.
     */
    close() {
      if (!closed) {
        closed = true;
        graph.complete();
        lifecycle.resolve(completedSourceEvidence);
      }
      return lifecycle.promise;
    },
    /** Delegates language disposal to durable source completion. */
    async [Symbol.asyncDispose]() {
      await source.close();
    },
  };

  return Object.freeze(source);
}

/** Coordinates pending gap accounting around one bounded transient queue. */
class TransientSubscriber<Event> {
  /** Public queue retained by this subscriber. */
  readonly subscription: BoundedQueue<TransientDelivery<Event>, TransientStreamClose, 'gap' | 'detach'>;

  /** Names the source carried by every coalesced gap marker. */
  readonly #source: string;

  /** Identifies the generation carried by every coalesced gap marker. */
  readonly #epoch: string;

  /** Counts values discarded before the pending marker can be delivered. */
  #lostItems = 0n;

  /** Counts bytes discarded before the pending marker can be delivered. */
  #lostBytes = 0n;

  /** Defers normal source completion until a pending gap marker is accepted. */
  #completing = false;

  /**
   * Creates one transient subscriber with private loss accounting.
   * @param delivery - Selected queue bound and overflow response.
   * @param source - Logical source name included in gap evidence.
   * @param epoch - Source generation included in gap evidence.
   */
  constructor(delivery: TransientDeliveryDefaults, source: string, epoch: string) {
    this.#source = source;
    this.#epoch = epoch;
    this.subscription = new BoundedQueue(
      delivery,
      () => ({ kind: 'detached' }),
      () => undefined,
      () => this.#flushGap(),
    );
  }

  /**
   * Offers one source value or records its exact subscriber-local loss.
   * @param event - Presentation or diagnostic value in source order.
   * @param bytes - Encoded bytes charged to loss and queue bounds.
   */
  offer(event: Event, bytes: number): void {
    if (!this.subscription.accepting) return;
    if (this.#lostItems > 0n) {
      this.#recordLoss(bytes);
      return;
    }
    /** Reserves the outer discriminator so application values cannot impersonate gaps. */
    const delivery: TransientDelivery<Event> = Object.freeze({ kind: 'event', value: event });
    if (this.subscription.offer(delivery, bytes)) return;
    if (this.subscription.delivery.overflow === 'detach') {
      this.subscription.terminate({ kind: 'detached' });
      return;
    }
    this.#recordLoss(bytes);
    this.#flushGap();
  }

  /** Seals the source after ensuring any pending gap remains observable. */
  complete(): void {
    if (!this.subscription.accepting) return;
    if (this.#lostItems === 0n) {
      this.subscription.seal(() => ({ kind: 'completed' }));
      return;
    }
    this.#completing = true;
    this.#flushGap();
  }

  /**
   * Adds one discarded value to the pending exact loss marker.
   * @param bytes - Encoded bytes discarded for this subscriber.
   */
  #recordLoss(bytes: number): void {
    this.#lostItems += 1n;
    this.#lostBytes += BigInt(bytes);
  }

  /** Claims newly available queue capacity for the pending gap marker. */
  #flushGap(): void {
    if (this.#lostItems === 0n || !this.subscription.hasItemCapacity) return;
    /** Captures counts before resetting so reentrant delivery cannot rewrite evidence. */
    const gap: DeliveryGap = Object.freeze({
      kind: 'gap',
      source: this.#source,
      epoch: this.#epoch,
      lostItems: CanonicalDecimalSchema.parse(this.#lostItems.toString()),
      lostBytes: CanonicalDecimalSchema.parse(this.#lostBytes.toString()),
    });
    this.#lostItems = 0n;
    this.#lostBytes = 0n;
    this.subscription.offer(gap, 0);
    if (this.#completing) this.subscription.seal(() => ({ kind: 'completed' }));
  }
}

/**
 * Creates a bounded transient source with exact per-subscriber gap accounting.
 * @param options - Source generation, normalization, byte measurement, and delivery defaults.
 * @returns A retained publisher and transient public stream.
 */
export function createTransientEventSource<Event>(
  options: TransientEventSourceOptions<Event>,
): TransientEventSource<Event> {
  /** Owns the single live RxJS graph shared by every transient subscriber. */
  const graph = new Subject<
    Readonly<{
      /** Non-authoritative source value admitted to the graph. */
      event: Event;

      /** Encoded bytes charged independently to each subscriber. */
      bytes: number;
    }>
  >();

  /** Settles source completion independently of subscriber drain. */
  const lifecycle = deferred<EventSourceCloseEvidence>();

  /** Binds source admission to one inspected protocol encoding. */
  const encoding = eventEncoding(options.eventEncoding);

  /** Selects immutable defaults inherited by each subscriber. */
  const defaults = deliveryConfiguration<'gap' | 'detach'>(
    { capacityItems: 256, capacityBytes: 1024 * 1024, overflow: 'gap' },
    options.delivery,
  );

  /** Caps subscriber overrides at the maximum explicitly owned by this source. */
  const limits = sourceDeliveryLimits(defaults, options.maximumDelivery);

  /** Prevents publication after source completion. */
  let closed = false;

  /** Constructs one public source facade around the private Subject. */
  const source: TransientEventSource<Event> = {
    kind: 'transient',
    source: options.source,
    epoch: options.epoch,
    deliveryLimits: limits,
    eventEncoding: encoding,
    closed: lifecycle.promise,
    /**
     * Attaches one bounded queue to the existing transient graph.
     * @param transientOptions - Subscriber loss and delivery selections.
     * @returns The independent transient event subscription.
     */
    subscribe(transientOptions: TransientDeliveryOptions = {}) {
      /** Owns this subscriber's bound, loss accounting, and iterator. */
      const subscriber = new TransientSubscriber<Event>(
        deliveryConfiguration(defaults, transientOptions, limits),
        options.source,
        options.epoch,
      );
      if (closed) {
        subscriber.complete();
        return subscriber.subscription;
      }
      /** Attaches to the existing graph without causing producer activation. */
      const live = graph.subscribe({
        /**
         * Offers one admitted graph value to this subscriber.
         * @param value - Event and precomputed encoded byte size.
         * @returns Nothing; delivery remains non-blocking.
         */
        next: (value) => subscriber.offer(value.event, value.bytes),
        /**
         * Completes this queue when the shared transient source ends.
         * @returns Nothing.
         */
        complete: () => subscriber.complete(),
      });
      void subscriber.subscription.closed.then(() => live.unsubscribe());
      return subscriber.subscription;
    },
    /**
     * Admits one transient value without awaiting public subscribers.
     * @param event - Non-authoritative source value.
     */
    publish(event) {
      if (closed) return;
      graph.next(admitEvent(encoding, event));
    },
    /**
     * Completes the transient source without waiting for subscribers.
     * @returns Shared source evidence.
     */
    close() {
      if (!closed) {
        closed = true;
        graph.complete();
        lifecycle.resolve(completedSourceEvidence);
      }
      return lifecycle.promise;
    },
    /** Delegates language disposal to transient source completion. */
    async [Symbol.asyncDispose]() {
      await source.close();
    },
  };

  return Object.freeze(source);
}
