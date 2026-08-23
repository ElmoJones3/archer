/**
 * @file Builds canonical evidence metadata shared by Archer conformance suites.
 *
 * Reports bind claims to exact configuration, environment, execution counts,
 * and content so a passing status cannot be detached from what actually ran.
 */

import * as z from 'zod';

import {
  JsonObjectSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
  type Timestamp,
} from './values.js';

/** Counts required, executed, and skipped cases without treating absence as success. */
export type ConformanceExecution = Readonly<{
  /** Number of cases required by the selected suite version. */
  required: number;

  /** Number of required cases that produced a result. */
  executed: number;

  /** Number of required cases not executed for any reason. */
  skipped: number;
}>;

/** Validates exact, internally consistent execution accounting at report boundaries. */
export const ConformanceExecutionSchema = z
  .strictObject({
    required: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .refine((value) => value.executed <= value.required && value.skipped === value.required - value.executed, {
    message: 'Conformance execution must account for every required case exactly once',
  })
  .transform((value) => value as ConformanceExecution)
  .readonly();

/** Host and dependency facts required to interpret one conformance run. */
export type ConformanceEnvironment = JsonObject;

/** Evidence fields every passing or failing conformance report must retain. */
export type ConformanceEvidence = Readonly<{
  /** Hashes the canonical implementation configuration independently of results. */
  configurationDigest: Sha256Digest;

  /** Records the normalized instant at which the complete result set existed. */
  at: Timestamp;

  /** Names the runtime and dependency environment supplied by the harness. */
  environment: ConformanceEnvironment;

  /** Proves all required cases ran and none were silently skipped. */
  execution: ConformanceExecution;

  /** Hashes the complete report body except this self-referential field. */
  evidenceDigest: Sha256Digest;
}>;

/** Pairs claimed hashes with the immutable values a consumer must verify. */
export type ConformanceDigestClaims = Readonly<{
  /** Exact immutable implementation configuration covered by the report. */
  configuration: JsonObject;

  /** Claimed hash of the implementation configuration. */
  configurationDigest: Sha256Digest;

  /** Complete immutable report body excluding its self-referential evidence hash. */
  evidence: JsonValue;

  /** Claimed hash of the complete report body. */
  evidenceDigest: Sha256Digest;
}>;

/**
 * Serializes JSON with recursively sorted object keys and original array order.
 * @param value - Validated immutable JSON value.
 * @returns A deterministic JSON representation independent of object insertion order.
 */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    /** Sorts by UTF-16 code units without locale or host collation state. */
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hashes one JSON-compatible value through Archer's canonical SHA-256 encoding.
 * @param value - Candidate evidence data validated and copied before hashing.
 * @returns An algorithm-qualified lowercase SHA-256 digest.
 */
export async function digestConformanceValue(value: JsonValue): Promise<Sha256Digest> {
  /** Owns a deeply immutable JSON copy before serialization. */
  const admitted = JsonValueSchema.parse(value);
  /** Encodes canonical text once for the platform digest operation. */
  const bytes = new TextEncoder().encode(canonicalJson(admitted));
  /** Computes the content digest through the standard Web Crypto boundary. */
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  /** Formats every byte with fixed lowercase width. */
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return Sha256DigestSchema.parse(`sha256:${hex}`);
}

/**
 * Recomputes both report hashes before conformance evidence can be trusted.
 * @param claims - Claimed digests paired with their deeply immutable source values.
 * @returns Whether both claims match Archer's canonical SHA-256 encoding.
 */
export async function conformanceDigestsMatch(claims: ConformanceDigestClaims): Promise<boolean> {
  /** Computes independent claims concurrently because neither digest depends on the other. */
  const [configurationDigest, evidenceDigest] = await Promise.all([
    digestConformanceValue(claims.configuration),
    digestConformanceValue(claims.evidence),
  ]);
  return configurationDigest === claims.configurationDigest && evidenceDigest === claims.evidenceDigest;
}

/**
 * Copies harness environment data into the same JSON boundary used by reports.
 * @param environment - Runtime, dependency, and platform facts supplied by the harness.
 * @returns A deeply immutable environment record.
 */
export function normalizeConformanceEnvironment(environment: JsonObject): ConformanceEnvironment {
  return JsonObjectSchema.parse(environment);
}

/**
 * Normalizes one evidence instant through Archer's canonical timestamp codec.
 * @param now - Injected clock read exactly once after all cases execute.
 * @returns A UTC millisecond timestamp.
 */
export function conformanceTimestamp(now: () => Date): Timestamp {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Constructs immutable execution accounting for a complete catalogue run.
 * @param required - Published required-case count.
 * @param executed - Results actually produced by the runner.
 * @returns Counts whose skipped field cannot become negative.
 */
export function conformanceExecution(required: number, executed: number): ConformanceExecution {
  if (!Number.isSafeInteger(required) || required < 0 || !Number.isSafeInteger(executed) || executed < 0) {
    throw new RangeError('Conformance execution counts must be non-negative safe integers');
  }
  if (executed > required) throw new RangeError('Conformance executed count cannot exceed required cases');
  return Object.freeze({ required, executed, skipped: required - executed });
}
