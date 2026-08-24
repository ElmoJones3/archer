/**
 * @file Defines integrity-bearing evidence shared by physical ingestion adapters.
 *
 * The envelope proves internal field consistency, not adapter trust or action
 * authority. An adapter specializes it with exact guarantee discriminators,
 * while a Workspace re-validates it before current Authority decides whether
 * the proposed result may enter private lineage.
 */

import { createHash } from 'node:crypto';

import * as z from 'zod';

import { CanonicalDecimalSchema, archerObjectSchema, type ArcherObject, type CanonicalDecimal } from '@archer/core';

import { TreeRefSchema, type TreeRef } from './encoding.js';
import {
  IngestionReceiptIdSchema,
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  type IngestionReceiptId,
  type MaterializedViewId,
  type MaterializerId,
} from './work-values.js';

/** Common complete evidence every physical ingestion adapter must specialize. */
export type PhysicalIngestionReceipt = ArcherObject<'ingestion-receipt', IngestionReceiptId> &
  Readonly<{
    /** Names the Materializer attachment responsible for the physical mapping. */
    materializerId: MaterializerId;
    /** Names the exact physical view that produced the candidate. */
    materializedViewId: MaterializedViewId;
    /** Selects the adapter family whose verifier gives the evidence meaning. */
    adapterId: string;
    /** Pins interpretation to one adapter-owned physical mapping grammar. */
    mappingVersion: number;
    /** Identifies the exact logical tree originally realized as writable work. */
    base: TreeRef;
    /** Identifies the complete immutable tree reconstructed from eligible bytes. */
    result: TreeRef;
    /** Pins the evidence to the acknowledged owner generation that was realized. */
    generation: number;
    /** Names physical ownership roots deliberately excluded from the result. */
    excludedRoots: readonly string[];
    /** Counts every admitted regular file in the result tree. */
    fileCount: number;
    /** Sums exact raw bytes across every admitted result file. */
    byteCount: CanonicalDecimal;
    /** Confirms no partial scan may pose as usable evidence. */
    status: 'complete';
    /** Binds every portable envelope field in an explicit canonical order. */
    evidenceDigest: `sha256:${string}`;
  }>;

/** Complete receipt input before its deterministic integrity digest is attached. */
export type PhysicalIngestionReceiptInput = Omit<PhysicalIngestionReceipt, 'evidenceDigest'>;

/**
 * Computes deterministic evidence over every portable physical-ingestion field.
 * @param receipt - Complete adapter evidence excluding only its derived digest.
 * @returns SHA-256 identity independent from JavaScript property enumeration.
 */
export function physicalIngestionReceiptEvidence(receipt: PhysicalIngestionReceiptInput): `sha256:${string}` {
  /** Explicit order and NUL separators prevent ambiguous adjacent field encodings. */
  const canonical = [
    'archer-physical-ingestion-receipt-v1',
    receipt.id,
    receipt.object,
    receipt.createdAt,
    receipt.materializerId,
    receipt.materializedViewId,
    receipt.adapterId,
    String(receipt.mappingVersion),
    receipt.base.format,
    receipt.base.digest,
    receipt.base.byteLength,
    receipt.result.format,
    receipt.result.digest,
    receipt.result.byteLength,
    String(receipt.generation),
    receipt.excludedRoots.join(','),
    String(receipt.fileCount),
    receipt.byteCount,
    receipt.status,
  ].join('\0');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Runtime admission for common physical evidence before digest verification. */
const PhysicalIngestionReceiptShapeSchema = archerObjectSchema('ingestion-receipt', IngestionReceiptIdSchema).and(
  z.strictObject({
    materializerId: MaterializerIdSchema,
    materializedViewId: MaterializedViewIdSchema,
    adapterId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    mappingVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    base: TreeRefSchema,
    result: TreeRefSchema,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    excludedRoots: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)),
    fileCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    byteCount: CanonicalDecimalSchema,
    status: z.literal('complete'),
    evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
);

/** Canonical admission and deterministic integrity verification for shared evidence. */
export const PhysicalIngestionReceiptSchema: z.ZodType<PhysicalIngestionReceipt> =
  PhysicalIngestionReceiptShapeSchema.superRefine((value, context) => {
    /** Exclusion names form a set because duplicate roots would make evidence misleading. */
    if (new Set(value.excludedRoots).size !== value.excludedRoots.length) {
      context.addIssue({ code: 'custom', path: ['excludedRoots'], message: 'Excluded roots must be unique' });
    }
    /** Recomputed evidence prevents a structurally valid forged digest from passing admission. */
    const expected = physicalIngestionReceiptEvidence(value);
    if (value.evidenceDigest !== expected) {
      context.addIssue({ code: 'custom', path: ['evidenceDigest'], message: 'Ingestion receipt evidence mismatch' });
    }
  }).transform(
    (value) =>
      Object.freeze({
        ...value,
        excludedRoots: Object.freeze([...value.excludedRoots]),
        evidenceDigest: value.evidenceDigest as `sha256:${string}`,
      }) as PhysicalIngestionReceipt,
  );

/**
 * Constructs one portable receipt through the same verifier used after transport.
 * @param input - Complete adapter facts excluding their deterministic evidence digest.
 * @returns Frozen integrity-bearing receipt ready for adapter specialization.
 */
export function createPhysicalIngestionReceipt(input: PhysicalIngestionReceiptInput): PhysicalIngestionReceipt {
  return PhysicalIngestionReceiptSchema.parse({
    ...input,
    evidenceDigest: physicalIngestionReceiptEvidence(input),
  });
}
