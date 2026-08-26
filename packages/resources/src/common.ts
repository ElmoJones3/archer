/** @file Defines Resource revision identity and deterministic content digests. */

import { createHash } from 'node:crypto';

import { NumberDictionary, adjectives, animals, colors, uniqueNamesGenerator } from 'unique-names-generator';

import {
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type ArcherObject,
  type JsonValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';

/** Four-digit dictionary supplies the fourth project-standard petname component. */
const PETNAME_NUMBERS = NumberDictionary.generate({ min: 1000, max: 9999 });

/**
 * Generates a stable four-part display label for one already-created identity.
 * @param id - UUIDv4 seed that keeps retries for one identity deterministic.
 * @returns Lowercase hyphenated adjective-color-animal-number label.
 */
export function resourcePetname(id: UuidV4): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals, PETNAME_NUMBERS],
    separator: '-',
    length: 4,
    style: 'lowerCase',
    seed: id,
  });
}

/** Fields shared by reusable immutable Resource revisions. */
export type ResourceRevision<ObjectName extends string, Id extends UuidV4, RevisionId extends UuidV4> = ArcherObject<
  ObjectName,
  Id
> &
  Readonly<{
    /** Human-facing label for logs, interfaces, and local discovery. */
    name: string;

    /** Identifies one exact immutable revision independently of logical identity. */
    revisionId: RevisionId;

    /** Orders revisions of one logical Resource beginning at one. */
    revision: number;

    /** Links a later revision to the exact state that earned it. */
    previousRevisionId?: RevisionId;

    /** Records when this exact revision was earned. */
    updatedAt: Timestamp;

    /** Binds every behavior-relevant field to a deterministic identity. */
    contentDigest: Sha256Digest;
  }>;

/** Identity inputs copied into one new revision before domain content is added. */
export type RevisionIdentity<ObjectName extends string, Id extends UuidV4, RevisionId extends UuidV4> = Readonly<{
  /** Stable domain discriminator. */
  object: ObjectName;

  /** Logical Resource identity shared by its revisions. */
  id: Id;

  /** Exact identity generated for this revision. */
  revisionId: RevisionId;

  /** One-based revision number. */
  revision: number;

  /** First creation instant preserved across revisions. */
  createdAt: Timestamp;

  /** Current revision instant. */
  updatedAt: Timestamp;

  /** Optional exact parent for non-initial revisions. */
  previousRevisionId?: RevisionId;

  /** Copied non-empty human-facing name. */
  name: string;
}>;

/** Minimal existing revision required to derive a legal child identity. */
export type RevisionParent<Id extends UuidV4, RevisionId extends UuidV4> = Readonly<{
  /** Logical identity retained by the child. */
  id: Id;

  /** Creation instant retained by the child. */
  createdAt: Timestamp;

  /** Exact parent revision identity. */
  revisionId: RevisionId;

  /** Parent sequence incremented by the child. */
  revision: number;

  /** Parent revision instant that a legal child cannot precede. */
  updatedAt: Timestamp;
}>;

/** Exact root identity and time facts accepted by deterministic application boundaries. */
export type ResourceCreationContext<Id extends UuidV4, RevisionId extends UuidV4> = Readonly<{
  /** Supplies the logical identity retained by every revision. */
  id: Id;

  /** Supplies the exact initial revision identity. */
  revisionId: RevisionId;

  /** Supplies the trusted instant used by both initial timestamps. */
  observedAt: Timestamp;
}>;

/** Exact child identity and time facts required by pure Resource modifiers. */
export type ResourceRevisionContext<RevisionId extends UuidV4> = Readonly<{
  /** Supplies a fresh identity for the child revision. */
  revisionId: RevisionId;

  /** Supplies the trusted observation used to derive causal update time. */
  observedAt: Timestamp;
}>;

