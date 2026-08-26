/** @file Reconstructs behavior only through explicit transport and capability boundaries. */

import { Result, type Result as ResultValue } from '@archer/core';
import { restoreTree, type FileStore, type LogicalPath } from '@archer/files';
import type { Model } from '@archer/models';

import { budgetPolicyRef, hydrateBudgetPolicyState, type BudgetPolicy } from '../budgets/index.js';
import {
  compileReviewedResourceSet,
  type ResourceRevocationDto,
  type VerifiedResourceAdmission,
} from '../control/index.js';
import { ResourcesError } from '../errors.js';
import {
  agentProfileRef,
  hydrateAgentProfileState,
  type AgentProfile,
  type SelectSkillInput,
} from '../profiles/index.js';
import { hydratePromptState, promptRef, type Prompt } from '../prompts/index.js';
import { hydrateSkillState, skillRef, type Skill } from '../skills/index.js';
import { AgentProfileCodec, BudgetPolicyCodec, PromptCodec, ResourceSetCodec, SkillCodec } from '../transport/index.js';
import { compileResourceSetFromProfile, type ResourceSet, type ResourceSetDto } from '../session.js';

/** Minimal immutable revision fields required to verify one hydration parent. */
type HydratedRevision = Readonly<{
  /** Stable logical identity shared across revisions. */
  id: string;
  /** Exact revision identity. */
  revisionId: string;
  /** One-based revision sequence. */
  revision: number;
  /** Optional exact parent identity. */
  previousRevisionId?: string;
  /** First creation instant preserved by children. */
  createdAt: string;
  /** Instant this exact revision was earned. */
  updatedAt: string;
}>;

/** Input required to hydrate Prompt behavior with optional exact parent evidence. */
export type HydratePromptInput = Readonly<{
  /** Untrusted persisted or transported Prompt DTO. */
  dto: unknown;
  /** Required exact parent when the DTO describes a child revision. */
  parent?: Prompt;

  /** Immutable content store required when the DTO retains imported source evidence. */
  files?: FileStore;
}>;

/** Input required to hydrate BudgetPolicy behavior with optional exact parent evidence. */
export type HydrateBudgetPolicyInput = Readonly<{
  /** Untrusted persisted or transported BudgetPolicy DTO. */
  dto: unknown;
  /** Required exact parent when the DTO describes a child revision. */
  parent?: BudgetPolicy;
}>;

/** Capabilities required to reconnect a Skill DTO with exact immutable content. */
export type HydrateSkillInput = Readonly<{
  /** Untrusted persisted or transported Skill DTO. */
  dto: unknown;

  /** Borrowed immutable store containing the DTO's exact tree and blobs. */
  files: FileStore;

  /** Required exact parent when the DTO describes a child revision. */
  parent?: Skill;
}>;

/** Exact hydrated Resources required to reconnect AgentProfile references. */
export type HydrateAgentProfileInput = Readonly<{
  /** Untrusted persisted or transported AgentProfile DTO. */
  dto: unknown;

  /** Hydrated model configuration matching the selected exact reference. */
  model: Model;

  /** Hydrated Prompts in the profile's selected order. */
  prompts: readonly Prompt[];

  /** Hydrated Skills with the profile's selected activation state. */
  skills: readonly SelectSkillInput[];

  /** Hydrated BudgetPolicy matching the selected exact reference. */
  budget: BudgetPolicy;

  /** Required exact parent when the DTO describes a child revision. */
  parent?: AgentProfile;
}>;

/** Application-owned authentication for one restored local-policy receipt. */
export type HydrateLocalResourceSetAdmission = Readonly<{
  /** Selects local application admission rather than reviewed control facts. */
  mode: 'local';

  /** Authenticates that this application previously admitted the exact receipt. */
  authenticate(receipt: ResourceSetDto): boolean | Promise<boolean>;
}>;

/** Already-verified lifecycle evidence used to restore reviewed compilation. */
export type HydrateReviewedResourceSetAdmission = Readonly<{
  /** Selects independent reviewed admission. */
  mode: 'reviewed';

  /** Opaque exact admissions restored or earned through the control owner. */
  admissions: readonly VerifiedResourceAdmission[];

  /** Current revocations visible at the restoring boundary. */
  revocations?: readonly ResourceRevocationDto[];
}>;

