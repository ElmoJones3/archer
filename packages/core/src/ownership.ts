/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Defines retained lifecycle ownership without conflating close, abort,
 * observation detachment, or durable cancellation.
 *
 * The explicit standard-library reference keeps emitted declarations usable
 * without requiring a consumer to install ambient Node types.
 */

/** A retained behavior whose one immutable close result can settle externally. */
export interface OwnedHandle<Evidence> extends AsyncDisposable {
  /** Settles when this attachment or resource has finished closing. */
  readonly closed: Promise<Evidence>;

  /** Starts idempotent closure and returns the same settlement as `closed`. */
  close(): Promise<Evidence>;
}

/** Marks a dependency whose lifecycle remains with its current owner. */
export type BorrowedRef<T> = Readonly<{
  /** Prevents a parent from closing an application-owned dependency. */
  ownership: 'borrowed';

  /** The dependency retained by its original owner. */
  value: T;
}>;

/** Marks a retained dependency whose lifecycle transfers to the receiver. */
export type OwnedRef<T extends OwnedHandle<unknown>> = Readonly<{
  /** Transfers close responsibility to the receiving composition. */
  ownership: 'owned';

  /** The retained dependency whose lifecycle the parent must close. */
  value: T;
}>;

/** Explicitly marks whether a composing parent owns an injected dependency. */
export type ComponentRef<T> = BorrowedRef<T> | OwnedRef<T & OwnedHandle<unknown>>;

/**
 * Marks a dependency as application-owned so composition cannot infer closure
 * authority from the presence of a `close` method.
 * @param value - A dependency whose lifecycle remains with its current owner.
 * @returns A frozen borrowed reference.
 */
export function borrowed<T>(value: T): BorrowedRef<T> {
  return Object.freeze({ ownership: 'borrowed', value });
}

/**
 * Transfers lifecycle responsibility for a retained dependency explicitly.
 * @param value - A retained dependency the receiving parent must close.
 * @returns A frozen owned reference.
 */
export function owned<T extends OwnedHandle<unknown>>(value: T): OwnedRef<T> {
  return Object.freeze({ ownership: 'owned', value });
}
