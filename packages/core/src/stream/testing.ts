/**
 * @file Provides deterministic host controls for temporal conformance tests.
 *
 * These fixtures are explicit test dependencies. Production code should use
 * host scheduling, clocks, randomness, and adapter-controlled settlement.
 */

import type { ScheduleTask } from './runtime.js';

/** A manually drained FIFO implementation of Archer's scheduling boundary. */
export class ManualTaskScheduler {
  /** Retains scheduled work in exact acceptance order. */
  readonly #tasks: (() => void)[] = [];

  /**
   * Satisfies runtime scheduling while retaining work for explicit test control.
   * @param task - Deferred unit of temporal work.
   */
  readonly schedule: ScheduleTask = (task) => {
    this.#tasks.push(task);
  };

  /**
   * Returns the number of scheduled tasks awaiting explicit execution.
   * @returns Current pending task count.
   */
  get pending(): number {
    return this.#tasks.length;
  }

  /**
   * Executes the oldest scheduled task when one exists.
   * @returns True when one task ran and false when the scheduler was empty.
   */
  flushOne(): boolean {
    /** Removes the oldest scheduled task for FIFO execution. */
    const task = this.#tasks.shift();
    if (task === undefined) return false;
    task();
    return true;
  }

  /** Executes tasks until scheduled work reaches a stable empty state. */
  flushAll(): void {
    while (this.flushOne()) {
      // The condition performs the one intentional unit of scheduled work.
    }
  }
}

/** A promise whose result remains under direct deterministic test control. */
export type DeferredTask<Value> = Readonly<{
  /** Promise supplied to production behavior under test. */
  promise: Promise<Value>;

  /** Settles the controlled promise successfully. */
  resolve(value: Value): void;

  /** Settles the controlled promise with an explicit failure. */
  reject(reason: unknown): void;
}>;

/**
 * Creates a manually settled promise without timers or ambient scheduling.
 * @returns A frozen promise controller for deterministic temporal tests.
 */
export function createDeferredTask<Value>(): DeferredTask<Value> {
  /** Captures the native resolver during promise construction. */
  let resolvePromise: ((value: Value) => void) | undefined;

  /** Captures the native rejecter during promise construction. */
  let rejectPromise: ((reason: unknown) => void) | undefined;

  /** Exposes one pending promise before either settlement capability runs. */
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return Object.freeze({
    promise,
    /**
     * Settles the controlled promise successfully.
     * @param value - Exact result supplied to behavior under test.
     */
    resolve(value: Value) {
      resolvePromise?.(value);
    },
    /**
     * Settles the controlled promise with an explicit failure.
     * @param reason - Exact rejection supplied to behavior under test.
     */
    reject(reason: unknown) {
      rejectPromise?.(reason);
    },
  });
}
