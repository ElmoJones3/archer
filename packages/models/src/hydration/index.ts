/** @file Restores model behavior only from validated DTOs and exact admitted parents. */

import { Result, type Result as ResultValue } from '@archer/core';

import { ModelsError } from '../errors.js';
import { assertAdmittedModel, hydrateModelState, type Model, type ModelDto } from '../targets.js';
import { ModelCodec } from '../transport/index.js';

/** Input required to hydrate one initial or exact child model revision. */
export type HydrateModelInput = Readonly<{
  /** Untrusted persisted or transported model DTO. */
  dto: unknown;

  /** Required exact admitted parent when the DTO describes a child revision. */
  parent?: Model;
}>;

/**
 * Refuses orphaned, fabricated, skipped, or time-reversing model histories.
 * @param dto - Transport-validated model revision proposed for hydration.
 * @param parent - Exact admitted parent supplied by the application.
 */
function assertModelParent(dto: ModelDto, parent: Model | undefined): void {
  if (dto.revision === 1) {
    if (parent !== undefined) throw new TypeError('Initial model revision cannot be hydrated with a parent');
    return;
  }
  if (parent === undefined) throw new TypeError('Later model revision requires its exact admitted parent');
  /** Runtime provenance prevents a copied DTO from authorizing model ancestry. */
  assertAdmittedModel(parent);
  if (
    dto.id !== parent.id ||
    dto.revision !== parent.revision + 1 ||
    dto.previousRevisionId !== parent.revisionId ||
    dto.createdAt !== parent.createdAt ||
    dto.updatedAt < parent.updatedAt
  ) {
    throw new TypeError('Model revision does not continue the supplied exact parent');
  }
}

/**
 * Restores an admitted immutable Model after DTO and exact-parent verification.
 * @param input - Untrusted transport value plus required admitted parent evidence.
 * @returns Admitted model behavior or one normalized hydration failure.
 */
export function hydrateModel(input: HydrateModelInput): ResultValue<Model, ModelsError> {
  try {
    /** Parsing establishes portable shape and semantic contentDigest without granting behavior. */
    const parsed = ModelCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    assertModelParent(parsed.value, input.parent);
    return Result.ok(hydrateModelState(parsed.value));
  } catch (cause) {
    return Result.error(new ModelsError('models_invalid_input', 'Model hydration failed', { cause }));
  }
}
