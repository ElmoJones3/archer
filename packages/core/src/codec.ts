/**
 * @file Defines Archer's product-neutral decoding contract and Zod 4 adapter.
 *
 * Domain APIs depend on `Codec`, while packages that author Zod schemas opt into
 * `fromZod`. This keeps validator-specific failure objects out of public results.
 */

import * as z from 'zod';

import { ValidationError, type ValidationIssue, type ValidationPathSegment } from './errors.js';
import { Result } from './result.js';

/** A synchronous boundary that either returns trusted output or normalized failure. */
export interface Codec<Value> {
  /**
   * Produces a trusted value or throws the same `ValidationError` contract used
   * by `safeParse` when exception-based composition is more convenient.
   */
  parse(input: unknown): Value;

  /** Returns validation as data without throwing for an invalid input. */
  safeParse(input: unknown): Result<Value, ValidationError>;
}

/**
 * Converts validator path symbols to text because Archer's JSON error evidence
 * can carry only string and numeric path components.
 * @param segment - One validator-specific property key.
 * @returns A portable string or numeric path segment.
 */
function normalizePathSegment(segment: PropertyKey): ValidationPathSegment {
  return typeof segment === 'symbol' ? (segment.description ?? segment.toString()) : segment;
}

/**
 * Preserves Zod's issue order while dropping fields that are not part of the
 * product-neutral validation contract.
 * @param error - The Zod failure retained later as the native cause.
 * @returns Portable issues suitable for `ValidationError`.
 */
function normalizeIssues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(normalizePathSegment),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Builds the single public failure form used by both codec entry points.
 * @param error - The original Zod failure.
 * @returns A normalized Archer validation failure with the original as cause.
 */
function validationError(error: z.ZodError): ValidationError {
  return new ValidationError(normalizeIssues(error), { cause: error });
}

/**
 * Adapts a Zod 4 schema without making `Codec` inherit Zod's API or error shape.
 * Schema transformations remain intact because the codec returns Zod's output
 * type, not its input type.
 * @param schema - The Zod schema that owns validation and transformation.
 * @returns A product-neutral codec backed by that schema.
 */
export function fromZod<Schema extends z.ZodType>(schema: Schema): Codec<z.output<Schema>> {
  return {
    /**
     * Uses safe parsing internally so all failures pass through one normalizer.
     * @param input - Untrusted input accepted at the codec boundary.
     * @returns The schema's transformed output.
     */
    parse(input: unknown): z.output<Schema> {
      /** Retains Zod's discriminant until this boundary translates the outcome. */
      const result = schema.safeParse(input);
      if (!result.success) throw validationError(result.error);
      return result.data;
    },

    /**
     * Converts Zod's discriminated result into Archer's shared `Result`.
     * @param input - Untrusted input accepted at the codec boundary.
     * @returns Transformed output or a normalized validation failure.
     */
    safeParse(input: unknown): Result<z.output<Schema>, ValidationError> {
      /** Retains transformed output on success and the local Zod cause on failure. */
      const result = schema.safeParse(input);
      return result.success ? Result.ok(result.data) : Result.error(validationError(result.error));
    },
  };
}
