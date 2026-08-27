/** @file Owns Agent Skills conventions, progressive disclosure, and immutable revision behavior. */

import { posix } from 'node:path';

import * as z from 'zod';
import { parseDocument } from 'yaml';

import { Result, type Result as ResultValue, type Sha256Digest, type UuidV4 } from '@archer/core';
import { LogicalPathSchema, type ImmutableTree, type LogicalPath, type TreeRef } from '@archer/files';

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

/** Complete intrinsic Skill state used by projection and hydration boundaries. */
export type SkillState = ResourceRevision<'skill', SkillId, SkillRevisionId> &
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

/** Complete instruction disclosure returned by explicit Skill behavior. */
export type LoadedSkillInstructions = Readonly<{
  /** Exact Skill revision whose instructions are disclosed. */
  ref: SkillRef;

  /** Validated Markdown body beneath SKILL.md front matter. */
  content: string;
}>;

/** One complete in-memory regular file admitted before immutable publication. */
export type SkillSnapshotFile = Readonly<{
  /** Canonical slash-separated path relative to the Skill root. */
  path: LogicalPath;

  /** Copied exact bytes read from the host filesystem. */
  content: Uint8Array;

  /** Portable executable or readable intent derived from host mode bits. */
  mode: ImmutableTree['files'][number]['mode'];
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
  acquired: readonly SkillSnapshotFile[],
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
  readonly createdAt: SkillState['createdAt'];

  /** Manifest-derived name; callers cannot contradict `SKILL.md`. */
  readonly name: string;

  /** Exact immutable revision identity. */
  readonly revisionId: SkillRevisionId;

  /** One-based revision sequence. */
  readonly revision: number;

  /** Exact parent revision when behavior earned a child. */
  readonly previousRevisionId?: SkillRevisionId;

  /** Instant this exact revision was created. */
  readonly updatedAt: SkillState['updatedAt'];

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
}

/**
 * Projects intrinsic Skill state without exposing retained instructions or file bytes.
 * @param skill - Exact admitted Skill behavior.
 * @returns Frozen state naming the immutable tree and complete path catalogue.
 * @internal
 */
export function skillState(skill: Skill): SkillState {
  if (!ADMITTED_SKILLS.has(skill)) {
    throw new ResourcesError('resources_invalid_skill', 'Skill state projection requires admitted behavior');
  }
  return Object.freeze({
    id: skill.id,
    object: skill.object,
    resource: skill.resource,
    createdAt: skill.createdAt,
    name: skill.name,
    revisionId: skill.revisionId,
    revision: skill.revision,
    ...(skill.previousRevisionId === undefined ? {} : { previousRevisionId: skill.previousRevisionId }),
    updatedAt: skill.updatedAt,
    manifest: skill.manifest,
    tree: skill.tree.ref,
    paths: skill.paths,
    contentDigest: skill.contentDigest,
  });
}

/** Initial or child identity facts accepted by the pure Skill snapshot installer. */
export type InstallSkillSnapshotOperation =
  | Readonly<{
      /** Selects initial Skill construction. */
      kind: 'initial';

      /** Supplies exact initial identity and trusted time. */
      context: SkillCreationContext;
    }>
  | Readonly<{
      /** Selects one exact child revision. */
      kind: 'revision';

      /** Supplies the exact admitted parent. */
      parent: Skill;

      /** Supplies fresh child identity and trusted time. */
      context: SkillRevisionContext;
    }>;

/** Complete acquired snapshot submitted to Agent Skills domain admission. */
export type InstallSkillSnapshotInput = Readonly<{
  /** Physical directory basename used only for the Agent Skills name invariant. */
  directoryName: string;

  /** Detached regular files in deterministic logical-path order. */
  files: readonly SkillSnapshotFile[];

  /** Contained directories used to distinguish invalid non-regular references. */
  directories: readonly LogicalPath[];

  /** Immutable tree identity already planned from the exact detached files. */
  tree: ImmutableTree;
}>;

/**
 * Proves an initial or child Skill operation before a source adapter performs I/O.
 * @param operation - Proposed initial or exact child identity facts.
 * @throws {ResourcesError} When parent provenance or child identity is invalid.
 * @internal
 */
export function assertSkillSnapshotOperation(operation: InstallSkillSnapshotOperation): void {
  if (operation.kind !== 'revision') return;
  if (!ADMITTED_SKILLS.has(operation.parent)) {
    throw new ResourcesError('resources_skill_transition_refused', 'Skill reimport requires the exact admitted parent');
  }
  try {
    createRevisionIdentity('skill', operation.parent.name, operation.parent, operation.context);
  } catch (cause) {
    throw new ResourcesError('resources_skill_transition_refused', 'Skill reimport requires valid child facts', {
      cause,
    });
  }
}

/**
 * Installs behavior from a detached immutable Skill snapshot without source or storage I/O.
 * @param input - Complete acquired files, directory catalogue, and planned immutable tree.
 * @param operation - Explicit initial or child identity facts.
 * @returns Admitted Skill behavior or one exact convention or transition refusal.
 * @internal
 */
