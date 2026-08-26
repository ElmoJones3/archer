/** @file Imports real Agent Skills directories into behavior-bearing immutable Resources. */

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, sep } from 'node:path';

import * as z from 'zod';
import { parseDocument } from 'yaml';

import { Result, type Result as ResultValue, type Sha256Digest, type UuidV4 } from '@archer/core';
import {
  FileMode,
  LogicalPathSchema,
  memoryFileStore,
  publishTree,
  restoreTree,
  type FileStore,
  type ImmutableTree,
  type LogicalPath,
  type TreeRef,
} from '@archer/files';

import {
  createInitialRevisionIdentity,
  createRevisionIdentity,
  initialResourceContext,
  resourceDigest,
  type ResourceCreationContext,
  type ResourceRevision,
  type ResourceRevisionContext,
  type RevisionIdentity,
} from '../common.js';
import { ResourcesError } from '../errors.js';

/** Prevents unrelated UUIDs from naming a Skill. */
declare const skillIdBrand: unique symbol;

/** Stable identity shared by every immutable revision of one Skill. */
export type SkillId = UuidV4 & {
  /** Carries compile-time evidence of Skill identity admission. */
  readonly [skillIdBrand]: true;
};

/** Prevents a Skill identity from posing as one exact Skill revision. */
declare const skillRevisionIdBrand: unique symbol;

/** Identity of one exact immutable Skill revision. */
export type SkillRevisionId = UuidV4 & {
  /** Carries compile-time evidence of Skill revision admission. */
  readonly [skillRevisionIdBrand]: true;
};

/** Exact initial Skill facts accepted by deterministic application boundaries. */
export type SkillCreationContext = ResourceCreationContext<SkillId, SkillRevisionId>;

/** Exact child facts required by pure Skill reimport behavior. */
export type SkillRevisionContext = ResourceRevisionContext<SkillRevisionId>;

/** Maximum regular files admitted by one v1 Skill import. */
export const MAX_SKILL_FILES = 256;

/** Maximum aggregate file bytes admitted by one v1 Skill import. */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;

/** Agent Skills manifest fields Archer understands without inventing metadata. */
export type SkillManifest = Readonly<{
  /** Required Skill name matching the containing directory. */
  name: string;

  /** Required concise progressive-disclosure summary. */
  description: string;

  /** Optional license identifier or bundled license-file reference. */
  license?: string;

  /** Optional environment compatibility note. */
  compatibility?: string;

  /** Optional string-valued client metadata. */
  metadata?: Readonly<Record<string, string>>;

  /** Optional pre-approved tool names from the current Agent Skills field. */
  allowedTools?: readonly string[];
}>;

/** Short Skill projection suitable for a model's discovery catalogue. */
export type SkillSummary = Readonly<{
  /** Exact Skill revision whose discovery metadata is shown. */
  ref: SkillRef;

  /** Manifest-derived Skill name. */
  name: string;

  /** Manifest-derived concise description. */
  description: string;
}>;

/** Portable exact reference retained by AgentProfile selections. */
export type SkillRef = Readonly<{
  /** Narrows the Wave 6 Resource family. */
  resource: 'skill';

  /** Stable logical Skill identity. */
  id: SkillId;

  /** Exact selected immutable revision. */
  revisionId: SkillRevisionId;

  /** Manifest-derived Skill name. */
  name: string;

  /** Complete immutable content identity. */
  contentDigest: Sha256Digest;
}>;

/** JSON-safe Skill state emitted at transport boundaries. */
export type SkillDto = ResourceRevision<'skill', SkillId, SkillRevisionId> &
  Readonly<{
    /** Narrows the Wave 6 Resource family. */
    resource: 'skill';

    /** Validated current Agent Skills manifest. */
    manifest: SkillManifest;

    /** Immutable complete directory snapshot identity. */
    tree: TreeRef;

    /** Canonical file paths available for explicit progressive disclosure. */
    paths: readonly LogicalPath[];
  }>;

