/**
 * @file Provides the webhook service API used by both HTTP routes and recovery.
 *
 * The class hides storage handles from route code. Its methods speak in
 * delivery IDs, customer events, status reads, and status listeners.
 */

import { IdempotencyKeySchema, TimestampSchema, type JsonValue } from '@archer/core';
import { CellIdSchema, type CellHandle } from '@archer/core/cells';
import type { S3CellService } from '@archer/core/cells/s3';

import { webhookEffectAdapter, type WebhookProgress } from './delivery.js';
import { WEBHOOK_PROTOCOL, initialWebhookState, type WebhookEvent, type WebhookState } from './domain.js';

/** Event submission accepted from the service's HTTP API. */
export type SubmitWebhookInput = Readonly<{
  /** Customer endpoint that receives the webhook. */
  url: string;

  /** Application event name, such as `invoice.paid`. */
  event: string;

  /** JSON application data placed under the webhook's `data` field. */
  data: JsonValue;
}>;

/** Dependencies for one webhook service process. */
export type WebhookDeliveryServiceOptions = Readonly<{
  /** S3-backed delivery service owned until application shutdown. */
  cells: S3CellService;

  /** Secret used for outbound signatures and never written to Cell state. */
  signingSecret: string;

  /** Supplies UUIDv4 delivery and command IDs and defaults to platform randomness. */
  createId?: () => string;

  /** Supplies retry and recovery time and defaults to wall time. */
  now?: () => Date;

  /** Stops waiting for one customer endpoint after this many milliseconds. */
  requestTimeoutMilliseconds?: number;

  /** Checks saved status at this interval when another process owns the delivery. */
  statusPollMilliseconds?: number;

  /** Replaces platform timeouts for deterministic status-watch scheduling. */
  scheduleStatusRead?: ScheduleStatusRead;
}>;

/** Schedules one later status read and returns synchronous cancellation. */
export type ScheduleStatusRead = (delayMilliseconds: number, task: () => void) => () => void;

/** Response returned once the first delivery attempt has been saved. */
export type SubmittedWebhook = Readonly<{
  /** Public ID used by status and live-update routes. */
  id: import('@archer/core/cells').CellId;

  /** Current saved status when the submission returns. */
  status: WebhookState['status'];
}>;

/** Callback used by HTTP streams and application code to receive current status. */
export type WebhookStatusListener = (state: WebhookState) => void;

/** One live status listener that the caller can detach without stopping delivery work. */
export type WebhookStatusWatch = Readonly<{
  /** Stops only this listener and releases its subscription or polling timer. */
  close(): Promise<void>;
}>;

/** Uses one platform timeout without allowing overlapping status reads. */
function scheduleStatusRead(delayMilliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, delayMilliseconds);
  return () => clearTimeout(timer);
}

/** Returns whether no later saved status can follow this delivery state. */
function isFinished(state: WebhookState): boolean {
  return state.status === 'delivered' || state.status === 'failed';
}

/** Selects only fields that can change while one delivery progresses. */
function statusVersion(state: WebhookState): string {
  return JSON.stringify({
    status: state.status,
    attempt: state.attempt,
    ...('nextAttemptAt' in state ? { nextAttemptAt: state.nextAttemptAt } : {}),
    ...('lastStatus' in state ? { lastStatus: state.lastStatus } : {}),
    ...('lastError' in state ? { lastError: state.lastError } : {}),
  });
}

/** Application API for submitting, watching, reading, and recovering customer webhooks. */
export class WebhookDeliveryService implements AsyncDisposable {
  /** Saves work, resumes it, and owns the underlying S3 resources. */
  readonly #cells: S3CellService;

  /** Creates delivery and command identities at application boundaries. */
  readonly #createId: () => string;

  /** Supplies the service's retry and recovery clock. */
  readonly #now: () => Date;

  /** Performs signed customer requests for new and recovered deliveries. */
  readonly #effects: ReturnType<typeof webhookEffectAdapter>;

  /** Controls how quickly a non-owning process notices saved status changes. */
  readonly #statusPollMilliseconds: number;

  /** Schedules one remote status read at a time. */
  readonly #scheduleStatusRead: ScheduleStatusRead;

  /** Keeps locally owned deliveries reachable while work remains unfinished. */
  readonly #active = new Map<string, CellHandle<WebhookState, WebhookEvent, WebhookProgress>>();

