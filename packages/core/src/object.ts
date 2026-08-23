/**
 * @file Defines the one identity envelope shared by Archer domain objects.
 *
 * Lifecycle fields that are not universal, such as update revisions or domain
 * deletion state, stay on the aggregate that owns those semantics.
 */

import * as z from 'zod';

import { TimestampSchema, UuidV4Schema, type Timestamp, type UuidV4 } from './values.js';

/**
 * Gives identity-bearing values a stable discriminator and creation instant
 * without imposing mutation or deletion semantics on every domain.
 */
export type ArcherObject<ObjectName extends string = string, Id extends UuidV4 = UuidV4> = Readonly<{
  /** The UUIDv4 identity, optionally narrowed to an aggregate-specific brand. */
  id: Id;

  /** The stable wire discriminator used for exhaustive domain narrowing. */
  object: ObjectName;

  /** The trusted instant at which this identity first existed. */
  createdAt: Timestamp;
}>;

/**
 * Admits a generic identity envelope while canonicalizing its UUID and instant.
 * The strict object boundary rejects lifecycle fields whose meaning is unknown.
 */
export const ArcherObjectSchema = z
  .strictObject({
    id: UuidV4Schema,
    object: z.string().min(1),
    createdAt: TimestampSchema,
  })
  .readonly();

/**
 * Specializes the identity envelope without weakening its canonical fields.
 * Aggregate packages supply their own branded UUID schema and exact object
 * discriminator, keeping cross-aggregate identity mistakes visible to TypeScript.
 * @param object - The exact discriminator owned by the aggregate.
 * @param idSchema - A boundary schema that produces the aggregate's UUID brand.
 * @returns A strict, readonly Zod schema for the specialized object envelope.
 */
export function archerObjectSchema<const ObjectName extends string, Id extends UuidV4>(
  object: ObjectName,
  idSchema: z.ZodType<Id>,
): z.ZodType<ArcherObject<ObjectName, Id>> {
  return z
    .strictObject({
      id: idSchema,
      object: z.literal(object),
      createdAt: TimestampSchema,
    })
    .readonly();
}
