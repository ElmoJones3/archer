/** @file Defines stable failures for Resource creation and behavior. */

import { ArcherError, type ArcherErrorOptions, type JsonObject } from '@archer/core';

/** Stable categories callers may inspect without matching error messages. */
export type ResourcesErrorCode =
  | 'prompt_source_missing'
  | 'prompt_source_not_regular'
  | 'prompt_source_invalid_utf8'
  | 'prompt_source_changed'
  | 'prompt_template_invalid'
  | 'prompt_variable_invalid'
  | 'prompt_variable_undeclared'
  | 'prompt_variable_unused'
  | 'prompt_parameter_missing'
  | 'prompt_parameter_extra'
  | 'prompt_contribution_unverified'
  | 'prompt_duplicate_revision'
  | 'budget_policy_empty'
  | 'budget_limit_invalid'
  | 'budget_widening_refused'
  | 'budget_request_widens_bound'
  | 'budget_parent_expired'
  | 'budget_deadline_overflow'
  | 'profile_revision_stale'
  | 'profile_selection_duplicate'
  | 'profile_skill_not_selected'
  | 'profile_skill_already_active'
  | 'profile_transition_no_change'
  | 'skill_manifest_missing'
  | 'skill_manifest_not_regular'
  | 'skill_manifest_invalid_utf8'
  | 'skill_frontmatter_invalid'
  | 'skill_name_invalid'
  | 'skill_description_invalid'
  | 'skill_reference_invalid'
  | 'skill_reference_escapes_root'
  | 'skill_reference_missing'
  | 'skill_reference_not_regular'
  | 'skill_link_refused'
  | 'skill_source_changed'
  | 'resources_invalid_prompt'
  | 'resources_prompt_import_failed'
  | 'resources_prompt_transition_refused'
  | 'resources_invalid_budget'
  | 'resources_invalid_budget_allocation'
  | 'resources_budget_no_change'
  | 'resources_invalid_skill'
  | 'resources_skill_file_missing'
  | 'resources_skill_import_failed'
  | 'resources_skill_transition_refused'
  | 'resources_invalid_profile'
  | 'resources_self_review_refused'
  | 'resources_admission_refused'
  | 'resources_compile_refused'
  | 'resources_invalid_resource_set'
  | 'resources_prepare_refused'
  | 'resources_hydration_failed';

/** Constructor options that retain a local cause and portable bounded evidence. */
export type ResourcesErrorOptions = ErrorOptions &
  Readonly<{
    /** Optional machine-readable fields safe to cross a process boundary. */
    details?: JsonObject;
  }>;

/** Archer-owned Error used for invalid Resource input and refused behavior. */
export class ResourcesError extends ArcherError {
  /** Stable category narrowed to the Resource package vocabulary. */
  override readonly code: ResourcesErrorCode;

  /**
   * Creates one Resource failure without exposing validator or filesystem text.
   * @param code - Stable category suitable for exhaustive caller handling.
   * @param message - Human-readable diagnosis for local logs and debugging.
   * @param options - Optional portable details and process-local cause.
   */
  constructor(code: ResourcesErrorCode, message: string, options?: ResourcesErrorOptions) {
    /** ArcherError owns cause preservation and immutable JSON detail admission. */
    const archerOptions: ArcherErrorOptions = {
      code,
      ...(options?.details === undefined ? {} : { details: options.details }),
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    };
    super(message, archerOptions);
    this.code = code;
  }
}
