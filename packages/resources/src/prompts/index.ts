/**
 * @file Owns immutable Prompt templates, exact rendering, and deterministic composition.
 *
 * Prompt behavior is pure after optional source acquisition. Transport parsing
 * never creates contribution provenance, and AgentProfile order is the only
 * composition order.
 */

import * as z from 'zod';

import { Result, type Result as ResultValue, type Sha256Digest, type Timestamp, type UuidV4 } from '@archer/core';
import { FileMode, publishTree, type FileStore, type LogicalPath, type TreeRef } from '@archer/files';
import type { ModelMessage } from '@archer/models';

import {
  createInitialRevisionIdentity,
  createRevisionIdentity,
  initialResourceContext,
  resourceDigest,
  resourcePetname,
  type ResourceCreationContext,
  type ResourceRevision,
  type ResourceRevisionContext,
  type RevisionIdentity,
} from '../common.js';
import { ResourcesError } from '../errors.js';

/** Prevents unrelated UUIDs from naming a Prompt. */
declare const promptIdBrand: unique symbol;

/** Stable identity shared by every immutable revision of one Prompt. */
export type PromptId = UuidV4 & {
  /** Carries compile-time evidence of Prompt identity admission. */
  readonly [promptIdBrand]: true;
};

/** Prevents a Prompt identity from posing as one exact Prompt revision. */
declare const promptRevisionIdBrand: unique symbol;

/** Identity of one exact immutable Prompt revision. */
export type PromptRevisionId = UuidV4 & {
  /** Carries compile-time evidence of Prompt revision identity admission. */
  readonly [promptRevisionIdBrand]: true;
};

/** Exact initial Prompt facts accepted by deterministic application boundaries. */
export type PromptCreationContext = ResourceCreationContext<PromptId, PromptRevisionId>;

/** Exact child facts required by pure Prompt revision behavior. */
export type PromptRevisionContext = ResourceRevisionContext<PromptRevisionId>;

/** Model request locations supported by Wave 6 Prompt composition. */
export type PromptPlacement = 'system' | 'user';

/** One immutable source snapshot retained by an imported Prompt. */
export type PromptSourceRef = Readonly<{
  /** Identifies the exact one-file immutable tree. */
  tree: TreeRef;

  /** Identifies the logical file inside the immutable tree. */
  path: LogicalPath;
}>;

/** Portable exact reference retained by AgentProfile selections and contributions. */
export type PromptRef = Readonly<{
  /** Narrows the Wave 6 Resource family. */
  resource: 'prompt';

  /** Stable logical Prompt identity. */
  id: PromptId;

  /** Exact selected immutable revision. */
  revisionId: PromptRevisionId;

  /** Human-facing Prompt name useful in diagnostics. */
  name: string;

  /** Content identity excludes lifecycle, ancestry, and display metadata. */
  contentDigest: Sha256Digest;
}>;

/** Input accepted by pure Prompt definition. */
export type DefinePromptInput = Readonly<{
  /** Optional display label; Archer generates a four-part petname when omitted. */
  name?: string;

  /** Selects whether rendered text becomes an instruction or user message. */
  placement: PromptPlacement;

  /** Text using the exact `{{identifier}}` placeholder grammar. */
  template: string;

  /** Exact variables in deterministic missing-value order; inferred when omitted. */
  variables?: readonly string[];
}>;

/** Fields a Prompt revision may replace while preserving logical identity. */
export type RevisePromptInput = Readonly<Partial<DefinePromptInput>>;

/** JSON-safe Prompt state emitted at transport boundaries. */
export type PromptDto = ResourceRevision<'prompt', PromptId, PromptRevisionId> &
  Readonly<{
    /** Narrows the Wave 6 Resource family. */
    resource: 'prompt';

    /** Model request placement owned by this Prompt. */
    placement: PromptPlacement;

    /** Exact source text retained by the behavior owner. */
    template: string;

    /** Exact accepted input names in declared order. */
    variables: readonly string[];

    /** Optional immutable source evidence for imported Prompt files. */
    source?: PromptSourceRef;
  }>;

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

  /** Supplies deterministic initial identity and time when needed. */
  context?: PromptCreationContext;
}>;