/** Exact behavior and admission capabilities required to restore one ResourceSet. */
export type HydrateResourceSetInput = Readonly<{
  /** Untrusted persisted or transported ResourceSet receipt. */
  dto: unknown;

  /** Exact hydrated AgentProfile retaining every selected behavior owner. */
  profile: AgentProfile;

  /** Explicit local authentication or verified reviewed evidence. */
  admission: HydrateLocalResourceSetAdmission | HydrateReviewedResourceSetAdmission;
}>;

/**
 * Refuses orphaned, skipped, rewritten, or time-reversing revision histories.
 * @param revision - Transport-validated revision being hydrated.
 * @param parent - Exact behavior-bearing parent supplied by the application.
 * @param initialRevision - Domain-specific initial revision, zero for AgentProfile and one for Resources.
 */
function assertHydrationParent(
  revision: HydratedRevision,
  parent: HydratedRevision | undefined,
  initialRevision = 1,
): void {
  if (revision.revision === initialRevision) {
    if (parent !== undefined) throw new TypeError('Initial revision cannot be hydrated with a parent');
    return;
  }
  if (
    parent === undefined ||
    revision.id !== parent.id ||
    revision.revision !== parent.revision + 1 ||
    revision.previousRevisionId !== parent.revisionId ||
    revision.createdAt !== parent.createdAt ||
    revision.updatedAt < parent.updatedAt
  ) {
    throw new TypeError('Revision does not continue the supplied exact parent');
  }
}

/**
 * Reconstructs Prompt behavior only after its DTO passes the explicit codec.
 * @param input - Untrusted persisted or transported value.
 * @returns Behavior-bearing Prompt or normalized hydration failure.
 */
export async function hydratePrompt(input: HydratePromptInput): Promise<ResultValue<Prompt, ResourcesError>> {
  try {
    /** Codec proves portable shape and contentDigest before methods are installed. */
    const parsed = PromptCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    /** A visible-field copy cannot authorize the revision fields it repeats. */
    if (input.parent !== undefined) promptRef(input.parent);
    /** Child hydration must prove continuity with behavior the application already trusts. */
    assertHydrationParent(parsed.value, input.parent);
    if (parsed.value.source !== undefined) {
      if (input.files === undefined) throw new TypeError('Imported Prompt hydration requires immutable source content');
      /** Restores the exact source tree before trusting any imported Prompt metadata. */
      const restored = await restoreTree(input.files, parsed.value.source.tree);
      if (!restored.ok) throw restored.error;
      /** Requires the one-file snapshot member named by the portable Prompt source reference. */
      const file = restored.value.files.find((candidate) => candidate.path === parsed.value.source?.path);
      if (file === undefined || restored.value.files.length !== 1) {
        throw new TypeError('Prompt source tree must contain exactly its declared file');
      }
      /** Consumes and verifies complete immutable bytes before any Prompt behavior is reconstructed. */
      const bytes = await readBlob(input.files, file.path, file.blob);
      if (!bytes.ok) throw bytes.error;
      /** Uses fatal decoding so corrupted source bytes cannot become replacement Unicode text. */
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
      if (text !== parsed.value.template) throw new TypeError('Prompt source bytes do not match template behavior');
    }
    return Result.ok(hydratePromptState(parsed.value));
  } catch (cause) {
    return Result.error(new ResourcesError('resources_hydration_failed', 'Prompt hydration failed', { cause }));
  }
}

/**
 * Reconstructs BudgetPolicy behavior only after its DTO passes the explicit codec.
 * @param input - Untrusted persisted or transported value.
 * @returns Behavior-bearing policy or normalized hydration failure.
 */
