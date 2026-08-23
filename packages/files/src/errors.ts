/**
 * @file Defines stable failures owned by Archer's logical file domain.
 *
 * Native storage and decoder failures remain local causes. Public codes and
 * bounded details carry only identities a caller can safely branch on.
 */

import { ArcherError, type ArcherErrorOptions } from '@archer/core';

/** Stable categories shared by pure file transformations and storage adapters. */
export type FilesErrorCode =
  | 'files_invalid_input'
  | 'files_duplicate_path'
  | 'files_path_conflict'
  | 'files_noncanonical_encoding'
  | 'files_reference_mismatch'
  | 'files_content_missing'
  | 'files_integrity_failed'
  | 'files_store_closed'
  | 'files_source_failed'
  | 'files_io_failed';

/** Options for one Archer-owned file failure with optional local cause evidence. */
export type FilesErrorOptions = Omit<ArcherErrorOptions, 'code'>;

/** One bounded Error family for immutable file identity and storage failures. */
export class FilesError extends ArcherError {
  /**
   * Constructs a focused file failure without adopting an adapter's message.
   * @param code - Stable category suitable for caller branching.
   * @param message - Archer-authored explanation safe for logs and transport projection.
   * @param options - Optional bounded details and process-local native cause.
   */
  constructor(code: FilesErrorCode, message: string, options: FilesErrorOptions = {}) {
    super(message, { code, ...options });
  }
}