/** Prevents arbitrary objects from claiming Prompt-owned rendering provenance. */
declare const promptContributionBrand: unique symbol;

/** Opaque rendered result accepted by deterministic Prompt composition. */
export type PromptContribution = Readonly<{
  /** Placement inherited from the behavior-bearing Prompt. */
  placement: PromptPlacement;

  /** Complete rendered text after exact input admission. */
  content: string;

  /** Exact Prompt revision whose behavior produced the content. */
  source: PromptRef;

  /** Compile-time proof available only from Prompt behavior. */
  readonly [promptContributionBrand]: true;
}>;

/** Input accepted by deterministic Prompt composition. */
export type ComposePromptContributionsInput = Readonly<{
  /** Contributions already ordered by AgentProfile selection. */
  contributions: readonly PromptContribution[];

  /** Acknowledged conversation preserved before current user context. */
  history: readonly ModelMessage[];

  /** Current user request appended after user-placed Prompt contributions. */
  userMessage: string;
}>;

/** Request parts derived from verified Prompt contributions. */
export type ComposedPrompt = Readonly<{
  /** System-placed contributions in exact AgentProfile order. */
  instructions: readonly string[];

  /** History, user contributions, then the current user request. */
  messages: readonly ModelMessage[];

  /** Ordered exact Prompt refs used to derive these request parts. */
  sources: readonly PromptRef[];
}>;

/** Admits JavaScript-safe Prompt variable names. */
const VariableNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u);

/** Runtime-only token prevents ordinary callers from invoking the class constructor. */
const PROMPT_CONSTRUCTION = Symbol('archer.prompt.construction');

/** Runtime provenance rejects JavaScript casts and structural PromptContribution literals. */
const RENDERED_PROMPT_CONTRIBUTIONS = new WeakSet<object>();

/** Runtime provenance distinguishes behavior-bearing Prompts from DTO copies and casts. */
const ADMITTED_PROMPTS = new WeakSet<object>();

/** One literal or variable segment produced by the finite template parser. */
type PromptSegment =
  | Readonly<{
      /** Identifies literal source text. */
      type: 'literal';

      /** Text copied verbatim into every render. */
      text: string;
    }>
  | Readonly<{
      /** Identifies one declared replacement. */
      type: 'variable';

      /** Exact lookup key admitted by the variable grammar. */
      name: string;
    }>;

/** Complete admitted Prompt behavior after template-contract reconciliation. */
type AdmittedPromptDefinition = Readonly<{
  /** Human-facing reusable name. */
  name?: string;

  /** Model request placement. */
  placement: PromptPlacement;

  /** Exact retained template source. */
  template: string;

  /** Exact declared-variable order. */
  variables: readonly string[];

  /** Parsed immutable segments used for pure rendering. */
  segments: readonly PromptSegment[];
}>;

/** Internal state retained for each admitted immutable Prompt. */
type PromptBehaviorState = Readonly<{
  /** Exact source template needed for DTO encoding and revision. */
  template: string;

  /** Parsed immutable segments used for pure rendering. */
  segments: readonly PromptSegment[];

  /** Optional immutable source evidence from file import. */
  source?: PromptSourceRef;
}>;

/** Private behavior state prevents structural copies from gaining render authority. */
const PROMPT_BEHAVIOR = new WeakMap<Prompt, PromptBehaviorState>();

/** Runtime boundary for Prompt definition fields before behavior is installed. */
const PromptDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(256).optional(),
  placement: z.enum(['system', 'user']),
  template: z.string().min(1).max(256_000),
  variables: z.array(VariableNameSchema).max(128).optional(),
});

/**
 * Parses the exact Wave 6 template grammar without evaluating expressions.
 * @param template - Proposed source text.
 * @returns Immutable segments and variable names in first-appearance order.
 */