/** Input accepted by {@link importSkillDirectory}. */
export type ImportSkillDirectoryInput = Readonly<{
  /** Caller-owned stable host directory whose basename is the Agent Skills name. */
  directory: string;
}>;

/** Borrowed capabilities used while importing one Skill directory. */
export type SkillImportDependencies = Readonly<{
  /** Borrowed immutable-file destination retaining the validated snapshot. */
  files: FileStore;

  /** Supplies deterministic initial identity and time when needed. */
  context?: SkillCreationContext;
}>;

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

/**
 * Adapts one caller-owned immutable FileStore to Skill support disclosure.
 * @param files - Borrowed FileStore retaining exact Skill trees and blobs.
 * @returns Reader that verifies tree membership and blob integrity on every read.
 */
export function fileStoreSkillContentReader(files: FileStore): SkillContentReader {
  /** Contextual typing keeps the callback aligned with the public immutable-content port. */
  const reader: SkillContentReader = {
    /**
     * Reads one exact member and returns detached bytes after terminal verification.
     * @param tree - Exact immutable Skill tree selected by admitted behavior.
     * @param path - Validated contained file path requested for disclosure.
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
      /** Tracks verified bytes independently from chunks so transport framing cannot bypass size limits. */
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
      /** Copies verified chunks into one result without exposing the FileStore's buffers. */
      let offset = 0;
      /** Preserves provider chunk order when reconstructing the exact file bytes. */
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Result.ok(content);
    },
  };
  return Object.freeze(reader);
}

/** Complete instruction disclosure returned by explicit Skill behavior. */
export type LoadedSkillInstructions = Readonly<{
  /** Exact Skill revision whose instructions are disclosed. */
  ref: SkillRef;

  /** Validated Markdown body beneath SKILL.md front matter. */
  content: string;
}>;

/** Complete support-file disclosure returned by explicit Skill behavior. */
export type LoadedSkillSupport = Readonly<{
  /** Exact Skill revision whose immutable snapshot supplied the bytes. */
  ref: SkillRef;

  /** Canonical path inside the exact Skill snapshot. */
  path: LogicalPath;

  /** Detached verified support bytes. */
  content: Uint8Array;
}>;

/** One complete in-memory regular file acquired before immutable publication. */
type AcquiredSkillFile = Readonly<{
  /** Canonical slash-separated path relative to the Skill root. */
  path: LogicalPath;

  /** Copied exact bytes read from the host filesystem. */
  content: Uint8Array;

  /** Portable executable or readable intent derived from host mode bits. */
  mode: (typeof FileMode)[keyof typeof FileMode];
}>;

/** Parsed root document separated into manifest and body instructions. */
type ParsedSkillDocument = Readonly<{
  /** Current Agent Skills front matter. */
  manifest: SkillManifest;

  /** Markdown instructions below the front matter delimiter. */
  instructions: string;
}>;

/** Current Agent Skills name rules, including no consecutive or edge hyphens. */
const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Known manifest fields; passthrough preserves forward compatibility without trusting extensions. */
const SkillManifestSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().trim().min(1).optional(),
  })
  .passthrough();

/** UTF-8 decoder rejects malformed instruction text instead of replacing bytes silently. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Markdown inline-link target extraction for local supporting files. */
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;

/** Markdown reference-definition target extraction for local supporting files. */
const MARKDOWN_REFERENCE = /^\s*\[[^\]]+\]:\s*(\S+)/gmu;