export function hydrateBudgetPolicy(input: HydrateBudgetPolicyInput): ResultValue<BudgetPolicy, ResourcesError> {
  try {
    /** Codec proves portable shape and contentDigest before methods are installed. */
    const parsed = BudgetPolicyCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    /** Narrowing behavior must have admitted the parent used to restore its child. */
    if (input.parent !== undefined) budgetPolicyRef(input.parent);
    /** Child hydration must prove continuity with behavior the application already trusts. */
    assertHydrationParent(parsed.value, input.parent);
    return Result.ok(hydrateBudgetPolicyState(parsed.value));
  } catch (cause) {
    return Result.error(new ResourcesError('resources_hydration_failed', 'BudgetPolicy hydration failed', { cause }));
  }
}

/**
 * Reads one complete verified blob into an independent byte array.
 * @param files - Borrowed immutable store.
 * @param path - Logical file path used only for bounded error evidence.
 * @param ref - Exact blob identity from the restored tree.
 * @returns Complete copied bytes or one Resource hydration failure.
 */
async function readBlob(
  files: FileStore,
  path: LogicalPath,
  ref: Parameters<FileStore['blobs']['read']>[0],
): Promise<ResultValue<Uint8Array, ResourcesError>> {
  /** BlobStore verifies identity when the content stream completes. */
  const opened = await files.blobs.read(ref);
  if (!opened.ok) {
    return Result.error(
      new ResourcesError('resources_hydration_failed', 'Resource content could not be opened', {
        cause: opened.error,
        details: { path },
      }),
    );
  }
  try {
    /** Private chunks are copied again into one exact behavior snapshot. */
    const chunks: Uint8Array[] = [];
    /** Aggregate length is known before allocating one final copy. */
    let byteLength = 0;
    /** Stream iteration must complete for BlobStore integrity verification to succeed. */
    for await (const chunk of opened.value.content) {
      /** Each store-owned delivery is copied before later concatenation. */
      const copy = Uint8Array.from(chunk);
      chunks.push(copy);
      byteLength += copy.byteLength;
    }
    /** Concatenation preserves stream order while exposing no retained chunk aliases. */
    const content = new Uint8Array(byteLength);
    /** Offset advances by exact bytes rather than chunk count. */
    let offset = 0;
    /** Chunks retain source order from the verified blob stream. */
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Result.ok(content);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_hydration_failed', 'Resource content failed integrity verification', {
        cause,
        details: { path },
      }),
    );
  }
}

/**
 * Reconstructs Skill behavior after restoring its exact immutable file capability.
 * @param input - Untrusted DTO and borrowed FileStore.
 * @returns Behavior-bearing Skill or exact codec/content/domain failure.
 */
export async function hydrateSkill(input: HydrateSkillInput): Promise<ResultValue<Skill, ResourcesError>> {
  try {
    /** DTO parsing proves portable identity but does not pretend content is available. */
    const parsed = SkillCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    /** Imported or hydrated Skill provenance precedes all file reads for a child. */
    if (input.parent !== undefined) skillRef(input.parent);
    /** Immutable content cannot substitute for the exact logical revision parent. */
    assertHydrationParent(parsed.value, input.parent);
    /** Tree restoration verifies the complete canonical graph and every blob reference. */
    const restored = await restoreTree(input.files, parsed.value.tree);
    if (!restored.ok) throw restored.error;
    if (JSON.stringify(restored.value.ref) !== JSON.stringify(parsed.value.tree)) {
      throw new TypeError('Restored Skill tree reference differs from the DTO');
    }
    /** DTO path order is part of exact immutable Skill identity. */
    const paths = restored.value.files.map((file) => file.path);
    if (JSON.stringify(paths) !== JSON.stringify(parsed.value.paths)) {
      throw new TypeError('Restored Skill paths differ from the DTO');
    }
    /** Complete reads finish before any Skill behavior owner is returned. */
    const content = new Map<LogicalPath, Uint8Array>();
    /** Every restored file is read completely before constructing Skill behavior. */
    for (const file of restored.value.files) {
      /** A failed file read prevents any partially hydrated Skill from escaping. */
      const read = await readBlob(input.files, file.path, file.blob);
      if (!read.ok) return read;
      content.set(file.path, read.value);
    }
    return Result.ok(hydrateSkillState(parsed.value, restored.value, content));
  } catch (cause) {
    return Result.error(new ResourcesError('resources_hydration_failed', 'Skill hydration failed', { cause }));
  }
}

