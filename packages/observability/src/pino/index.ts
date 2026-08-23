/**
 * @file Projects normalized Archer diagnostics into Pino without creating a
 * second diagnostic schema or taking authority over observed work.
 */

import {
  ArcherError,
  toProtocolFailure,
  type ComponentRef,
  type DiagnosticRecord,
  type DiagnosticSink,
  type DiagnosticSinkCloseEvidence,
} from '@archer/core';
import pino from 'pino';

/** Pulls the adapter-owned Node 26 compatibility declaration into this public subpath without runtime code. */
export type {} from './worker-threads.js';

/** Complete Pino bindings object passed for one normalized diagnostic record. */
export type PinoSinkBindings = Readonly<{
  /** Retains the complete normalized record under the one canonical adapter key. */
  archer: DiagnosticRecord;
}>;

/** One structured Pino method narrowed to the adapter's exact call shape. */
export type PinoSinkLogMethod = (bindings: PinoSinkBindings, message: string) => void;

/** Pino methods the adapter needs without exporting unrelated logger capabilities. */
export type PinoSinkLogger = Readonly<{
  /** Projects debug diagnostics without changing their normalized payload. */
  debug: PinoSinkLogMethod;

  /** Projects informational diagnostics without changing their normalized payload. */
  info: PinoSinkLogMethod;

  /** Projects warning diagnostics without changing their normalized payload. */
  warn: PinoSinkLogMethod;

  /** Projects error diagnostics without changing their normalized payload. */
  error: PinoSinkLogMethod;

  /** Flushes Pino-managed buffered writes through its callback contract. */
  flush(callback?: (error?: Error) => void): void;
}>;

/** Pino-compatible destination accepted when the adapter constructs the logger. */
export type PinoSinkDestination = Readonly<{
  /** Accepts one newline-delimited record serialized by Pino. */
  write(message: string): void;
}>;

/** Explicit lifecycle ownership for an injected Pino logger. */
export type PinoSinkLoggerRef = ComponentRef<PinoSinkLogger>;

/** Explicit lifecycle ownership for an injected Pino destination. */
export type PinoSinkDestinationRef = ComponentRef<PinoSinkDestination>;

/** Pino threshold accepted only when the adapter constructs the logger. */
export type PinoSinkLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Creates the safe asynchronous stderr logger owned entirely by the sink. */
export type ManagedPinoSinkOptions = Readonly<{
  /** Selects Pino's threshold and defaults to `info`. */
  level?: PinoSinkLevel;

  /** Prevents a managed configuration from also claiming an injected logger. */
  logger?: never;

  /** Prevents a managed configuration from also claiming an injected destination. */
  destination?: never;
}>;

/** Uses one already-configured Pino logger with explicit lifecycle ownership. */
export type InjectedPinoLoggerSinkOptions = Readonly<{
  /** Supplies the logger and states whether the sink may flush and close it. */
  logger: PinoSinkLoggerRef;

  /** Keeps the logger's nested destination opaque to this composition boundary. */
  destination?: never;

  /** Prevents mutation of an injected logger's application-owned threshold. */
  level?: never;
}>;

/** Constructs a Pino logger over one explicitly owned or borrowed destination. */
export type InjectedPinoDestinationSinkOptions = Readonly<{
  /** Supplies the destination and states whether the sink may flush and close it. */
  destination: PinoSinkDestinationRef;

  /** Prevents one sink from claiming both a logger and its nested destination. */
  logger?: never;

  /** Selects Pino's threshold and defaults to `info`. */
  level?: PinoSinkLevel;
}>;

/** Complete mutually exclusive construction contract for the Pino sink. */
export type PinoSinkOptions =
  ManagedPinoSinkOptions | InjectedPinoLoggerSinkOptions | InjectedPinoDestinationSinkOptions;

/** Stable adapter failure categories that never include destination messages. */
export type PinoSinkErrorCode =
  | 'pino_sink_closed'
  | 'pino_sink_configuration_failed'
  | 'pino_sink_write_failed'
  | 'pino_sink_flush_failed'
  | 'pino_sink_resource_close_failed';

/** Focused failure whose public fields contain no native Pino or destination data. */
export class PinoSinkError extends ArcherError {
  /**
   * Constructs one redacted adapter failure without retaining the native cause.
   * @param code - Stable adapter failure category.
   * @param message - Bounded public explanation selected by this adapter.
   */
  constructor(code: PinoSinkErrorCode, message: string) {
    super(message, { code });
  }
}