export function installSkillSnapshot(
  input: InstallSkillSnapshotInput,
  operation: InstallSkillSnapshotOperation,
): ResultValue<Skill, ResourcesError> {
  try {
    /** Reuses the same pre-effect operation proof at the final domain installation boundary. */
    assertSkillSnapshotOperation(operation);
    /** Child identity is admitted before content comparison can publish a replacement revision. */
    const childIdentity =
      operation.kind === 'revision'
        ? createRevisionIdentity('skill', operation.parent.name, operation.parent, operation.context)
        : undefined;
    /** Root document is mandatory and selected by exact conventional name. */
    const root = input.files.find((file) => file.path === 'SKILL.md');
    if (root === undefined) {
      return Result.error(new ResourcesError('skill_manifest_missing', 'Skill directory must contain root SKILL.md'));
    }
    /** Strict decoding keeps invalid source bytes outside Agent Skills semantics. */
    let rootText: string;
    try {
      rootText = UTF8_DECODER.decode(root.content);
    } catch (cause) {
      return Result.error(new ResourcesError('skill_manifest_invalid_utf8', 'SKILL.md is not valid UTF-8', { cause }));
    }
    /** Manifest parsing and instruction ownership remain independent of the host acquisition adapter. */
    const document = parseSkillDocument(rootText, input.directoryName);
    /** Every Markdown reference must resolve inside the detached complete snapshot. */
    validateContainedReferences(input.files, input.directories);
    if (operation.kind === 'revision' && operation.parent.name !== document.manifest.name) {
      return Result.error(
        new ResourcesError('resources_skill_transition_refused', 'A Skill revision cannot change its name'),
      );
    }
    if (
      operation.kind === 'revision' &&
      JSON.stringify(operation.parent.tree.ref) === JSON.stringify(input.tree.ref) &&
      JSON.stringify(operation.parent.manifest) === JSON.stringify(document.manifest)
    ) {
      return Result.error(
        new ResourcesError('resources_skill_transition_refused', 'A Skill revision must change directory content'),
      );
    }
    /** Initial and child identity both cross the same already-admitted behavior constructor. */
    const identity =
      operation.kind === 'initial'
        ? createInitialRevisionIdentity('skill', document.manifest.name, initialResourceContext(operation.context))
        : (childIdentity as RevisionIdentity<'skill', SkillId, SkillRevisionId>);
    return Result.ok(
      new InstalledSkill(SKILL_CONSTRUCTION, identity, document.manifest, document.instructions, input.tree),
    );
  } catch (cause) {
    /** Preserves exact Skill refusals while bounding malformed identity or snapshot state. */
    if (cause instanceof ResourcesError) return Result.error(cause);
    return Result.error(new ResourcesError('resources_invalid_skill', 'Invalid Agent Skill snapshot', { cause }));
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
 * Reconstructs a Skill after an explicit hydration adapter restores exact content.
 * @param state - Admitted intrinsic Skill state.
 * @param tree - Verified complete immutable tree matching the admitted state reference.
 * @param content - Independently copied exact bytes keyed by canonical path.
 * @returns Behavior-bearing Skill with persisted identity and revision.
 * @internal
 */
export function hydrateSkillState(
  state: SkillState,
  tree: ImmutableTree,
  content: ReadonlyMap<LogicalPath, Uint8Array>,
): Skill {
  /** Root bytes re-earn current Agent Skills manifest and instruction behavior. */
  const root = content.get(LogicalPathSchema.parse('SKILL.md'));
  if (root === undefined) throw new ResourcesError('resources_hydration_failed', 'Skill state tree lacks SKILL.md');
  /** Root parsing re-establishes manifest and instruction behavior from bytes. */
  const document = parseSkillDocument(UTF8_DECODER.decode(root), state.manifest.name);
  /** Reference safety is re-proven from restored bytes, not trusted from detached state. */
  const acquired = tree.files.map((file) => {
    /** Every tree entry must have bytes before reference validation can run. */
    const bytes = content.get(file.path);
    if (bytes === undefined) {
      throw new ResourcesError('resources_hydration_failed', 'Skill state tree content is incomplete', {
        details: { path: file.path },
      });
    }
    return Object.freeze({ path: file.path, content: bytes, mode: file.mode });
  });
  validateContainedReferences(acquired);
  /** Boundary-admitted state forms exact existing identity rather than earning a new revision. */
  const identity: RevisionIdentity<'skill', SkillId, SkillRevisionId> = Object.freeze({
    object: state.object,
    id: state.id,
    revisionId: state.revisionId,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.previousRevisionId === undefined ? {} : { previousRevisionId: state.previousRevisionId }),
    name: state.name,
  });
  /** Behavior is installed only after complete content and references prove valid. */
  const skill = new InstalledSkill(SKILL_CONSTRUCTION, identity, document.manifest, document.instructions, tree);
  if (
    skill.contentDigest !== state.contentDigest ||
    JSON.stringify(skill.manifest) !== JSON.stringify(state.manifest)
  ) {
    throw new ResourcesError('resources_hydration_failed', 'Skill state does not match restored behavior');
  }
  return skill;
}
