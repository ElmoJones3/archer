/**
 * @file Acquires Node directories and publishes domain-admitted Skill snapshots.
 *
 * Host traversal and FileStore effects remain here. Agent Skills grammar,
 * references, progressive disclosure, and revision legality remain with Skill.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { Result, type Result as ResultValue } from '@archer/core';
import {
  FileMode,
  LogicalPathSchema,
  memoryFileStore,
  publishTree,
  type FileStore,
  type LogicalPath,
} from '@archer/files';

import { ResourcesError } from '../errors.js';
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  assertSkillSnapshotOperation,
  installSkillSnapshot,
  type InstallSkillSnapshotOperation,
  type Skill,
  type SkillCreationContext,
  type SkillRevisionContext,
  type SkillSnapshotFile,
} from './index.js';

/** Input accepted by the Node Skill directory importer. */
export type ImportSkillDirectoryInput = Readonly<{
  /** Caller-owned stable host directory whose basename is the Agent Skills name. */
  directory: string;
}>;

/** Borrowed capabilities used while importing one initial Skill directory. */
export type SkillImportDependencies = Readonly<{
  /** Borrowed immutable-file destination retaining the validated snapshot. */
  files: FileStore;

  /** Supplies deterministic initial identity and time owned by the application boundary. */
  context: SkillCreationContext;
}>;

/** Borrowed capabilities used while reimporting one exact Skill child. */
export type SkillReimportDependencies = Readonly<{
  /** Borrowed immutable-file destination retaining the validated child snapshot. */
  files: FileStore;

  /** Supplies fresh child identity and trusted time. */
  context: SkillRevisionContext;
}>;

/**
 * Recursively acquires only regular files without following symbolic links.
 * @param root - Absolute or caller-relative Skill root.
 * @param relativeDirectory - Canonical relative directory currently visited.
 * @param files - Private file accumulator that never escapes mutable.
 * @param directories - Canonical directory names used to distinguish non-regular references.
 * @param resolvedRoot - Canonical root used to refuse escaping directory resolution.
 */