function parseTemplate(template: string): Readonly<{
  /** Parsed rendering segments. */
  segments: readonly PromptSegment[];

  /** Unique placeholder names in first-appearance order. */
  variables: readonly string[];
}> {
  /** Mutable segments remain private until the complete grammar succeeds. */
  const segments: PromptSegment[] = [];
  /** First appearance controls inferred and missing-value order. */
  const variables: string[] = [];
  /** Set avoids repeating a declared variable while permitting repeated placeholders. */
  const seen = new Set<string>();
  /** Literal text is accumulated to avoid one segment per character. */
  let literal = '';

  /** Publishes one immutable literal segment when the accumulator is non-empty. */
  const flushLiteral = (): void => {
    if (literal.length === 0) return;
    segments.push(Object.freeze({ type: 'literal', text: literal }));
    literal = '';
  };

  /** Cursor advances only through grammar-recognized source. */
  let cursor = 0;
  while (cursor < template.length) {
    if (template.startsWith('{{{{', cursor)) {
      literal += '{{';
      cursor += 4;
      continue;
    }
    if (template.startsWith('}}}}', cursor)) {
      literal += '}}';
      cursor += 4;
      continue;
    }
    if (template.startsWith('{{', cursor)) {
      flushLiteral();
      /** The next close delimiter must terminate one exact identifier. */
      const close = template.indexOf('}}', cursor + 2);
      if (close < 0) {
        throw new ResourcesError('prompt_template_invalid', 'Prompt contains an unmatched opening delimiter');
      }
      /** Whitespace and expressions are deliberately outside the finite grammar. */
      const name = template.slice(cursor + 2, close);
      if (!VariableNameSchema.safeParse(name).success) {
        throw new ResourcesError('prompt_variable_invalid', 'Prompt placeholder is not a valid identifier', {
          details: { variable: name },
        });
      }
      segments.push(Object.freeze({ type: 'variable', name }));
      if (!seen.has(name)) {
        seen.add(name);
        variables.push(name);
      }
      cursor = close + 2;
      continue;
    }
    if (template.startsWith('}}', cursor)) {
      throw new ResourcesError('prompt_template_invalid', 'Prompt contains an unmatched closing delimiter');
    }
    literal += template[cursor] as string;
    cursor += 1;
  }
  flushLiteral();
  return Object.freeze({
    segments: Object.freeze(segments),
    variables: Object.freeze(variables),
  });
}

/**
 * Admits complete Prompt behavior for initial definition and child revision.
 * @param input - Proposed complete Prompt fields.
 * @returns Frozen definition whose declared and observed variables agree exactly.
 */
function admitPromptDefinition(input: DefinePromptInput): AdmittedPromptDefinition {
  /** Strict parsing rejects decorative fields such as numeric composition order. */
  const admitted = PromptDefinitionSchema.parse(input);
  /** Template parsing establishes syntax before declaration reconciliation. */
  const parsed = parseTemplate(admitted.template);
  /** Supplied declarations preserve caller order; inferred declarations preserve source order. */
  const variables = Object.freeze([...(admitted.variables ?? parsed.variables)]);
  if (new Set(variables).size !== variables.length) {
    throw new ResourcesError('prompt_variable_invalid', 'Prompt variable declarations must be unique');
  }
  /** Every placeholder requires a declaration. */
  const declared = new Set(variables);
  /** Finds the first source placeholder lacking a declaration so refusal remains deterministic. */
  const undeclared = parsed.variables.find((variable) => !declared.has(variable));
  if (undeclared !== undefined) {
    throw new ResourcesError('prompt_variable_undeclared', 'Prompt placeholder has no declared variable', {
      details: { variable: undeclared },
    });
  }
  /** Every declaration must participate in behavior. */
  const used = new Set(parsed.variables);
  /** Finds the first declaration unused by source so configuration cannot drift silently. */
  const unused = variables.find((variable) => !used.has(variable));
  if (unused !== undefined) {
    throw new ResourcesError('prompt_variable_unused', 'Prompt declares an unused variable', {
      details: { variable: unused },
    });
  }
  return Object.freeze({
    ...(admitted.name === undefined ? {} : { name: admitted.name }),
    placement: admitted.placement,
    template: admitted.template,
    variables,
    segments: parsed.segments,
  });
}

