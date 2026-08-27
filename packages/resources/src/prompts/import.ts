/**
 * @file Coordinates Prompt source acquisition and immutable publication.
 *
 * Prompt grammar remains owned by the domain module. This application service
 * borrows source and file ports, validates before publication, then installs
 * behavior from the resulting immutable source identity.
 */

import { Result, type Result as ResultValue } from '@archer/core';
import { FileMode, publishTree, type FileStore, type LogicalPath } from '@archer/files';

import { ResourcesError } from '../errors.js';
import {
  assertPromptDefinition,
  defineImportedPrompt,
  type Prompt,
  type PromptCreationContext,
  type PromptPlacement,
  type PromptSourceRef,
} from './index.js';

/** One source file acquired before Prompt construction begins. */
export type PromptSourceFile = Readonly<{
  /** Canonical logical name used inside the immutable snapshot. */
  path: LogicalPath;

  /** Detached file bytes observed by the source adapter. */
  bytes: Uint8Array;
}>;

/** Caller-owned source acquisition port used by Prompt import behavior. */
export interface PromptSourceImporter {
  /**
   * Acquires one stable regular file without deciding Prompt semantics.
   * @param source - Application source locator understood by the adapter.
   * @returns Detached bytes and a canonical logical path or one source failure.
   */
  readFile(source: string): Promise<ResultValue<PromptSourceFile, ResourcesError>>;
}

/** Input accepted by the asynchronous Prompt file importer. */
export type ImportPromptFileInput = Readonly<{
  /** Application source locator supplied to the source adapter. */
  source: string;

  /** Optional display label independent from source location. */
  name?: string;

  /** Selects whether rendered text becomes an instruction or user message. */
  placement: PromptPlacement;

  /** Exact declared variables; inferred when omitted. */
  variables?: readonly string[];
}>;

/** Borrowed capabilities used while importing one Prompt source. */
export type PromptImportDependencies = Readonly<{
  /** Retains the exact source bytes in Archer's immutable file plane. */
  files: FileStore;

  /** Acquires one stable source file without embedding host paths in Prompt state. */
  source: PromptSourceImporter;

  /** Supplies deterministic initial identity and time owned by the application boundary. */
  context: PromptCreationContext;
}>;

/**
 * Imports, validates, snapshots, and installs one Prompt source file.
 * @param input - Source locator and Prompt behavior metadata.
 * @param dependencies - Borrowed source, immutable files, and explicit deterministic facts.
 * @returns Imported Prompt or one exact source, publication, or domain refusal.
 */
export async function importPromptFile(
  input: ImportPromptFileInput,
  dependencies: PromptImportDependencies,
): Promise<ResultValue<Prompt, ResourcesError>> {
  try {
    /** Acquires stable bytes before Prompt parsing or immutable publication begins. */
    const acquired = await dependencies.source.readFile(input.source);
    if (!acquired.ok) return acquired;
    /** Strict UTF-8 rejects replacement-character corruption at the source boundary. */
    let template: string;
    try {
      template = new TextDecoder('utf-8', { fatal: true }).decode(acquired.value.bytes);
    } catch (cause) {
      return Result.error(
        new ResourcesError('prompt_source_invalid_utf8', 'Prompt source is not valid UTF-8', {
          details: { path: acquired.value.path },
          cause,
        }),
      );
    }
    /** Complete domain input is assembled once for pre-effect validation and final installation. */
    const definition = Object.freeze({
      ...(input.name === undefined ? {} : { name: input.name }),
      placement: input.placement,
      template,
      ...(input.variables === undefined ? {} : { variables: input.variables }),
    });
    /** Prompt owns grammar; the application service merely invokes it before committing bytes. */
    assertPromptDefinition(definition, dependencies.context);
    /** Immutable publication is the only effect between domain admission and behavior installation. */
    const published = await publishTree(dependencies.files, [
      { path: acquired.value.path, content: acquired.value.bytes, mode: FileMode.readable },
    ]);
    if (!published.ok) {
      return Result.error(
        new ResourcesError('prompt_source_changed', 'Prompt source could not be snapshotted', {
          details: { path: acquired.value.path },
          cause: published.error,
        }),
      );
    }
    /** Source identity, not the live FileStore capability, crosses into Prompt behavior. */
    const source: PromptSourceRef = Object.freeze({ tree: published.value.ref, path: acquired.value.path });
    return Result.ok(defineImportedPrompt(definition, source, dependencies.context));
  } catch (cause) {
    /** Preserves exact Prompt refusals while bounding unexpected adapter failures. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('resources_prompt_import_failed', 'Prompt import failed', { cause });
    return Result.error(error);
  }
}
