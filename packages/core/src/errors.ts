/**
 * @file Defines the stable Error hierarchy owned by Archer's public contracts.
 *
 * Expected domain outcomes remain tagged values. These classes represent
 * failures that callers may catch, inspect, log, and transport deliberately.
 */

import { JsonObjectSchema, type JsonObject } from './values.js';

/** Additional machine-readable context required by every Archer-owned Error. */
export type ArcherErrorOptions = ErrorOptions &
  Readonly<{
    /** A stable category for branching and telemetry, independent of the message. */
    code: string;

    /** Optional JSON evidence copied and frozen at construction time. */
    details?: JsonObject;
  }>;

/**
 * The common Error base for failures created by Archer.
 *
 * Native `cause` stays process-local for stack inspection. Serializable
 * transport fields live in `code` and `details` instead of flattening arbitrary
 * upstream Error objects.
 */
export class ArcherError extends Error {
  /** Stable failure category suitable for exhaustive adapter handling. */
  readonly code: string;

  /** Immutable JSON evidence that diagnostics and transports can encode structurally. */
  readonly details?: JsonObject;

  /**
   * Constructs an Archer-owned Error while preserving native cause semantics.
   * Runtime-invalid details are rejected before construction completes.
   * @param message - Human-readable context for logs and local debugging.
   * @param options - Stable code, optional JSON details, and optional local cause.
   */
  constructor(message: string, options: ArcherErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    if (options.details !== undefined) this.details = JsonObjectSchema.parse(options.details);
  }
}

/** A portable location component within a rejected structured input. */
export type ValidationPathSegment = string | number;

/** One product-neutral validation failure detached from any schema library. */
export type ValidationIssue = Readonly<{
  /** Ordered traversal from the parsed root to the rejected value. */
  path: readonly ValidationPathSegment[];

  /** Adapter-supplied category that remains stable for the underlying validator. */
  code: string;

  /** Human-readable explanation intended for diagnostics, not control flow. */
  message: string;
}>;

/**
 * Carries normalized validation issues across Archer's product-neutral API.
 * Validator-specific errors remain available as the native `cause` only.
 */
export class ValidationError extends ArcherError {
  /** Frozen issues in validator report order. */
  readonly issues: readonly ValidationIssue[];

  /**
   * Copies issue paths and records serializable details so later mutation of an
   * adapter error cannot rewrite the public failure.
   * @param issues - Product-neutral failures in deterministic report order.
   * @param options - Optional native cause retained for local diagnosis.
   */
  constructor(issues: readonly ValidationIssue[], options?: ErrorOptions) {
    /** Owns a frozen issue graph independent of adapter-owned arrays and paths. */
    const normalizedIssues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          path: Object.freeze([...issue.path]),
          code: issue.code,
          message: issue.message,
        }),
      ),
    );
    super('Validation failed', {
      code: 'validation_failed',
      details: {
        issues: normalizedIssues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    this.issues = normalizedIssues;
  }
}