  /** Continues the next bounded recovery page without rescanning the first page. */
  #recoveryCursor: string | undefined;

  /** Shares one in-flight recovery page across overlapping timer or startup calls. */
  #recoveryPromise: Promise<number> | undefined;

  /** Shares application cleanup across HTTP shutdown and process signals. */
  #closePromise: Promise<void> | undefined;

  /**
   * Captures the storage, signing key, and service permissions used by every route.
   * @param options - Fully configured application dependencies.
   */
  constructor(options: WebhookDeliveryServiceOptions) {
    this.#cells = options.cells;
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#effects = webhookEffectAdapter({
      signingSecret: options.signingSecret,
      now: this.#now,
      ...(options.requestTimeoutMilliseconds === undefined
        ? {}
        : { requestTimeoutMilliseconds: options.requestTimeoutMilliseconds }),
    });
    this.#statusPollMilliseconds = options.statusPollMilliseconds ?? 1_000;
    if (!Number.isSafeInteger(this.#statusPollMilliseconds) || this.#statusPollMilliseconds < 1) {
      throw new RangeError('statusPollMilliseconds must be a positive safe integer');
    }
    this.#scheduleStatusRead = options.scheduleStatusRead ?? scheduleStatusRead;
  }

  /**
   * Saves a customer event and starts its first delivery attempt.
   * @param input - Destination, event name, and JSON application data.
   * @returns The delivery ID after the outbound request is safe to resume.
   */
  async submit(input: SubmitWebhookInput): Promise<SubmittedWebhook> {
    const id = CellIdSchema.parse(this.#createId());
    const created = await this.#cells.create({
      cellId: id,
      initialState: initialWebhookState(id, input.url, input.event, input.data),
      protocol: WEBHOOK_PROTOCOL,
      activation: { effects: this.#effects },
      idempotencyKey: IdempotencyKeySchema.parse(this.#createId()),
    });
    if (created.kind !== 'opened') throw new Error(`Webhook delivery could not be created: ${created.kind}`);
    this.#retain(created.handle);

    const started = await this.#cells.dispatch(created.handle, {
      event: Object.freeze({ type: 'start' }),
      idempotencyKey: IdempotencyKeySchema.parse(this.#createId()),
    });
    if (started.kind !== 'acknowledged') throw new Error(`Webhook delivery could not start: ${started.kind}`);
    return Object.freeze({ id, status: created.handle.getSnapshot().acknowledged.state.status });
  }

  /**
   * Reads the latest saved delivery status, whether or not this process owns it.
   * @param input - Delivery ID from an HTTP path or application caller.
   * @returns Current status, or `undefined` when the delivery does not exist.
   */
  async status(input: string): Promise<WebhookState | undefined> {
    const id = CellIdSchema.parse(input);
    const active = this.#active.get(id);
    if (active !== undefined) return active.getSnapshot().acknowledged.state;

    const outcome = await this.#cells.readState({
      cellId: id,
      protocolRevision: WEBHOOK_PROTOCOL.protocolRevision,
      stateCodec: WEBHOOK_PROTOCOL.codecs.state,
    });
    if (outcome.kind === 'not-found') return undefined;
    if (outcome.kind !== 'found') throw new Error(`Webhook status could not be read: ${outcome.kind}`);
    return outcome.state;
  }

  /**
   * Listens to status changes whether this process or another worker owns the delivery.
   * @param input - Delivery ID returned by `submit` or recovery.
   * @param listener - Called immediately with current status and after each saved change.
   * @returns An owned listener, or `undefined` when the delivery does not exist.
   */
  async watch(input: string, listener: WebhookStatusListener): Promise<WebhookStatusWatch | undefined> {
    const id = CellIdSchema.parse(input);
    const active = this.#active.get(id);
    if (active === undefined) return this.#watchSaved(id, listener);

    const attachment = await active.attachLive({ transient: {} });
    try {
      listener(attachment.seed.state.snapshot.acknowledged.state);
    } catch (error) {
      await attachment.close();
      throw error;
    }
    void (async () => {
      try {
        for await (const update of attachment.stateUpdates) {
          listener(update.snapshot.acknowledged.state);
        }
      } catch {
        // A listener exception detaches this presentation stream without affecting delivery.
        await attachment.close();
      }
    })();

    return Object.freeze({
      async close() {
        await attachment.close();
      },
    });
  }

  /**
   * Polls finite saved status when a load balancer reaches a non-owning process.
   * @param id - Existing delivery identity admitted by the public watch method.
   * @param listener - Receives current state and each later changed status.
   * @returns An owned polling watch, or absence when no delivery exists.
   */
  async #watchSaved(
    id: import('@archer/core/cells').CellId,
    listener: WebhookStatusListener,
  ): Promise<WebhookStatusWatch | undefined> {
    const initial = await this.status(id);
    if (initial === undefined) return undefined;
    listener(initial);

    let stopped = false;
    let cancelScheduled: () => void = () => undefined;
    let closePromise: Promise<void> | undefined;
    let version = statusVersion(initial);
    /** Stops the next scheduled read and prevents an in-flight read from publishing. */
    const close = (): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => {
        stopped = true;
        cancelScheduled();
      });
      return closePromise;
    };
    /** Schedules only after the previous read finishes, so slow S3 cannot create overlap. */
    const scheduleNext = () => {
      cancelScheduled = this.#scheduleStatusRead(this.#statusPollMilliseconds, () => {
        void (async () => {
          try {
            const current = await this.status(id);
            if (stopped) return;
            if (current === undefined) {
              await close();
              return;
            }
            const currentVersion = statusVersion(current);
            if (currentVersion !== version) {
              version = currentVersion;
              listener(current);
            }
            if (isFinished(current)) await close();
            else scheduleNext();
          } catch {
            // A failed read or listener detaches this client; the caller may reconnect through finite status.
            await close();
          }
        })();
      });
    };
    if (!isFinished(initial)) scheduleNext();

    return Object.freeze({ close });
  }

  /**
   * Finds one bounded page of unfinished S3 deliveries and resumes those this process can own.
   * @returns Number of deliveries activated by this pass.
   */
  recover(): Promise<number> {
    this.#recoveryPromise ??= this.#recoverPage().finally(() => {
      this.#recoveryPromise = undefined;
    });
    return this.#recoveryPromise;
  }

  /**
   * Scans and attaches one page while `recover()` prevents overlapping passes.
   * @returns Number of deliveries activated from this page.
   */
  async #recoverPage(): Promise<number> {
    let recovered = 0;
    const outcome = await this.#cells.discoverRecoverable({
      at: TimestampSchema.parse(this.#now().toISOString()),
      ...(this.#recoveryCursor === undefined ? {} : { cursor: this.#recoveryCursor }),
    });
    if (outcome.kind !== 'found') throw new Error(`Webhook recovery could not scan S3: ${outcome.kind}`);
    this.#recoveryCursor = outcome.cursor;

    for (const id of outcome.cellIds) {
      if (this.#active.has(id)) continue;
      const attached = await this.#cells.attach({
        cellId: id,
        protocol: WEBHOOK_PROTOCOL,
        activation: { effects: this.#effects },
      });
      if (attached.kind !== 'opened') continue;
      this.#retain(attached.handle);
      recovered += 1;
    }
    return recovered;
  }

  /**
   * Stops local delivery work and closes the owned S3 host once.
   * @returns Shared shutdown settlement for all callers.
   */
  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await Promise.all([...this.#active.values()].map((handle) => handle.close()));
      this.#active.clear();
      await this.#cells.close();
    })();
    return this.#closePromise;
  }

  /** Delegates language-level asynchronous disposal to `close`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Keeps a live delivery reachable until it succeeds or uses its final attempt. */
  #retain(handle: CellHandle<WebhookState, WebhookEvent, WebhookProgress>): void {
    this.#active.set(handle.cellId, handle);
    let unsubscribe: () => void = () => undefined;
    const releaseIfFinished = (snapshot: import('@archer/core/cells').CellHandleSnapshot<WebhookState>) => {
      const status = snapshot.acknowledged.state.status;
      if (status !== 'delivered' && status !== 'failed') return;
      unsubscribe();
      this.#active.delete(handle.cellId);
      void handle.close();
    };
    unsubscribe = handle.subscribe(releaseIfFinished);
    releaseIfFinished(handle.getSnapshot());
  }
}
