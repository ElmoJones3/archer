/** @file Defines exact local failures for model definition and activation. */

import { ArcherError, type ArcherErrorOptions } from '@archer/core';

/** Stable categories callers may branch on without matching Error messages. */
export type ModelsErrorCode =
  | 'models_invalid_input'
  | 'models_output_limit_exceeded'
  | 'models_revision_no_change'
  | 'models_target_duplicate'
  | 'models_target_mismatch'
  | 'models_target_unbound'
  | 'models_router_closed';

/** Carries model-domain refusals while retaining native cause locally. */
export class ModelsError extends ArcherError {
  /** Stable category narrowed to the model package vocabulary. */
  override readonly code: ModelsErrorCode;

  /**
   * Creates one model-domain failure.
   * @param code - Stable category for application branching and diagnostics.
   * @param message - Bounded explanation that does not expose credentials.
   * @param options - Optional structured details and local native cause.
   */
  constructor(code: ModelsErrorCode, message: string, options?: Omit<ArcherErrorOptions, 'code'>) {
    super(message, { code, ...options });
    this.code = code;
  }
}