async function acquireDirectory(
  root: string,
  relativeDirectory: string,
  files: SkillSnapshotFile[],
  directories: LogicalPath[],
  resolvedRoot: string,
): Promise<void> {
  /** Host path stays inside the already-lstat-checked traversal. */
  const directory = relativeDirectory.length === 0 ? root : join(root, ...relativeDirectory.split('/'));
  /** Directory identity is sampled so stable links and changes observed during this read are refused. */
  const directoryBefore = await lstat(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new ResourcesError('skill_source_changed', 'Skill directory changed during acquisition', {
      details: { path: relativeDirectory || '.' },
    });
  }
  /** Canonical host containment refuses an escaping directory visible at this observation point. */
  const resolvedDirectory = await realpath(directory);
  /** Relative canonical path proves the resolved directory stays under the root. */
  const fromRoot = relative(resolvedRoot, resolvedDirectory);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Skill directory escaped its root: ${relativeDirectory || '.'}`);
  }
  /** Bytewise name sorting makes host enumeration order irrelevant. */
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  /** Every host entry is classified before content can enter the snapshot. */
  for (const entry of entries) {
    /** Logical path uses product slash semantics independently of the host platform. */
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    /** lstat ensures a symbolic link never becomes a traversed directory or copied file. */
    const status = await lstat(join(directory, entry.name));
    if (status.isSymbolicLink()) {
      throw new ResourcesError('skill_link_refused', 'Symbolic links are not allowed in Skills', {
        details: { path: relativePath },
      });
    }
    if (status.isDirectory()) {
      directories.push(LogicalPathSchema.parse(relativePath));
      await acquireDirectory(root, relativePath, files, directories, resolvedRoot);
      continue;
    }
    if (!status.isFile()) throw new TypeError(`Special files are not allowed: ${relativePath}`);
    if (files.length >= MAX_SKILL_FILES) throw new TypeError('Skill contains too many files');
    /** LogicalPath admission rejects traversal syntax, reserved paths, and invalid Unicode. */
    const path = LogicalPathSchema.parse(relativePath);
    /** No-follow open closes the lstat/read race that could otherwise capture an outside file. */
    const handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    /** File-descriptor identity remains stable even if its directory entry is concurrently replaced. */
    let content: Uint8Array;
    /** Mode comes from the opened object, not the earlier path observation. */
    let mode: SkillSnapshotFile['mode'];
    try {
      /** Bigint timestamps and inode identity expose changes during the complete read. */
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new ResourcesError('skill_reference_not_regular', 'Skill entry is not a regular file', {
          details: { path: relativePath },
        });
      }
      content = Uint8Array.from(await handle.readFile());
      /** Post-read descriptor state proves the opened file remained stable. */
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(content.byteLength) !== after.size
      ) {
        throw new ResourcesError('skill_source_changed', 'Skill file changed during acquisition', {
          details: { path: relativePath },
        });
      }
      mode = before.mode & 0o111n ? FileMode.executable : FileMode.readable;
    } finally {
      await handle.close();
    }
    /** Aggregate bytes are bounded across the complete directory, not per file. */
    const priorBytes = files.reduce((total, file) => total + file.content.byteLength, 0);
    if (priorBytes + content.byteLength > MAX_SKILL_BYTES) throw new TypeError('Skill content exceeds byte limit');
    files.push(Object.freeze({ path, content, mode }));
  }
  /** A changed directory frontier invalidates the whole acquisition rather than publishing a mixed snapshot. */
  const directoryAfter = await lstat(directory, { bigint: true });
  if (
    !directoryAfter.isDirectory() ||
    directoryAfter.isSymbolicLink() ||
    directoryBefore.dev !== directoryAfter.dev ||
    directoryBefore.ino !== directoryAfter.ino ||
    directoryBefore.mtimeNs !== directoryAfter.mtimeNs ||
    directoryBefore.ctimeNs !== directoryAfter.ctimeNs
  ) {
    throw new ResourcesError('skill_source_changed', 'Skill directory changed during acquisition', {
      details: { path: relativeDirectory || '.' },
    });
  }
}

/**
 * Acquires, plans, admits, and publishes one initial or child Agent Skills directory.
 * @param input - Stable host directory acquired by the Node adapter.
 * @param files - Borrowed immutable destination.
 * @param operation - Explicit initial or child identity facts.
 * @returns Behavior-bearing Skill or exact acquisition, convention, transition, or publication refusal.
 */
async function importSkillDirectoryRevision(
  input: ImportSkillDirectoryInput,
  files: FileStore,
  operation: InstallSkillSnapshotOperation,
): Promise<ResultValue<Skill, ResourcesError>> {
  try {
    /** Invalid parent or child facts fail before host acquisition or immutable publication. */
    assertSkillSnapshotOperation(operation);
    /** Root itself cannot be a symlink or non-directory masquerading as a Skill. */
    let rootStatus: Awaited<ReturnType<typeof lstat>>;
    try {
      rootStatus = await lstat(input.directory);
    } catch (cause) {
      return Result.error(
        new ResourcesError('skill_manifest_missing', 'Skill directory or SKILL.md is missing', { cause }),
      );
    }
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      return Result.error(new ResourcesError('skill_manifest_not_regular', 'Skill root must be a real directory'));
    }
    /** Complete acquisition and bounded copying happen before FileStore publication. */
    const acquired: SkillSnapshotFile[] = [];
    /** Directory catalogue preserves exact non-regular reference diagnostics. */
    const directories: LogicalPath[] = [];
    /** Canonical root anchors containment for every recursively acquired directory. */
    const resolvedRoot = await realpath(input.directory);
    await acquireDirectory(input.directory, '', acquired, directories, resolvedRoot);
    /** Immutable sources drive isolated planning and eventual caller publication identically. */
    const sources = acquired.map((file) => ({ path: file.path, content: file.content, mode: file.mode }));
    /** Isolated memory publication derives tree identity without mutating caller-owned storage. */
    const staging = memoryFileStore();
    /** Planned tree identity remains valid after the staging capability closes. */
    let planned: Awaited<ReturnType<typeof publishTree>>;
    try {
      planned = await publishTree(staging, sources);
    } finally {
      await staging.close();
    }
    if (!planned.ok) {
      return Result.error(
        new ResourcesError('resources_skill_import_failed', 'Skill snapshot planning failed', {
          cause: planned.error,
        }),
      );
    }
    /** Domain admission settles every convention and transition before caller storage changes. */
    const installed = installSkillSnapshot(
      {
        directoryName: basename(input.directory),
        files: Object.freeze(acquired),
        directories: Object.freeze(directories),
        tree: planned.value,
      },
      operation,
    );
    if (!installed.ok) return installed;
    /** Caller publication begins only after domain behavior has proved the snapshot useful. */
    const published = await publishTree(files, sources);
    if (!published.ok) {
      return Result.error(
        new ResourcesError('resources_skill_import_failed', 'Skill snapshot publication failed', {
          cause: published.error,
        }),
      );
    }
    if (JSON.stringify(published.value.ref) !== JSON.stringify(planned.value.ref)) {
      return Result.error(
        new ResourcesError('resources_skill_import_failed', 'Published Skill identity differs from planned state'),
      );
    }
    return installed;
  } catch (cause) {
    /** Preserves exact Skill refusals while bounding unexpected host adapter failures. */
    if (cause instanceof ResourcesError) return Result.error(cause);
    return Result.error(new ResourcesError('resources_invalid_skill', 'Invalid Agent Skill directory', { cause }));
  }
}

/**
 * Imports, validates, and snapshots one real Agent Skills directory.
 * @param input - Stable host directory acquired by the Node source adapter.
 * @param dependencies - Borrowed immutable files and explicit deterministic facts.
 * @returns Initial behavior-bearing Skill or exact import refusal.
 */
export function importSkillDirectory(
  input: ImportSkillDirectoryInput,
  dependencies: SkillImportDependencies,
): Promise<ResultValue<Skill, ResourcesError>> {
  return importSkillDirectoryRevision(input, dependencies.files, {
    kind: 'initial',
    context: dependencies.context,
  });
}

/**
 * Reimports changed directory content as one exact child Skill revision.
 * @param parent - Exact admitted parent Skill.
 * @param input - Stable host directory acquired by the Node source adapter.
 * @param dependencies - Borrowed immutable files and explicit child facts.
 * @returns Child Skill or exact no-change, source, transition, or publication refusal.
 */
export function reimportSkillDirectory(
  parent: Skill,
  input: ImportSkillDirectoryInput,
  dependencies: SkillReimportDependencies,
): Promise<ResultValue<Skill, ResourcesError>> {
  return importSkillDirectoryRevision(input, dependencies.files, {
    kind: 'revision',
    parent,
    context: dependencies.context,
  });
}