/** Internal owned Pino destination created for the managed stderr default. */
type ManagedPinoDestination = PinoSinkDestination &
  Readonly<{
    /** Reports whether Pino has already ended the managed destination. */
    destroyed?: boolean;

    /** Starts an orderly destination end after buffered writes flush. */
    end(): void;

    /** Registers one terminal destination listener. */
    once(event: 'close' | 'error', listener: (error?: unknown) => void): unknown;

    /** Removes a terminal destination listener after the other terminal path wins. */
    off(event: 'close' | 'error', listener: (error?: unknown) => void): unknown;
  }>;

/** Internal logger plus only the lifecycle operations this sink is authorized to run. */
type PinoSinkRuntime = Readonly<{
  /** Receives every normalized record through exactly one selected level method. */
  logger: PinoSinkLogger;

  /** Flushes accepted writes only when this sink owns the selected resource. */
  flushOwned?: () => Promise<void>;

  /** Closes only the managed or explicitly owned selected resource. */
  closeOwned?: () => Promise<void>;
}>;

/** Mutable retained lifecycle states hidden behind the DiagnosticSink contract. */
type PinoSinkState = 'open' | 'closing' | 'closed';

/**
 * Supplies a settled no-op for resources that need no separate teardown.
 * @returns An already-fulfilled lifecycle operation.
 */
async function noLifecycleAction(): Promise<void> {
  return undefined;
}

/**
 * Converts one Pino callback flush into an awaitable, redacted operation.
 * @param logger - Owned logger whose destination may hold accepted writes.
 * @returns A promise that settles with Pino's callback without exposing its Error.
 */
function flushLogger(logger: PinoSinkLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      logger.flush((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(new PinoSinkError('pino_sink_flush_failed', 'Pino failed to flush accepted diagnostic records'));
      });
    } catch {
      reject(new PinoSinkError('pino_sink_flush_failed', 'Pino failed to flush accepted diagnostic records'));
    }
  });
}

/**
 * Ends the adapter-created asynchronous destination and waits for its close event.
 * @param destination - Managed stderr destination created by this adapter.
 * @returns A promise settled by the destination's close or redacted error event.
 */
function closeManagedDestination(destination: ManagedPinoDestination): Promise<void> {
  if (destination.destroyed === true) return noLifecycleAction();
  return new Promise((resolve, reject) => {
    /** Removes both listeners after either terminal destination event arrives. */
    const cleanup = (): void => {
      destination.off('close', handleClose);
      destination.off('error', handleError);
    };
    /** Resolves only after Pino reports destination closure. */
    const handleClose = (): void => {
      cleanup();
      resolve();
    };
    /** Rejects with adapter-owned text when destination teardown fails. */
    const handleError = (): void => {
      cleanup();
      reject(new PinoSinkError('pino_sink_resource_close_failed', 'Pino failed to close its owned resource'));
    };
    destination.once('close', handleClose);
    destination.once('error', handleError);
    try {
      destination.end();
    } catch {
      handleError();
    }
  });
}

/**
 * Closes one explicitly owned retained dependency without exposing its evidence.
 * @param resource - Logger or destination whose lifecycle transferred to this sink.
 * @returns A promise that fulfills only after the nested retained handle closes.
 */
async function closeOwnedResource(resource: PinoSinkLoggerRef | PinoSinkDestinationRef): Promise<void> {
  if (resource.ownership !== 'owned') return;
  try {
    /** Retains nested evidence only long enough to recognize an explicit failure. */
    const evidence: unknown = await resource.value.close();
    if (typeof evidence === 'object' && evidence !== null && 'kind' in evidence && evidence.kind === 'failed') {
      throw new PinoSinkError('pino_sink_resource_close_failed', 'Pino failed to close its owned resource');
    }
  } catch {
    throw new PinoSinkError('pino_sink_resource_close_failed', 'Pino failed to close its owned resource');
  }
}

/**
 * Builds Pino over an injected destination while preserving adapter-owned output shape.
 * @param destination - Borrowed or owned Pino-compatible destination.
 * @param level - Application-selected Pino threshold.
 * @returns A focused logger that uses the injected destination.
 */