/**
 * Serializes admitted JSON with deterministic object-key ordering.
 * @param value - Admitted JSON value serialized without insertion-order dependence.
 * @returns Canonical JSON text with recursively sorted object keys.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  /** Array narrowing leaves only the immutable string-keyed object branch. */
  const record = value as Readonly<Record<string, JsonValue>>;
  /** Property order must not let equivalent domain state acquire different identity. */
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`);
  return `{${fields.join(',')}}`;
}

/**
 * Hashes behavior-bearing content under a versioned Resource protocol.
 * @param protocol - Versioned rule set giving the resulting contentDigest meaning.
 * @param value - JSON-safe content copied before hashing.
 * @returns Algorithm-qualified deterministic SHA-256 identity.
 */
export function resourceDigest(protocol: string, value: unknown): Sha256Digest {
  /** JSON admission also breaks aliases to mutable caller values. */
  const admitted = JsonValueSchema.parse(value);
  /** Protocol separation prevents identical JSON from colliding across domains. */
  const contentDigest = createHash('sha256')
    .update(protocol)
    .update('\0')
    .update(canonicalJson(admitted))
    .digest('hex');
  return Sha256DigestSchema.parse(`sha256:${contentDigest}`);
}

/**
 * Creates initial Resource identity from explicit facts supplied by an application boundary.
 * @param object - Stable domain discriminator for this Resource kind.
 * @param name - Human-facing label already derived or supplied by the caller.
 * @param context - Exact logical identity, revision identity, and trusted time.
 * @returns Copied immutable initial identity fields ready for behavior-specific content.
 */
export function createInitialRevisionIdentity<ObjectName extends string, Id extends UuidV4, RevisionId extends UuidV4>(
  object: ObjectName,
  name: string,
  context: ResourceCreationContext<Id, RevisionId>,
): RevisionIdentity<ObjectName, Id, RevisionId> {
  /** Scalar admission gives explicit contexts the same boundary as generated defaults. */
  const id = UuidV4Schema.parse(context.id) as Id;
  /** Revision identity remains distinct from the logical Resource identity. */
  const revisionId = UuidV4Schema.parse(context.revisionId) as RevisionId;
  if (String(revisionId) === String(id)) throw new TypeError('Resource logical and revision identities must differ');
  /** One canonical instant establishes legal initial creation and update time. */
  const observedAt = TimestampSchema.parse(context.observedAt);
  return Object.freeze({
    object,
    id,
    revisionId,
    revision: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
    name: name.trim(),
  });
}

/**
 * Creates a child identity from an admitted parent and explicit causal facts.
 * @param object - Stable domain discriminator for this Resource kind.
 * @param name - Human-facing label retained by the child.
 * @param parent - Exact behavior-bearing revision earning the child.
 * @param context - Fresh child revision identity and trusted observed time.
 * @returns Copied immutable child identity with nondecreasing causal time.
 */
export function createRevisionIdentity<ObjectName extends string, Id extends UuidV4, RevisionId extends UuidV4>(
  object: ObjectName,
  name: string,
  parent: RevisionParent<Id, RevisionId>,
  context: ResourceRevisionContext<RevisionId>,
): RevisionIdentity<ObjectName, Id, RevisionId> {
  /** Canonicalization prevents callers from smuggling non-UUID revision identity. */
  const revisionId = UuidV4Schema.parse(context.revisionId) as RevisionId;
  if (String(revisionId) === String(parent.id) || revisionId === parent.revisionId) {
    throw new TypeError('Resource child revision identity must be fresh and distinct');
  }
  /** A backward clock observation cannot make an impossible child. */
  const observedAt = TimestampSchema.parse(context.observedAt);
  /** Lexical comparison is chronological because Archer timestamps are canonical UTC instants. */
  const updatedAt = observedAt < parent.updatedAt ? parent.updatedAt : observedAt;
  return Object.freeze({
    object,
    id: parent.id,
    revisionId,
    revision: parent.revision + 1,
    createdAt: parent.createdAt,
    updatedAt,
    previousRevisionId: parent.revisionId,
    name: name.trim(),
  });
}

/**
 * Derives ordinary initial facts while letting deterministic callers supply their own context.
 * @param context - Optional exact identity and time facts.
 * @returns A complete initial context using UUIDv4 and one clock read when omitted.
 */
export function initialResourceContext<Id extends UuidV4, RevisionId extends UuidV4>(
  context?: ResourceCreationContext<Id, RevisionId>,
): ResourceCreationContext<Id, RevisionId> {
  if (context !== undefined) return context;
  /** Default application construction creates two independent identities and reads time once. */
  return Object.freeze({
    id: createUuidV4() as Id,
    revisionId: createUuidV4() as RevisionId,
    observedAt: TimestampSchema.parse(new Date().toISOString()),
  });
}