/**
 * Reconstructs AgentProfile behavior from exact already-hydrated Resource owners.
 * @param input - Untrusted DTO plus every selected behavior object.
 * @returns Behavior-bearing profile or exact reference/contentDigest mismatch.
 */
export function hydrateAgentProfile(input: HydrateAgentProfileInput): ResultValue<AgentProfile, ResourcesError> {
  try {
    /** DTO codec verifies portable profile identity and internal selection consistency. */
    const parsed = AgentProfileCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    /** Profile selection behavior must own the parent before bindings can restore its child. */
    if (input.parent !== undefined) agentProfileRef(input.parent);
    /** Selection bindings cannot substitute for exact revision continuity. */
    assertHydrationParent(parsed.value, input.parent, 0);
    return Result.ok(
      hydrateAgentProfileState(parsed.value, {
        model: input.model,
        prompts: Object.freeze([...input.prompts]),
        skills: Object.freeze(input.skills.map((selection) => Object.freeze({ ...selection }))),
        budget: input.budget,
      }),
    );
  } catch (cause) {
    return Result.error(new ResourcesError('resources_hydration_failed', 'AgentProfile hydration failed', { cause }));
  }
}

/**
 * Restores one ResourceSet only after portable truth and admission policy both succeed.
 * @param input - Untrusted receipt, exact profile behavior, and authentication capability.
 * @returns Behavior-bound set or a refusal that grants no partial compiler provenance.
 */
export async function hydrateResourceSet(
  input: HydrateResourceSetInput,
): Promise<ResultValue<ResourceSet, ResourcesError>> {
  try {
    /** Decodes the complete receipt before admission policy or behavior binding is considered. */
    const parsed = ResourceSetCodec.safeParse(input.dto);
    if (!parsed.ok) throw parsed.error;
    /** Requires admitted profile behavior so a DTO cannot supply the ResourceSet selection. */
    const profile = agentProfileRef(input.profile);
    if (
      profile.id !== parsed.value.profile.id ||
      profile.revisionId !== parsed.value.profile.revisionId ||
      profile.contentDigest !== parsed.value.profile.contentDigest
    ) {
      throw new TypeError('ResourceSet profile does not match supplied behavior');
    }
    /** Keeps local and reviewed restoration paths explicit because their trust evidence differs. */
    let restored: ResultValue<ResourceSet, ResourcesError>;
    if (input.admission.mode === 'local') {
      if (parsed.value.admission.mode !== 'local') throw new TypeError('ResourceSet admission mode does not match');
      /** Delegates local authenticity to the application that originally owned that policy. */
      const authentic = await input.admission.authenticate(parsed.value);
      if (!authentic) throw new TypeError('Local ResourceSet receipt was not authenticated');
      restored = Result.ok(
        compileResourceSetFromProfile(
          input.profile,
          Object.freeze({ mode: 'local', policy: 'application' }),
          Object.freeze({ id: parsed.value.id, createdAt: parsed.value.createdAt }),
        ),
      );
    } else {
      if (parsed.value.admission.mode !== 'reviewed') throw new TypeError('ResourceSet admission mode does not match');
      restored = compileReviewedResourceSet({
        profile: input.profile,
        admissions: input.admission.admissions,
        ...(input.admission.revocations === undefined ? {} : { revocations: input.admission.revocations }),
        context: Object.freeze({ id: parsed.value.id, createdAt: parsed.value.createdAt }),
      });
    }
    if (!restored.ok) return restored;
    /** Identity, time, and canonical evidence together bind every portable receipt field. */
    if (
      restored.value.id !== parsed.value.id ||
      restored.value.createdAt !== parsed.value.createdAt ||
      restored.value.evidenceDigest !== parsed.value.evidenceDigest
    ) {
      throw new TypeError('ResourceSet receipt does not match reconstructed behavior and admission evidence');
    }
    return restored;
  } catch (cause) {
    return Result.error(new ResourcesError('resources_hydration_failed', 'ResourceSet hydration failed', { cause }));
  }
}