function loggerForDestination(destination: PinoSinkDestination, level: PinoSinkLevel): PinoSinkLogger {
  try {
    return pino({ base: null, level }, destination);
  } catch {
    throw new PinoSinkError('pino_sink_configuration_failed', 'Pino sink configuration failed');
  }
}

/**
 * Creates the safe managed asynchronous stderr runtime.
 * @param level - Application-selected threshold or the `info` default.
 * @returns A logger with flush and close authority over its created destination.
 */
function managedRuntime(level: PinoSinkLevel): PinoSinkRuntime {
  try {
    /** Uses stderr so structured logs stay separate from application output. */
    const destination = pino.destination({ dest: 2, sync: false }) as ManagedPinoDestination;
    /** Omits ambient host bindings that are not part of normalized Archer data. */
    const logger = pino({ base: null, level }, destination);
    /**
     * Flushes the logger created over this owned destination.
     * @returns A promise settled by Pino's flush callback.
     */
    const flushOwned = (): Promise<void> => flushLogger(logger);
    /**
     * Ends the adapter-created destination after flushing.
     * @returns A promise settled by the destination close event.
     */
    const closeOwned = (): Promise<void> => closeManagedDestination(destination);
    return Object.freeze({
      logger,
      flushOwned,
      closeOwned,
    });
  } catch {
    throw new PinoSinkError('pino_sink_configuration_failed', 'Pino sink configuration failed');
  }
}

/**
 * Selects one mutually exclusive logger and honest nested ownership policy.
 * @param options - Managed, logger-injected, or destination-injected construction.
 * @returns The selected logger plus only authorized lifecycle operations.
 */
function createRuntime(options: PinoSinkOptions): PinoSinkRuntime {
  if (options.logger !== undefined && options.destination !== undefined) {
    throw new PinoSinkError('pino_sink_configuration_failed', 'Pino sink configuration failed');
  }
  if (options.logger !== undefined) {
    /** Keeps destination ownership inside the explicitly supplied logger handle. */
    const logger = options.logger;
    /**
     * Flushes only an explicitly owned injected logger.
     * @returns A promise settled by the logger's Pino flush callback.
     */
    const flushOwned = (): Promise<void> => flushLogger(logger.value);
    /**
     * Closes only the explicitly owned outer logger handle.
     * @returns A promise settled by the retained logger lifecycle.
     */
    const closeOwned = (): Promise<void> => closeOwnedResource(logger);
    return Object.freeze({
      logger: logger.value,
      ...(logger.ownership === 'owned' ? { flushOwned, closeOwned } : {}),
    });
  }
  if (options.destination !== undefined) {
    /** Lets this adapter own the logger while the destination retains explicit ownership. */
    const destination = options.destination;
    /** Applies the managed threshold without mutating an application-owned logger. */
    const logger = loggerForDestination(destination.value, options.level ?? 'info');
    /**
     * Flushes the adapter logger only when its destination ownership transferred here.
     * @returns A promise settled by the logger's Pino flush callback.
     */
    const flushOwned = (): Promise<void> => flushLogger(logger);
    /**
     * Closes only the explicitly owned destination handle.
     * @returns A promise settled by the retained destination lifecycle.
     */
    const closeOwned = (): Promise<void> => closeOwnedResource(destination);
    return Object.freeze({
      logger,
      ...(destination.ownership === 'owned' ? { flushOwned, closeOwned } : {}),
    });
  }
  return managedRuntime(options.level ?? 'info');
}

/** Retained DiagnosticSink implementation that serializes calls and owns closure once. */
class PinoDiagnosticSink implements DiagnosticSink {
  /** Settles with the exact immutable evidence returned by every close call. */
  readonly closed: Promise<DiagnosticSinkCloseEvidence>;

  /** Pino projection and the lifecycle permissions selected at construction. */
  readonly #runtime: PinoSinkRuntime;

  /** Resolves the stable public close promise once finalization finishes. */
  readonly #settleClosed: (evidence: DiagnosticSinkCloseEvidence) => void;

  /** Serializes accepted batches and explicit flushes without retrying failures. */
  #operations: Promise<void> = Promise.resolve();

  /** Rejects new writes after the one close transition begins. */
  #state: PinoSinkState = 'open';