/**
 * Creates the exact portable reference used by profiles and rendered contributions.
 * @param prompt - Behavior-bearing Prompt whose identity is projected.
 * @returns Frozen reference without template content.
 */
export function promptRef(prompt: Prompt): PromptRef {
  if (!ADMITTED_PROMPTS.has(prompt)) {
    throw new ResourcesError('resources_invalid_prompt', 'Prompt reference requires behavior earned by this module');
  }
  return Object.freeze({
    resource: 'prompt',
    id: prompt.id,
    revisionId: prompt.revisionId,
    name: prompt.name,
    contentDigest: prompt.contentDigest,
  });
}

/** Immutable Prompt revision that owns exact template rendering behavior. */
export class Prompt implements ResourceRevision<'prompt', PromptId, PromptRevisionId> {
  /** Stable logical Prompt identity. */
  readonly id: PromptId;

  /** Stable wire discriminator. */
  readonly object = 'prompt' as const;

  /** Narrows the Wave 6 Resource family. */
  readonly resource = 'prompt' as const;

  /** First creation instant shared by all revisions. */
  readonly createdAt: Timestamp;

  /** Human-facing reusable name. */
  readonly name: string;

  /** Exact immutable revision identity. */
  readonly revisionId: PromptRevisionId;

  /** One-based revision sequence. */
  readonly revision: number;

  /** Exact parent revision when this is not the initial value. */
  readonly previousRevisionId?: PromptRevisionId;

  /** Instant this exact revision was created. */
  readonly updatedAt: Timestamp;

  /** Model request placement for rendered contributions. */
  readonly placement: PromptPlacement;

  /** Exact accepted template input names in declared order. */
  readonly variables: readonly string[];

  /** Deterministic identity over behavior content only. */
  readonly contentDigest: Sha256Digest;

  /**
   * Installs already-admitted Prompt state; ordinary callers use Prompt factories.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param definition - Parsed immutable Prompt behavior.
   * @param source - Optional immutable source evidence.
   */
  protected constructor(
    token: typeof PROMPT_CONSTRUCTION,
    identity: RevisionIdentity<'prompt', PromptId, PromptRevisionId>,
    definition: AdmittedPromptDefinition,
    source?: PromptSourceRef,
  ) {
    if (token !== PROMPT_CONSTRUCTION) throw new TypeError('Use a Prompt factory');
    this.id = identity.id;
    this.createdAt = identity.createdAt;
    this.name = identity.name;
    this.revisionId = identity.revisionId;
    this.revision = identity.revision;
    if (identity.previousRevisionId !== undefined) this.previousRevisionId = identity.previousRevisionId;
    this.updatedAt = identity.updatedAt;
    this.placement = definition.placement;
    this.variables = Object.freeze([...definition.variables]);
    /** Retains parsed segments privately so rendering never reparses or performs source I/O. */
    const behavior = Object.freeze({
      template: definition.template,
      segments: Object.freeze([...definition.segments]),
      ...(source === undefined ? {} : { source: Object.freeze({ ...source }) }),
    });
    PROMPT_BEHAVIOR.set(this, behavior);
    this.contentDigest = resourceDigest('archer.prompt.v1', {
      placement: this.placement,
      template: behavior.template,
      variables: this.variables,
      ...(behavior.source === undefined ? {} : { source: behavior.source }),
    });
    ADMITTED_PROMPTS.add(this);
    Object.freeze(this);
  }