/** Inline-code extraction catches conventional `references/` and `scripts/` mentions. */
const INLINE_CODE = /`([^`\r\n]+)`/gu;

/** Bare conventional directories remain recognizable even without Markdown link syntax. */
const CONVENTIONAL_PATH = /(?:^|[\s(])((?:scripts|references|assets)\/[A-Za-z0-9._/-]+)/gmu;

/** Runtime-only token prevents ordinary callers from invoking the class constructor. */
const SKILL_CONSTRUCTION = Symbol('archer.skill.construction');

/** Runtime provenance distinguishes imported Skill behavior from DTO copies and casts. */
const ADMITTED_SKILLS = new WeakSet<object>();

/**
 * Projects one exact Skill reference without exposing content bytes or methods.
 * @param skill - Behavior-bearing Skill whose revision is selected.
 * @returns Frozen portable exact reference.
 */
export function skillRef(skill: Skill): SkillRef {
  if (!ADMITTED_SKILLS.has(skill)) {
    throw new ResourcesError(
      'resources_invalid_skill',
      'Skill reference requires behavior earned by import or hydration',
    );
  }
  return Object.freeze({
    resource: 'skill',
    id: skill.id,
    revisionId: skill.revisionId,
    name: skill.name,
    contentDigest: skill.contentDigest,
  });
}

/**
 * Parses one current Agent Skills root document and derives all safe metadata.
 * @param text - Strictly decoded root `SKILL.md` content.
 * @param directoryName - Actual containing directory basename.
 * @returns Validated manifest and body instructions.
 */
function parseSkillDocument(text: string, directoryName: string): ParsedSkillDocument {
  /** BOM is permitted by common editors but excluded from the semantic body. */
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  /** The root must begin with YAML front matter and include its closing delimiter. */
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
  if (match === null) {
    throw new ResourcesError('skill_frontmatter_invalid', 'SKILL.md must begin with YAML front matter');
  }
  /** YAML document parser exposes syntax errors without silently accepting them. */
  const document = parseDocument(match[1] as string);
  if (document.errors.length > 0) {
    throw new ResourcesError('skill_frontmatter_invalid', 'SKILL.md front matter is invalid YAML', {
      cause: document.errors[0],
    });
  }
  /** Alias expansion is disabled at both parse and JavaScript conversion boundaries. */
  let admitted: z.output<typeof SkillManifestSchema>;
  try {
    admitted = SkillManifestSchema.parse(document.toJS({ maxAliasCount: 0 }));
  } catch (cause) {
    /** Inspects structured YAML issues so stable Skill error codes do not depend on message text. */
    const issues = cause instanceof z.ZodError ? cause.issues : [];
    /** Separates invalid names from other manifest failures for actionable import refusal. */
    const code = issues.some((issue) => issue.path[0] === 'name')
      ? 'skill_name_invalid'
      : issues.some((issue) => issue.path[0] === 'description')
        ? 'skill_description_invalid'
        : 'skill_frontmatter_invalid';
    throw new ResourcesError(code, 'SKILL.md front matter violates the Agent Skills contract', { cause });
  }
  if (admitted.name !== directoryName) {
    throw new ResourcesError('skill_name_invalid', 'Skill name must match its containing directory', {
      details: { declared: admitted.name, directory: directoryName },
    });
  }
  /** Known fields are copied from the admitted document; extensions stay out of Archer behavior. */
  const manifest: SkillManifest = Object.freeze({
    name: admitted.name,
    description: admitted.description,
    ...(admitted.license === undefined ? {} : { license: admitted.license }),
    ...(admitted.compatibility === undefined ? {} : { compatibility: admitted.compatibility }),
    ...(admitted.metadata === undefined ? {} : { metadata: Object.freeze({ ...admitted.metadata }) }),
    ...(admitted['allowed-tools'] === undefined
      ? {}
      : { allowedTools: Object.freeze(admitted['allowed-tools'].split(/\s+/u)) }),
  });
  /** Empty instruction bodies do not supply behavior and therefore are not Skills. */
  const instructions = (match[2] as string).trim();
  if (instructions.length === 0) {
    throw new ResourcesError('skill_frontmatter_invalid', 'SKILL.md must include instructions after front matter');
  }
  return Object.freeze({ manifest, instructions });
}

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
  files: AcquiredSkillFile[],
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
    let mode: (typeof FileMode)[keyof typeof FileMode];
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
    files.push(
      Object.freeze({
        path,
        content,
        mode,
      }),
    );
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
 * Selects local-looking Markdown references and ignores URLs, anchors, and code.
 * @param text - Markdown source inspected without executing it.
 * @returns Raw local path candidates in source order.
 */
function localReferenceCandidates(text: string): readonly string[] {
  /** Duplicates are harmless semantically and collapsed for stable diagnostics. */
  const candidates = new Set<string>();
  /**
   * Adds a token only when it can denote a local path under the Skill root.
   * @param raw - Candidate token extracted from Markdown syntax.
   * @param conventionalOnly - Whether inline code must look like a support-file path.
   */
  const consider = (raw: string, conventionalOnly: boolean): void => {
    /** Markdown angle brackets and fragments do not belong to logical file identity. */
    const target = raw.replace(/^<|>$/gu, '').split('#', 1)[0] as string;
    if (target.length === 0 || target.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) return;
    if (target.includes('{') || target.includes('}') || /\s/u.test(target)) return;
    if (
      conventionalOnly &&
      !/^(?:\.\.\/|\.\/|scripts\/|references\/|assets\/)/u.test(target) &&
      !/\.(?:md|mdx|txt|json|ya?ml|toml|csv|ts|tsx|js|jsx|mjs|cjs|sh|py|go|rs|sql|html|css)$/iu.test(target)
    ) {
      return;
    }
    candidates.add(target);
  };
  /** Markdown inline links are always meaningful local candidates when not URLs. */
  for (const match of text.matchAll(MARKDOWN_LINK)) consider(match[1] as string, false);
  /** Reference definitions receive the same containment rules as inline links. */
  for (const match of text.matchAll(MARKDOWN_REFERENCE)) consider(match[1] as string, false);
  /** Inline code admits conventional directories and clearly file-shaped support references. */
  for (const match of text.matchAll(INLINE_CODE)) consider(match[1] as string, true);
  /** Bare conventional paths cover common Agent Skills authoring style. */
  for (const match of text.matchAll(CONVENTIONAL_PATH)) consider(match[1] as string, false);
  return Object.freeze([...candidates]);
}

/**
 * Proves every local Markdown reference resolves to a captured regular file.
 * @param acquired - Complete directory files before immutable publication.
 * @param directories - Canonical directories observed during source acquisition.
 */
function validateContainedReferences(
  acquired: readonly AcquiredSkillFile[],
  directories: readonly LogicalPath[] = [],
): void {
  /** Set enables exact existence checks after path normalization. */
  const paths = new Set(acquired.map((file) => file.path));
  /** Directory membership distinguishes a non-regular target from a missing target. */
  const directoryPaths = new Set(directories);
  /** All Markdown sources can introduce references, not only root instructions. */
  for (const file of acquired) {
    if (!file.path.toLowerCase().endsWith('.md')) continue;
    /** Every Markdown file is strict UTF-8 before references can affect disclosure. */
    const source = UTF8_DECODER.decode(file.content);
    /** Every extracted candidate must resolve to captured immutable content. */
    for (const candidate of localReferenceCandidates(source)) {
      if (candidate.startsWith('/') || candidate.includes('\\')) {
        throw new ResourcesError('skill_reference_invalid', 'Skill reference must be a relative slash path', {
          details: { source: file.path, target: candidate },
        });
      }
      /** References in supporting Markdown resolve relative to that file's directory. */
      const sourceDirectory = posix.dirname(file.path);
      /** POSIX normalization is independent of host path behavior. */
      const resolved = posix.normalize(posix.join(sourceDirectory === '.' ? '' : sourceDirectory, candidate));
      if (resolved === '..' || resolved.startsWith('../')) {
        throw new ResourcesError('skill_reference_escapes_root', 'Skill reference escapes the Skill directory', {
          details: { source: file.path, target: candidate },
        });
      }
      /** Logical admission also catches dot segments and reserved Archer paths. */
      let path: LogicalPath;
      try {
        path = LogicalPathSchema.parse(resolved);
      } catch (cause) {
        throw new ResourcesError('skill_reference_invalid', 'Skill reference is not a valid local path', {
          cause,
          details: { source: file.path, target: candidate },
        });
      }
      if (directoryPaths.has(path)) {
        throw new ResourcesError('skill_reference_not_regular', 'Skill reference must name a regular file', {
          details: { source: file.path, target: path },
        });
      }
      if (!paths.has(path)) {
        throw new ResourcesError('skill_reference_missing', 'Skill reference does not name a captured file', {
          details: { source: file.path, target: path },
        });
      }
    }
  }
}

/** Immutable Skill revision owning progressive disclosure over verified content. */
export class Skill implements ResourceRevision<'skill', SkillId, SkillRevisionId> {
  /** Stable logical Skill identity. */
  readonly id: SkillId;

  /** Stable wire discriminator. */
  readonly object = 'skill' as const;

  /** Narrows the Wave 6 Resource family. */
  readonly resource = 'skill' as const;

  /** First creation instant shared by all revisions. */
  readonly createdAt: SkillDto['createdAt'];

  /** Manifest-derived name; callers cannot contradict `SKILL.md`. */
  readonly name: string;

  /** Exact immutable revision identity. */
  readonly revisionId: SkillRevisionId;

  /** One-based revision sequence. */
  readonly revision: number;

  /** Exact parent revision when behavior earned a child. */
  readonly previousRevisionId?: SkillRevisionId;

  /** Instant this exact revision was created. */
  readonly updatedAt: SkillDto['updatedAt'];

  /** Validated current Agent Skills manifest. */
  readonly manifest: SkillManifest;

  /** Complete immutable directory snapshot retained by the caller's FileStore. */
  readonly tree: ImmutableTree;

  /** Canonical supporting-file catalogue for explicit disclosure. */
  readonly paths: readonly LogicalPath[];

  /** Deterministic identity over manifest and complete directory tree. */
  readonly contentDigest: Sha256Digest;

  /** Complete instructions retained privately so callers cannot rewrite behavior. */
  readonly #instructions: string;

  /**
   * Installs already-validated Skill state; ordinary callers use directory import.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param manifest - Validated current Agent Skills metadata.
   * @param instructions - Root Markdown body without front matter.
   * @param tree - Published complete immutable snapshot.
   */
  protected constructor(
    token: typeof SKILL_CONSTRUCTION,
    identity: RevisionIdentity<'skill', SkillId, SkillRevisionId>,
    manifest: SkillManifest,
    instructions: string,
    tree: ImmutableTree,
  ) {
    if (token !== SKILL_CONSTRUCTION) throw new TypeError('Use importSkillDirectory to construct a Skill');
    this.id = identity.id;
    this.createdAt = identity.createdAt;
    this.name = identity.name;
    this.revisionId = identity.revisionId;
    this.revision = identity.revision;
    if (identity.previousRevisionId !== undefined) this.previousRevisionId = identity.previousRevisionId;
    this.updatedAt = identity.updatedAt;
    this.manifest = manifest;
    this.#instructions = instructions;
    this.tree = Object.freeze({ ref: tree.ref, files: Object.freeze([...tree.files]) });
    /** The immutable tree is the sole support-content catalogue retained by Skill behavior. */
    this.paths = Object.freeze(tree.files.map((file) => file.path).sort());
    this.contentDigest = resourceDigest('archer.skill.v1', {
      manifest: this.manifest,
      tree: this.tree.ref,
      paths: this.paths,
    });
    /** Provenance is recorded only after content, identity, and contentDigest agree. */
    ADMITTED_SKILLS.add(this);
    Object.freeze(this);
  }

  /**
   * Returns the concise manifest projection safe for progressive discovery.
   * @returns Name and description without full instructions or supporting bytes.
   */
  summary(): SkillSummary {
    if (!ADMITTED_SKILLS.has(this)) {
      throw new ResourcesError('resources_invalid_skill', 'Skill summary requires admitted behavior');
    }
    return Object.freeze({
      ref: skillRef(this),
      name: this.manifest.name,
      description: this.manifest.description,
    });
  }

  /**
   * Explicitly discloses complete instructions without activating the Skill.
   * @returns Immutable string body from the captured root document.
   */
  instructions(): string {
    if (!ADMITTED_SKILLS.has(this)) {
      throw new ResourcesError('resources_invalid_skill', 'Skill instructions require admitted behavior');
    }
    return this.#instructions;
  }

  /**
   * Emits JSON-safe exact state for an API, database, or asynchronous update boundary.
   * @returns Frozen DTO carrying tree identity but no in-memory file content.
   */
  toJSON(): SkillDto {
    if (!ADMITTED_SKILLS.has(this)) {
      throw new ResourcesError('resources_invalid_skill', 'Skill serialization requires admitted behavior');
    }
    return Object.freeze({
      id: this.id,
      object: this.object,
      resource: this.resource,
      createdAt: this.createdAt,
      name: this.name,
      revisionId: this.revisionId,
      revision: this.revision,
      ...(this.previousRevisionId === undefined ? {} : { previousRevisionId: this.previousRevisionId }),
      updatedAt: this.updatedAt,
      manifest: this.manifest,
      tree: this.tree.ref,
      paths: this.paths,
      contentDigest: this.contentDigest,
    });
  }
}

/** Package-local concrete Skill keeps the public class non-constructible in TypeScript. */
class InstalledSkill extends Skill {
  /**
   * Delegates admitted state to Skill's runtime-token-checked constructor.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param manifest - Validated current Agent Skills metadata.
   * @param instructions - Root Markdown body without front matter.
   * @param tree - Published complete immutable snapshot.
   */
  constructor(
    token: typeof SKILL_CONSTRUCTION,
    identity: RevisionIdentity<'skill', SkillId, SkillRevisionId>,
    manifest: SkillManifest,
    instructions: string,
    tree: ImmutableTree,
  ) {
    super(token, identity, manifest, instructions, tree);
  }
}

/**
 * Imports, validates, and snapshots one initial or child Agent Skills directory.
 * @param input - Host directory and borrowed immutable-file destination.
 * @param dependencies - Borrowed immutable files and optional initial facts.
 * @param previous - Exact admitted parent for a child reimport.
 * @param revisionContext - Required child identity and trusted observed time.
 * @returns Behavior-bearing Skill or exact acquisition/specification/publication failure.
 */
async function importSkillDirectoryRevision(
  input: ImportSkillDirectoryInput,
  dependencies: SkillImportDependencies,
  previous?: Skill,
  revisionContext?: SkillRevisionContext,
): Promise<ResultValue<Skill, ResourcesError>> {
  try {
    if (previous !== undefined && !ADMITTED_SKILLS.has(previous)) {
      return Result.error(
        new ResourcesError('resources_skill_transition_refused', 'Skill reimport requires the exact admitted parent'),
      );
    }
    if (previous !== undefined && revisionContext === undefined) {
      return Result.error(
        new ResourcesError('resources_skill_transition_refused', 'Skill reimport requires explicit child facts'),
      );
    }
    /** Child facts are pure preconditions and must fail before any host acquisition or publication. */
    let childIdentity: RevisionIdentity<'skill', SkillId, SkillRevisionId> | undefined;
    if (previous !== undefined && revisionContext !== undefined) {
      try {
        childIdentity = createRevisionIdentity('skill', previous.name, previous, revisionContext);
      } catch (cause) {
        return Result.error(
          new ResourcesError('resources_skill_transition_refused', 'Skill reimport requires valid child facts', {
            cause,
          }),
        );
      }
    }
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
    const acquired: AcquiredSkillFile[] = [];
    /** Directory catalogue preserves exact non-regular reference diagnostics. */
    const directories: LogicalPath[] = [];
    /** Canonical root anchors containment for every recursively acquired directory. */
    const resolvedRoot = await realpath(input.directory);
    await acquireDirectory(input.directory, '', acquired, directories, resolvedRoot);
    /** Root document is mandatory and selected by exact conventional name. */
    const root = acquired.find((file) => file.path === 'SKILL.md');
    if (root === undefined) {
      return Result.error(new ResourcesError('skill_manifest_missing', 'Skill directory must contain root SKILL.md'));
    }
    /** Strict decode and specification validation derive all Resource metadata. */
    let rootText: string;
    try {
      rootText = UTF8_DECODER.decode(root.content);
    } catch (cause) {
      return Result.error(new ResourcesError('skill_manifest_invalid_utf8', 'SKILL.md is not valid UTF-8', { cause }));
    }
    /** Derives manifest identity from the required root document and containing directory. */
    const document = parseSkillDocument(rootText, basename(input.directory));
    /** Every supporting reference must resolve inside the complete acquired snapshot. */
    validateContainedReferences(acquired, directories);
    if (previous !== undefined && previous.name !== document.manifest.name) {
      return Result.error(
        new ResourcesError('resources_skill_transition_refused', 'A Skill revision cannot change its name'),
      );
    }
    /** Reusable immutable sources drive both isolated planning and eventual caller publication. */
    const sources = acquired.map((file) => ({ path: file.path, content: file.content, mode: file.mode }));
    /** Isolated memory publication derives canonical tree identity without touching caller state. */
    const staging = memoryFileStore();
    /** Candidate identity is retained outside cleanup so no staging capability can escape. */
    let candidate: Awaited<ReturnType<typeof publishTree>>;
    try {
      /** Candidate identity must settle before a no-change transition can be refused safely. */
      candidate = await publishTree(staging, sources);
    } finally {
      await staging.close();
    }
    if (!candidate.ok) {
      return Result.error(
        new ResourcesError('resources_skill_import_failed', 'Skill snapshot planning failed', {
          cause: candidate.error,
        }),
      );
    }
    if (previous !== undefined) {
      /** Unchanged content does not invent a new durable revision. */
      if (
        JSON.stringify(previous.tree.ref) === JSON.stringify(candidate.value.ref) &&
        JSON.stringify(previous.manifest) === JSON.stringify(document.manifest)
      ) {
        return Result.error(
          new ResourcesError('resources_skill_transition_refused', 'A Skill revision must change directory content'),
        );
      }
    }
    /** Caller publication begins only after every validation and transition refusal has settled. */
    const published = await publishTree(dependencies.files, sources);
    if (!published.ok) {
      return Result.error(
        new ResourcesError('resources_skill_import_failed', 'Skill snapshot publication failed', {
          cause: published.error,
        }),
      );
    }
    /** Initial or child identity follows validation and successful immutable publication. */
    const identity =
      previous === undefined
        ? createInitialRevisionIdentity('skill', document.manifest.name, initialResourceContext(dependencies.context))
        : (childIdentity as RevisionIdentity<'skill', SkillId, SkillRevisionId>);
    return Result.ok(
      new InstalledSkill(SKILL_CONSTRUCTION, identity, document.manifest, document.instructions, published.value),
    );
  } catch (cause) {
    if (cause instanceof ResourcesError) return Result.error(cause);
    return Result.error(new ResourcesError('resources_invalid_skill', 'Invalid Agent Skill directory', { cause }));
  }
}

/**
 * Imports, validates, and snapshots one real Agent Skills directory.
 * @param input - Stable host directory acquired by the Node source adapter.
 * @param dependencies - Borrowed immutable files and optional deterministic facts.
 * @returns Initial behavior-bearing Skill or exact import refusal.
 */
export function importSkillDirectory(
  input: ImportSkillDirectoryInput,
  dependencies: SkillImportDependencies,
): Promise<ResultValue<Skill, ResourcesError>> {
  return importSkillDirectoryRevision(input, dependencies);
}

/**
 * Reimports changed directory content as one exact child Skill revision.
 * @param parent - Exact admitted parent Skill.
 * @param input - Stable host directory acquired by the Node source adapter.
 * @param dependencies - Borrowed immutable files and explicit child facts.
 * @returns Child Skill or exact no-change/source/transition refusal.
 */
export function reimportSkillDirectory(
  parent: Skill,
  input: ImportSkillDirectoryInput,
  dependencies: Omit<SkillImportDependencies, 'context'> &
    Readonly<{
      /** Supplies fresh child identity and trusted time only after reimport acquisition succeeds. */
      context: SkillRevisionContext;
    }>,
): Promise<ResultValue<Skill, ResourcesError>> {
  return importSkillDirectoryRevision(input, { files: dependencies.files }, parent, dependencies.context);
}

/**
 * Projects discovery metadata without loading full Skill instructions.
 * @param skill - Exact behavior-bearing Skill revision.
 * @returns Manifest-derived summary bound to the exact Skill ref.
 */
export function skillSummary(skill: Skill): SkillSummary {
  return skill.summary();
}

/**
 * Discloses full validated Skill instructions without changing profile activation.
 * @param skill - Exact behavior-bearing Skill revision.
 * @returns Immutable instruction content bound to the exact Skill ref.
 */
export function loadSkillInstructions(skill: Skill): ResultValue<LoadedSkillInstructions, ResourcesError> {
  try {
    return Result.ok(Object.freeze({ ref: skillRef(skill), content: skill.instructions() }));
  } catch (cause) {
    /** Preserves exact Skill refusals while bounding unexpected host failures uniformly. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('resources_invalid_skill', 'Skill instructions are unavailable', { cause });
    return Result.error(error);
  }
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
  if (!ADMITTED_SKILLS.has(skill)) {
    return Result.error(new ResourcesError('resources_invalid_skill', 'Skill support requires admitted behavior'));
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
  return Result.ok(Object.freeze({ ref: skillRef(skill), path, content: Uint8Array.from(loaded.value) }));
}

/**
 * Reconstructs a Skill after an explicit hydration adapter restores exact content.
 * @param dto - Transport-validated exact Skill state.
 * @param tree - Verified complete immutable tree matching the DTO reference.
 * @param content - Independently copied exact bytes keyed by canonical path.
 * @returns Behavior-bearing Skill with persisted identity and revision.
 * @internal
 */
export function hydrateSkillState(
  dto: SkillDto,
  tree: ImmutableTree,
  content: ReadonlyMap<LogicalPath, Uint8Array>,
): Skill {
  /** Root bytes re-earn current Agent Skills manifest and instruction behavior. */
  const root = content.get(LogicalPathSchema.parse('SKILL.md'));
  if (root === undefined) throw new ResourcesError('resources_hydration_failed', 'Skill DTO tree lacks SKILL.md');
  /** Root parsing re-establishes manifest and instruction behavior from bytes. */
  const document = parseSkillDocument(UTF8_DECODER.decode(root), dto.manifest.name);
  /** Reference safety is re-proven from restored bytes, not trusted from the DTO. */
  const acquired = tree.files.map((file) => {
    /** Every tree entry must have bytes before reference validation can run. */
    const bytes = content.get(file.path);
    if (bytes === undefined) {
      throw new ResourcesError('resources_hydration_failed', 'Skill DTO tree content is incomplete', {
        details: { path: file.path },
      });
    }
    return Object.freeze({ path: file.path, content: bytes, mode: file.mode });
  });
  validateContainedReferences(acquired);
  /** Transport DTO fields form exact existing identity rather than earning a new revision. */
  const identity: RevisionIdentity<'skill', SkillId, SkillRevisionId> = Object.freeze({
    object: dto.object,
    id: dto.id,
    revisionId: dto.revisionId,
    revision: dto.revision,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...(dto.previousRevisionId === undefined ? {} : { previousRevisionId: dto.previousRevisionId }),
    name: dto.name,
  });
  /** Behavior is installed only after complete content and references prove valid. */
  const skill = new InstalledSkill(SKILL_CONSTRUCTION, identity, document.manifest, document.instructions, tree);
  if (skill.contentDigest !== dto.contentDigest || JSON.stringify(skill.manifest) !== JSON.stringify(dto.manifest)) {
    throw new ResourcesError('resources_hydration_failed', 'Skill DTO does not match restored behavior');
  }
  return skill;
}