  /**
   * Retains the selected runtime without creating any record or breadcrumb.
   * @param runtime - Logger plus only its authorized owned lifecycle actions.
   */
  constructor(runtime: PinoSinkRuntime) {
    this.#runtime = runtime;
    /** Captures one native resolver for stable close identity. */
    let settle: ((evidence: DiagnosticSinkCloseEvidence) => void) | undefined;
    this.closed = new Promise((resolve) => {
      settle = resolve;
    });
    /**
     * Freezes close evidence before it becomes observable to every waiter.
     * @param evidence - Normal or failed terminal sink evidence.
     * @returns Nothing after resolving the retained close promise.
     */
    this.#settleClosed = (evidence) => settle?.(Object.freeze(evidence));
  }

  /**
   * Accepts one immutable batch and projects records in array order exactly once.
   * @param records - Normalized core records already admitted for this sink.
   * @returns A promise for this batch's one-pass projection.
   */
  write(records: readonly DiagnosticRecord[]): Promise<void> {
    if (this.#state !== 'open') {
      return Promise.reject(new PinoSinkError('pino_sink_closed', 'The Pino diagnostic sink is closed'));
    }
    /** Owns batch order even if the caller later mutates its array container. */
    const accepted = Object.freeze([...records]);
    return this.#enqueue(() => this.#project(accepted));
  }

  /**
   * Flushes accepted writes only through a resource whose ownership transferred here.
   * @returns A promise settled after earlier operations and any authorized flush.
   */
  flush(): Promise<void> {
    if (this.#state !== 'open') {
      return Promise.reject(new PinoSinkError('pino_sink_closed', 'The Pino diagnostic sink is closed'));
    }
    return this.#enqueue(() => this.#runtime.flushOwned?.() ?? noLifecycleAction());
  }

  /**
   * Stops admission, drains accepted operations, flushes, and closes owned resources.
   * @returns The same stable close promise exposed by `closed`.
   */
  close(): Promise<DiagnosticSinkCloseEvidence> {
    if (this.#state === 'open') {
      this.#state = 'closing';
      void this.#operations.then(() => this.#finalize());
    }
    return this.closed;
  }

  /** Delegates language disposal to the same idempotent retained close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Appends one operation after all previously accepted work and keeps the tail usable after failure.
   * @param operation - Projection or flush effect admitted while the sink is open.
   * @returns The exact operation promise observed by its caller.
   */
  #enqueue(operation: () => void | Promise<void>): Promise<void> {
    /** Preserves accepted order across concurrent callers. */
    const result = this.#operations.then(operation);
    this.#operations = result.then(noLifecycleAction, noLifecycleAction);
    return result;
  }

  /**
   * Makes one severity-selected Pino call for each record and stops at the first failure.
   * @param records - Adapter-owned batch container in accepted order.
   */
  #project(records: readonly DiagnosticRecord[]): void {
    /** Projects each accepted record without manufacturing lifecycle breadcrumbs. */
    for (const record of records) {
      try {
        this.#runtime.logger[record.severity]({ archer: record }, record.name);
      } catch {
        throw new PinoSinkError('pino_sink_write_failed', 'Pino rejected a diagnostic record');
      }
    }
  }

  /** Flushes and closes through the selected ownership branch before settling once. */
  async #finalize(): Promise<void> {
    /** Retains only the first redacted teardown failure while cleanup continues. */
    let failure: unknown;
    try {
      await this.#runtime.flushOwned?.();
    } catch (error) {
      failure = error;
    }
    try {
      await this.#runtime.closeOwned?.();
    } catch (error) {
      failure ??= error;
    }
    this.#state = 'closed';
    if (failure === undefined) {
      this.#settleClosed({ kind: 'closed' });
      return;
    }
    this.#settleClosed({
      kind: 'failed',
      failure: toProtocolFailure(failure, {
        code: 'pino_sink_resource_close_failed',
        message: 'Pino failed to close its owned resource',
      }),
    });
  }
}

/**
 * Creates a retained Pino projection with a safe managed default or one explicit dependency.
 * @param options - Mutually exclusive managed, logger, or destination configuration.
 * @returns A retained DiagnosticSink with idempotent shared closure.
 */
export function pinoSink(options: PinoSinkOptions = {}): DiagnosticSink {
  return new PinoDiagnosticSink(createRuntime(options));
}