  /**
   * Renders complete text only when values exactly match this Prompt's contract.
   * @param proposedValues - Caller-owned text values keyed by declared variable.
   * @returns Source-identified contribution or exact missing/extra refusal.
   */
  render(proposedValues: Readonly<Record<string, string>>): ResultValue<PromptContribution, ResourcesError> {
    if (!ADMITTED_PROMPTS.has(this)) {
      return Result.error(
        new ResourcesError('resources_invalid_prompt', 'Prompt rendering requires admitted behavior'),
      );
    }
    /** Copying enumerable input prevents later caller mutation from affecting validation. */
    const values = { ...proposedValues };
    /** Declared order controls deterministic missing evidence. */
    const missing = this.variables.filter((variable) => typeof values[variable] !== 'string');
    if (missing.length > 0) {
      return Result.error(
        new ResourcesError('prompt_parameter_missing', 'Prompt values are missing declared variables', {
          details: { variables: missing },
        }),
      );
    }
    /** ASCII lexical order controls deterministic extra evidence. */
    const declared = new Set(this.variables);
    /** Sorts undeclared caller keys so equivalent invalid input reports the same refusal. */
    const extra = Object.keys(values)
      .filter((variable) => !declared.has(variable))
      .sort();
    if (extra.length > 0) {
      return Result.error(
        new ResourcesError('prompt_parameter_extra', 'Prompt values contain undeclared variables', {
          details: { variables: extra },
        }),
      );
    }
    /** Behavior state exists only for the exact admitted object. */
    const behavior = PROMPT_BEHAVIOR.get(this);
    if (behavior === undefined) {
      return Result.error(new ResourcesError('resources_invalid_prompt', 'Prompt behavior is unavailable'));
    }
    /** Segment reduction inserts every value verbatim without provider-specific escaping. */
    const content = behavior.segments
      .map((segment) => (segment.type === 'literal' ? segment.text : (values[segment.name] as string)))
      .join('');
    /** Mints opaque contribution provenance only after exact rendering succeeds. */
    const contribution = Object.freeze({
      placement: this.placement,
      content,
      source: promptRef(this),
    }) as PromptContribution;
    RENDERED_PROMPT_CONTRIBUTIONS.add(contribution);
    return Result.ok(contribution);
  }

  /**
   * Earns one immutable child from explicit identity and time facts.
   * @param proposed - Partial fields inherited from this Prompt when omitted.
   * @param context - Fresh revision identity and trusted observed time.
   * @returns Child Prompt or exact invalid/no-change refusal.
   */
  revise(proposed: RevisePromptInput, context: PromptRevisionContext): ResultValue<Prompt, ResourcesError> {
    try {
      /** Exact behavior state is unavailable to copied or cast objects. */
      const behavior = PROMPT_BEHAVIOR.get(this);
      if (behavior === undefined) {
        return Result.error(
          new ResourcesError('resources_invalid_prompt', 'Prompt revision requires admitted behavior'),
        );
      }
      /** Revalidates the complete proposed behavior because partial revision input may alter invariants. */
      const admitted = admitPromptDefinition({
        name: proposed.name ?? this.name,
        placement: proposed.placement ?? this.placement,
        template: proposed.template ?? behavior.template,
        variables: proposed.variables ?? this.variables,
      });
      if (
        admitted.name === this.name &&
        admitted.placement === this.placement &&
        admitted.template === behavior.template &&
        admitted.variables.join('\0') === this.variables.join('\0')
      ) {
        return Result.error(
          new ResourcesError(
            'resources_prompt_transition_refused',
            'Prompt revision must change behavior or display metadata',
          ),
        );
      }
      /** Creates ancestry only after the revised Prompt passes every grammar and variable check. */
      const identity = createRevisionIdentity('prompt', admitted.name ?? this.name, this, context);
      return Result.ok(new InstalledPrompt(PROMPT_CONSTRUCTION, identity, admitted, behavior.source));
    } catch (cause) {
      /** Preserves exact Prompt refusals while bounding malformed revision facts uniformly. */
      const error =
        cause instanceof ResourcesError
          ? cause
          : new ResourcesError('resources_prompt_transition_refused', 'Invalid Prompt revision', { cause });
      return Result.error(error);
    }
  }

  /**
   * Emits JSON-safe exact state for an API, database, or asynchronous update boundary.
   * @returns Frozen DTO carrying source behavior but no methods.
   */
  toJSON(): PromptDto {
    /** Behavior state is the serialization authority for private template content. */
    const behavior = PROMPT_BEHAVIOR.get(this);
    if (behavior === undefined || !ADMITTED_PROMPTS.has(this)) {
      throw new ResourcesError('resources_invalid_prompt', 'Prompt serialization requires admitted behavior');
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
      placement: this.placement,
      template: behavior.template,
      variables: this.variables,
      ...(behavior.source === undefined ? {} : { source: behavior.source }),
      contentDigest: this.contentDigest,
    });
  }
}

