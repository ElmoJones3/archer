/** @file Loads explicitly selected Skill support through an immutable content port. */

import { Result, type Result as ResultValue } from '@archer/core';
import { LogicalPathSchema, restoreTree, type FileStore, type LogicalPath, type TreeRef } from '@archer/files';

import { ResourcesError } from '../errors.js';
import { skillRef, type Skill, type SkillRef } from './index.js';

/** Borrowed immutable content port used for explicit support-file disclosure. */
export interface SkillContentReader {
  /**
   * Reads one exact file from one immutable tree.
   * @param tree - Exact complete Skill snapshot identity.
   * @param path - Canonical contained logical path.
   * @returns Detached verified bytes or one file-plane failure.
   */
  read(tree: TreeRef, path: LogicalPath): Promise<ResultValue<Uint8Array, ResourcesError>>;
}

/** Complete support-file disclosure returned by the application service. */
export type LoadedSkillSupport = Readonly<{
  /** Exact Skill revision whose immutable snapshot supplied the bytes. */
  ref: SkillRef;

  /** Canonical path inside the exact Skill snapshot. */
  path: LogicalPath;

  /** Detached verified support bytes. */
  content: Uint8Array;
}>;

/**
 * Adapts one caller-owned immutable FileStore to Skill support disclosure.
 * @param files - Borrowed FileStore retaining exact Skill trees and blobs.
 * @returns Reader that verifies tree membership and blob bytes on every read.
 */
export function fileStoreSkillContentReader(files: FileStore): SkillContentReader {
  /** Contextual typing keeps the callback aligned with the public immutable-content port. */
  const reader: SkillContentReader = {
    /**
     * Reads one exact member and returns detached bytes after terminal verification.
     * @param tree - Exact immutable Skill tree selected by admitted behavior.
     * @param path - Validated contained logical path requested for disclosure.
     * @returns Detached verified bytes or one bounded Skill content failure.
     */
    async read(tree, path) {
      /** Restores and verifies the exact immutable Skill tree before support disclosure. */
      const restored = await restoreTree(files, tree);
      if (!restored.ok) {
        return Result.error(
          new ResourcesError('skill_reference_missing', 'Skill tree could not be restored', {
            details: { path },
            cause: restored.error,
          }),
        );
      }
      /** Restricts reads to a file admitted in the Skill snapshot rather than arbitrary store content. */
      const entry = restored.value.files.find((candidate) => candidate.path === path);
      if (entry === undefined) {
        return Result.error(
          new ResourcesError('skill_reference_missing', 'Skill support path is not in the immutable tree', {
            details: { path },
          }),
        );
      }
      /** Opens the exact content-addressed blob only after tree membership succeeds. */
      const opened = await files.blobs.read(entry.blob);
      if (!opened.ok) {
        return Result.error(
          new ResourcesError('skill_reference_missing', 'Skill support blob is unavailable', {
            details: { path },
            cause: opened.error,
          }),
        );
      }
      /** Chunk accumulation occurs only after the exact BlobRef was selected from the tree. */
      const chunks: Uint8Array[] = [];
      /** Tracks verified bytes independently from chunks so transport framing cannot bypass completeness. */
      let byteLength = 0;
      try {
        /** Consumes the stream fully because BlobStore integrity is established at terminal completion. */
        for await (const chunk of opened.value.content) {
          /** Detaches each store-owned chunk before retaining it beyond the iteration boundary. */
          const copied = Uint8Array.from(chunk);
          chunks.push(copied);
          byteLength += copied.byteLength;
        }
      } catch (cause) {
        return Result.error(
          new ResourcesError('skill_source_changed', 'Skill support blob failed integrity verification', {
            details: { path },
            cause,
          }),
        );
      }
      /** One detached buffer prevents the FileStore stream from escaping its read lifetime. */
      const content = new Uint8Array(byteLength);
      /** Copies verified chunks into one result without exposing FileStore-owned buffers. */
      let offset = 0;
      /** Preserves stream order while assembling the detached result. */
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Result.ok(content);
    },
  };
  return Object.freeze(reader);
}

/**
 * Loads one contained support file through the exact immutable content port.
 * @param skill - Exact behavior-bearing Skill revision.
 * @param proposedPath - Canonical logical path retained by the Skill snapshot.
 * @param content - Borrowed reader that verifies the exact TreeRef and blob bytes.
 * @returns Detached support bytes bound to the exact Skill revision.
 */
export async function loadSkillSupport(
  skill: Skill,
  proposedPath: string,
  content: SkillContentReader,
): Promise<ResultValue<LoadedSkillSupport, ResourcesError>> {
  /** Reference projection proves package provenance before any path or file effect occurs. */
  let ref: SkillRef;
  try {
    ref = skillRef(skill);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_invalid_skill', 'Skill support requires admitted behavior', { cause }),
    );
  }
  /** Admits the requested support path before comparing it with the validated snapshot index. */
  let path: LogicalPath;
  try {
    path = LogicalPathSchema.parse(proposedPath);
  } catch (cause) {
    return Result.error(
      new ResourcesError('skill_reference_invalid', 'Skill support path is invalid', {
        details: { path: proposedPath },
        cause,
      }),
    );
  }
  if (!skill.paths.includes(path)) {
    return Result.error(
      new ResourcesError('skill_reference_missing', 'Skill support path is not in the immutable snapshot', {
        details: { path },
      }),
    );
  }
  /** Reads support content through the exact Skill tree so host paths never re-enter disclosure. */
  const loaded = await content.read(skill.tree.ref, path);
  if (!loaded.ok) return loaded;
  return Result.ok(Object.freeze({ ref, path, content: Uint8Array.from(loaded.value) }));
}