/** Package-local concrete Prompt keeps the public class non-constructible in TypeScript. */
class InstalledPrompt extends Prompt {
  /**
   * Delegates admitted state to Prompt's runtime-token-checked constructor.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param definition - Parsed immutable Prompt behavior.
   * @param source - Optional immutable source evidence.
   */
  constructor(
    token: typeof PROMPT_CONSTRUCTION,
    identity: RevisionIdentity<'prompt', PromptId, PromptRevisionId>,
    definition: AdmittedPromptDefinition,
    source?: PromptSourceRef,
  ) {
    super(token, identity, definition, source);
  }
}

/**
 * Defines one behavior-bearing Prompt from already-acquired text.
 * @param input - Placement, source text, variables, and optional display label.
 * @param context - Optional deterministic initial identity and time.
 * @returns Immutable Prompt ready to render repeatedly.
 */
export function definePrompt(input: DefinePromptInput, context?: PromptCreationContext): Prompt {
  try {
    /** Admits template grammar and variable declarations before initial identity is created. */
    const admitted = admitPromptDefinition(input);
    /** Resolves initial identity and time after behavior validation prevents wasted partial state. */
    const facts = initialResourceContext(context);
    /** Uses the stable identity-derived petname only when the application omitted a label. */
    const name = admitted.name ?? resourcePetname(facts.id);
    /** Combines admitted behavior with one initial revision envelope. */
    const identity = createInitialRevisionIdentity('prompt', name, facts);
    return new InstalledPrompt(PROMPT_CONSTRUCTION, identity, admitted);
  } catch (cause) {
    if (cause instanceof ResourcesError) throw cause;
    throw new ResourcesError('resources_invalid_prompt', 'Invalid Prompt definition', { cause });
  }
}

/**
 * Imports, snapshots, validates, and constructs one Prompt source file.
 * @param input - Source locator and Prompt behavior metadata.
 * @param dependencies - Borrowed source, immutable files, and optional deterministic facts.
 * @returns Imported Prompt or one exact source/domain refusal.
 */
export async function importPromptFile(
  input: ImportPromptFileInput,
  dependencies: PromptImportDependencies,
): Promise<ResultValue<Prompt, ResourcesError>> {
  try {
    /** Acquires stable bytes before any Prompt parsing or immutable publication begins. */
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
    /** Immutable publication copies bytes and gives the Prompt portable source identity. */
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
    /** Validates decoded source text with the same grammar as in-memory Prompt definition. */
    const admitted = admitPromptDefinition({
      ...(input.name === undefined ? {} : { name: input.name }),
      placement: input.placement,
      template,
      ...(input.variables === undefined ? {} : { variables: input.variables }),
    });
    /** Resolves caller-supplied or local identity after external acquisition fully succeeds. */
    const facts = initialResourceContext(dependencies.context);
    /** Binds the immutable source snapshot to the same initial behavior identity. */
    const identity = createInitialRevisionIdentity('prompt', admitted.name ?? resourcePetname(facts.id), facts);
    return Result.ok(
      new InstalledPrompt(PROMPT_CONSTRUCTION, identity, admitted, {
        tree: published.value.ref,
        path: acquired.value.path,
      }),
    );
  } catch (cause) {
    /** Preserves exact source and Prompt errors while redacting unexpected importer failures. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('resources_prompt_import_failed', 'Prompt import failed', { cause });
    return Result.error(error);
  }
}

/**
 * Replaces placeholders without I/O and mints source-bound contribution evidence.
 * @param prompt - Exact behavior-bearing Prompt revision.
 * @param values - Exact declared variable values.
 * @returns Rendered contribution or exact parameter refusal.
 */
export function renderPrompt(
  prompt: Prompt,
  values: Readonly<Record<string, string>>,
): ResultValue<PromptContribution, ResourcesError> {
  return prompt.render(values);
}

/**
 * Earns one child Prompt revision from explicit facts.
 * @param parent - Exact behavior-bearing parent Prompt.
 * @param input - Partial replacement behavior.
 * @param context - Fresh revision identity and trusted observed time.
 * @returns Child Prompt or exact transition refusal.
 */
export function revisePrompt(
  parent: Prompt,
  input: RevisePromptInput,
  context: PromptRevisionContext,
): ResultValue<Prompt, ResourcesError> {
  return parent.revise(input, context);
}

/**
 * Composes verified contributions in caller-supplied AgentProfile order.
 * @param input - Ordered contributions, acknowledged history, and current user message.
 * @returns Complete request parts or exact contribution refusal.
 */
export function composePromptContributions(
  input: ComposePromptContributionsInput,
): ResultValue<ComposedPrompt, ResourcesError> {
  /** Copying the array preserves caller state while retaining exact object identities for provenance. */
  const contributions = [...input.contributions];
  /** Rejects structural contribution copies before composition can treat text as Prompt evidence. */
  const unverified = contributions.find((contribution) => !RENDERED_PROMPT_CONTRIBUTIONS.has(contribution));
  if (unverified !== undefined) {
    return Result.error(
      new ResourcesError(
        'prompt_contribution_unverified',
        'Prompt composition requires rendered contribution evidence',
        {
          details: { promptRevisionId: unverified.source?.revisionId ?? 'unknown' },
        },
      ),
    );
  }
  /** One exact Prompt revision may contribute at most once to one request. */
  const seen = new Set<PromptRevisionId>();
  /** Partitions verified contributions without changing their AgentProfile order. */
  for (const contribution of contributions) {
    if (seen.has(contribution.source.revisionId)) {
      return Result.error(
        new ResourcesError('prompt_duplicate_revision', 'Prompt composition received one revision more than once', {
          details: { promptRevisionId: contribution.source.revisionId },
        }),
      );
    }
    seen.add(contribution.source.revisionId);
  }
  /** System instructions and user messages each preserve the same profile order. */
  const instructions = Object.freeze(
    contributions
      .filter((contribution) => contribution.placement === 'system')
      .map((contribution) => contribution.content),
  );
  /** History is copied deeply enough for text-only immutable message values. */
  const history = input.history.map((message) => Object.freeze({ ...message }));
  /** User contributions immediately precede the current user request. */
  const current = contributions
    .filter((contribution) => contribution.placement === 'user')
    .map((contribution): ModelMessage => Object.freeze({ role: 'user', content: contribution.content }));
  /** Places user contributions between acknowledged history and the current message. */
  const messages = Object.freeze([
    ...history,
    ...current,
    Object.freeze({ role: 'user' as const, content: input.userMessage }),
  ]);
  return Result.ok(
    Object.freeze({
      instructions,
      messages,
      sources: Object.freeze(contributions.map((contribution) => contribution.source)),
    }),
  );
}

/**
 * Reconstructs Prompt behavior after transport and source adapters verify exact state.
 * @param dto - Transport-validated Prompt DTO.
 * @returns Behavior-bearing Prompt with persisted identity and source.
 * @internal
 */
export function hydratePromptState(dto: PromptDto): Prompt {
  /** Revalidates transported behavior content rather than trusting a matching digest alone. */
  const admitted = admitPromptDefinition({
    name: dto.name,
    placement: dto.placement,
    template: dto.template,
    variables: dto.variables,
  });
  /** Restores exact lineage metadata without generating replacement identity or time. */
  const identity: RevisionIdentity<'prompt', PromptId, PromptRevisionId> = Object.freeze({
    object: dto.object,
    id: dto.id,
    revisionId: dto.revisionId,
    revision: dto.revision,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...(dto.previousRevisionId === undefined ? {} : { previousRevisionId: dto.previousRevisionId }),
    name: dto.name,
  });
  /** Constructs behavior before comparing canonical content with transported evidence. */
  const prompt = new InstalledPrompt(PROMPT_CONSTRUCTION, identity, admitted, dto.source);
  if (prompt.contentDigest !== dto.contentDigest) {
    throw new ResourcesError('resources_hydration_failed', 'Prompt DTO content does not match its content digest');
  }
  return prompt;
}
