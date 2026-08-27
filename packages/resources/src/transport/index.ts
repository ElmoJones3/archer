/**
 * @file Defines strict JSON DTO boundaries without manufacturing Resource behavior.
 *
 * These schemas copy and deeply freeze portable data. Parsing proves only the
 * wire contract; hydration and control modules separately restore behavior or
 * earned provenance.
 */

import * as z from 'zod';

import {
  CanonicalDecimalSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  fromZod,
  type CanonicalDecimal,
} from '@archer/core';
import { PrincipalIdSchema } from '@archer/core/authority';
import { LogicalPathSchema, TreeRefSchema } from '@archer/files';

import {
  budgetAllocationState,
  budgetPolicyState,
  type BudgetAllocation,
  type BudgetAllocationId,
  type BudgetAllocationState,
  type BudgetPolicy,
  type BudgetPolicyId,
  type BudgetPolicyRevisionId,
  type BudgetPolicyState,
} from '../budgets/index.js';
import { resourceDigest } from '../common.js';
import {
  resourceAdmissionChainState,
  resourceProposalState,
  resourceReviewState,
  resourceRevocationState,
  type ResourceProposal,
  type ResourceReview,
  type ResourceAdmissionChain,
  type ResourceAdmissionState,
  type ResourceAdmissionId,
  type ResourceControlRef,
  type ResourceProposalState,
  type ResourceProposalId,
  type ResourceReviewState,
  type ResourceReviewId,
  type ResourceRevocationState,
  type ResourceRevocationId,
  type VerifiedResourceAdmission,
  type VerifiedResourceRevocation,
} from '../control/index.js';
import {
  agentProfileState,
  type AgentProfile,
  type AgentProfileId,
  type AgentProfileRevisionId,
  type AgentProfileState,
} from '../profiles/index.js';
import { promptState, type Prompt, type PromptId, type PromptRevisionId, type PromptState } from '../prompts/index.js';
import { resourceSetState, type ResourceSet, type ResourceSetId, type ResourceSetState } from '../session.js';
import { skillState, type Skill, type SkillId, type SkillRevisionId, type SkillState } from '../skills/index.js';

/** Canonical JSON-safe numeric fields owned only by the Budget transport boundary. */
export type BudgetLimitsDto = Readonly<{
  /** Canonical generated-output ceiling when present. */
  outputTokens?: CanonicalDecimal;

  /** Canonical wall-time ceiling when present. */
  wallTimeMs?: CanonicalDecimal;
}>;

/** Wire representation of one exact BudgetPolicy revision. */
export type BudgetPolicyDto = Omit<BudgetPolicyState, 'limits'> &
  Readonly<{
    /** Canonical decimal ceilings prevent JSON number ambiguity at remote boundaries. */
    limits: BudgetLimitsDto;
  }>;

/** Wire representation of one exact derived BudgetAllocation fact. */
export type BudgetAllocationDto = Omit<BudgetAllocationState, 'outputTokens'> &
  Readonly<{
    /** Canonical decimal output ceiling prevents JSON number ambiguity at remote boundaries. */
    outputTokens: CanonicalDecimal;
  }>;

/** Wire representation of one exact Prompt revision. */
export type PromptDto = PromptState;

/** Wire representation of one exact Skill revision. */
export type SkillDto = SkillState;

/** Wire representation of one exact AgentProfile revision. */
export type AgentProfileDto = AgentProfileState;

/** Wire representation of one exact compiled ResourceSet receipt. */
export type ResourceSetDto = ResourceSetState;

/** Wire representation of one Resource proposal fact. */
export type ResourceProposalDto = ResourceProposalState;

/** Wire representation of one independent Resource review fact. */
export type ResourceReviewDto = ResourceReviewState;

/** Wire representation of one Resource admission fact. */
export type ResourceAdmissionDto = ResourceAdmissionState;

/** Wire representation of one Resource revocation fact. */
export type ResourceRevocationDto = ResourceRevocationState;

/**
 * Copies and deeply freezes one already JSON-safe DTO value.
 * @param value - Validator output containing no functions or runtime authority.
 * @returns Detached immutable data with the same JSON representation.
 */
function immutableDto<Value>(value: Value): Value {
  return JsonValueSchema.parse(value) as unknown as Value;
}

/** Canonical positive safe-integer text used by BudgetPolicy DTOs. */
const PositiveSafeIntegerDtoSchema = CanonicalDecimalSchema.refine(
  (value) => {
    /** Converts canonical decimal text only for a bounded JavaScript-safe integer check. */
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
  },
  { message: 'Expected a positive safe integer encoded as canonical decimal text' },
);

/**
 * Shared initial-or-child lifecycle checks for one-based Resource revisions.
 * @param value - Transport-validated lifecycle fields to check as one revision.
 * @param context - Zod issue collector receiving exact lineage failures.
 */
function checkOneBasedRevision(
  value: Readonly<{
    /** Provides stable logical identity distinct from one exact revision. */
    id: string;
    /** Provides the exact immutable revision identity. */
    revisionId: string;
    /** Provides logical creation time for one-based Resource lineage validation. */
    createdAt: string;
    /** Provides the exact positive revision number whose parent shape must match. */
    revision: number;
    /** Names the parent only for child revisions; initial revisions must omit it. */
    previousRevisionId?: string | undefined;
    /** Provides causal revision time for ancestry and clock-order validation. */
    updatedAt: string;
  }>,
  context: z.RefinementCtx,
): void {
  if (String(value.id) === String(value.revisionId)) {
    context.addIssue({ code: 'custom', path: ['revisionId'], message: 'Resource identities must be distinct' });
  }
  if (value.previousRevisionId === value.revisionId) {
    context.addIssue({ code: 'custom', path: ['revisionId'], message: 'Child revision identity must be fresh' });
  }
  if (value.revision === 1 && value.previousRevisionId !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['previousRevisionId'],
      message: 'Initial revision cannot name a parent',
    });
  }
  if (value.revision === 1 && value.createdAt !== value.updatedAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Initial revision timestamps must agree' });
  }
  if (value.revision > 1 && value.previousRevisionId === undefined) {
    context.addIssue({ code: 'custom', path: ['previousRevisionId'], message: 'Child revision requires a parent' });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Revision cannot predate logical creation' });
  }
}

/**
 * Shared initial-or-child lifecycle checks for zero-based AgentProfile revisions.
 * @param value - Transport-validated profile lifecycle fields to check.
 * @param context - Zod issue collector receiving exact lineage failures.
 */
function checkZeroBasedRevision(
  value: Readonly<{
    /** Provides stable profile identity distinct from one exact revision. */
    id: string;
    /** Provides the exact immutable profile revision identity. */
    revisionId: string;
    /** Provides logical creation time for zero-based AgentProfile lineage validation. */
    createdAt: string;
    /** Provides the exact nonnegative profile revision whose parent shape must match. */
    revision: number;
    /** Names the parent only after the initial AgentProfile revision. */
    previousRevisionId?: string | undefined;
    /** Provides causal profile update time for ancestry and clock-order validation. */
    updatedAt: string;
  }>,
  context: z.RefinementCtx,
): void {
  if (String(value.id) === String(value.revisionId)) {
    context.addIssue({ code: 'custom', path: ['revisionId'], message: 'Profile identities must be distinct' });
  }
  if (value.previousRevisionId === value.revisionId) {
    context.addIssue({
      code: 'custom',
      path: ['revisionId'],
      message: 'Profile child revision identity must be fresh',
    });
  }
  if (value.revision === 0 && value.previousRevisionId !== undefined) {
    context.addIssue({ code: 'custom', path: ['previousRevisionId'], message: 'Initial profile cannot name a parent' });
  }
  if (value.revision === 0 && value.createdAt !== value.updatedAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Initial profile timestamps must agree' });
  }
  if (value.revision > 0 && value.previousRevisionId === undefined) {
    context.addIssue({ code: 'custom', path: ['previousRevisionId'], message: 'Child profile requires a parent' });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Profile revision cannot predate creation' });
  }
}

/** Exact provider-specific Model reference embedded in profiles and sets. */
export const ModelRefDtoSchema = z
  .strictObject({
    resource: z.literal('model'),
    id: UuidV4Schema,
    revisionId: UuidV4Schema,
    type: z.enum(['openai', 'google', 'xai', 'ollama', 'compatible']),
    name: z.string().trim().min(1).max(256),
    contentDigest: Sha256DigestSchema,
  })
  .transform(immutableDto);

/** Exact Prompt reference embedded in profiles and sets. */
export const PromptRefDtoSchema = z
  .strictObject({
    resource: z.literal('prompt'),
    id: UuidV4Schema,
    revisionId: UuidV4Schema,
    name: z.string().trim().min(1).max(256),
    contentDigest: Sha256DigestSchema,
  })
  .transform(immutableDto);

/** Exact Skill reference embedded in profiles and sets. */
export const SkillRefDtoSchema = z
  .strictObject({
    resource: z.literal('skill'),
    id: UuidV4Schema,
    revisionId: UuidV4Schema,
    name: z.string().min(1).max(64),
    contentDigest: Sha256DigestSchema,
  })
  .transform(immutableDto);

/** Exact BudgetPolicy reference embedded in profiles and sets. */
export const BudgetPolicyRefDtoSchema = z
  .strictObject({
    resource: z.literal('budget-policy'),
    id: UuidV4Schema,
    revisionId: UuidV4Schema,
    name: z.string().trim().min(1).max(256),
    contentDigest: Sha256DigestSchema,
  })
  .transform(immutableDto);

/** Strict transport schema for one behavior-bearing Prompt revision's data. */
export const PromptDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as PromptId),
    object: z.literal('prompt'),
    resource: z.literal('prompt'),
    createdAt: TimestampSchema,
    name: z.string().trim().min(1).max(256),
    revisionId: UuidV4Schema.transform((value) => value as PromptRevisionId),
    revision: z.int().positive(),
    previousRevisionId: UuidV4Schema.transform((value) => value as PromptRevisionId).optional(),
    updatedAt: TimestampSchema,
    placement: z.enum(['system', 'user']),
    template: z.string().min(1).max(256_000),
    variables: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u)).max(128),
    source: z.strictObject({ tree: TreeRefSchema, path: LogicalPathSchema }).optional(),
    contentDigest: Sha256DigestSchema,
  })
  .superRefine((value, context) => {
    checkOneBasedRevision(value, context);
    /** Recomputes Prompt behavior identity so a supplied digest cannot bless altered content. */
    const expected = resourceDigest('archer.prompt.v1', {
      placement: value.placement,
      template: value.template,
      variables: value.variables,
      ...(value.source === undefined ? {} : { source: value.source }),
    });
    if (expected !== value.contentDigest) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Prompt content digest mismatch' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as PromptDto);

/** Strict transport schema for one reusable BudgetPolicy revision's data. */
export const BudgetPolicyDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as BudgetPolicyId),
    object: z.literal('budget-policy'),
    resource: z.literal('budget-policy'),
    createdAt: TimestampSchema,
    name: z.string().trim().min(1).max(256),
    revisionId: UuidV4Schema.transform((value) => value as BudgetPolicyRevisionId),
    revision: z.int().positive(),
    previousRevisionId: UuidV4Schema.transform((value) => value as BudgetPolicyRevisionId).optional(),
    updatedAt: TimestampSchema,
    limits: z
      .strictObject({
        outputTokens: PositiveSafeIntegerDtoSchema.optional(),
        wallTimeMs: PositiveSafeIntegerDtoSchema.optional(),
      })
      .refine((value) => value.outputTokens !== undefined || value.wallTimeMs !== undefined, {
        message: 'BudgetPolicy requires at least one limit',
      }),
    contentDigest: Sha256DigestSchema,
  })
  .superRefine((value, context) => {
    checkOneBasedRevision(value, context);
    /** Decodes canonical decimal fields only for canonical Budget digest verification. */
    const limits = {
      ...(value.limits.outputTokens === undefined ? {} : { outputTokens: Number(value.limits.outputTokens) }),
      ...(value.limits.wallTimeMs === undefined ? {} : { wallTimeMs: Number(value.limits.wallTimeMs) }),
    };
    if (resourceDigest('archer.budget-policy.v1', { limits }) !== value.contentDigest) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'BudgetPolicy content digest mismatch' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as BudgetPolicyDto);

/** Strict transport schema for one derived BudgetAllocation fact. */
export const BudgetAllocationDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as BudgetAllocationId),
    object: z.literal('budget-allocation'),
    createdAt: TimestampSchema,
    policy: BudgetPolicyRefDtoSchema,
    model: ModelRefDtoSchema,
    parentId: UuidV4Schema.transform((value) => value as BudgetAllocationId).optional(),
    outputTokens: PositiveSafeIntegerDtoSchema,
    startedAt: TimestampSchema,
    deadline: TimestampSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.createdAt !== value.startedAt) {
      context.addIssue({ code: 'custom', path: ['createdAt'], message: 'Allocation creation and start must agree' });
    }
    if (value.deadline !== undefined && value.deadline <= value.startedAt) {
      context.addIssue({ code: 'custom', path: ['deadline'], message: 'Allocation deadline must follow its start' });
    }
    if (value.parentId === value.id) {
      context.addIssue({ code: 'custom', path: ['parentId'], message: 'Allocation cannot parent itself' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as BudgetAllocationDto);

/** Current Agent Skills manifest fields retained by one portable Skill revision. */
export const SkillManifestDtoSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
  })
  .transform(immutableDto);

/** Strict transport schema for one imported Agent Skill revision's data. */
export const SkillDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as SkillId),
    object: z.literal('skill'),
    resource: z.literal('skill'),
    createdAt: TimestampSchema,
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    revisionId: UuidV4Schema.transform((value) => value as SkillRevisionId),
    revision: z.int().positive(),
    previousRevisionId: UuidV4Schema.transform((value) => value as SkillRevisionId).optional(),
    updatedAt: TimestampSchema,
    manifest: SkillManifestDtoSchema,
    tree: TreeRefSchema,
    paths: z.array(LogicalPathSchema).min(1),
    contentDigest: Sha256DigestSchema,
  })
  .superRefine((value, context) => {
    checkOneBasedRevision(value, context);
    if (value.name !== value.manifest.name) {
      context.addIssue({ code: 'custom', path: ['name'], message: 'Skill name must match its manifest' });
    }
    if (!value.paths.includes(LogicalPathSchema.parse('SKILL.md'))) {
      context.addIssue({ code: 'custom', path: ['paths'], message: 'Skill paths must include SKILL.md' });
    }
    if (new Set(value.paths).size !== value.paths.length) {
      context.addIssue({ code: 'custom', path: ['paths'], message: 'Skill paths must be unique' });
    }
    /** Recomputes Skill identity from manifest and complete immutable tree evidence. */
    const expected = resourceDigest('archer.skill.v1', {
      manifest: value.manifest,
      tree: value.tree,
      paths: value.paths,
    });
    if (expected !== value.contentDigest) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Skill content digest mismatch' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as SkillDto);

/** Strict transport schema for one immutable AgentProfile selection revision. */
export const AgentProfileDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as AgentProfileId),
    object: z.literal('agent-profile'),
    createdAt: TimestampSchema,
    name: z.string().trim().min(1).max(256),
    revisionId: UuidV4Schema.transform((value) => value as AgentProfileRevisionId),
    revision: z.int().nonnegative(),
    previousRevisionId: UuidV4Schema.transform((value) => value as AgentProfileRevisionId).optional(),
    updatedAt: TimestampSchema,
    model: ModelRefDtoSchema,
    prompts: z.array(PromptRefDtoSchema),
    skills: z.array(z.strictObject({ skill: SkillRefDtoSchema, activation: z.enum(['discoverable', 'active']) })),
    budget: BudgetPolicyRefDtoSchema,
    contentDigest: Sha256DigestSchema,
  })
  .superRefine((value, context) => {
    checkZeroBasedRevision(value, context);
    /** Collects logical IDs so duplicate Resources cannot hide behind distinct revisions. */
    const logicalIds = [
      value.model.id,
      ...value.prompts.map((prompt) => prompt.id),
      ...value.skills.map((selection) => selection.skill.id),
      value.budget.id,
    ];
    /** Collects revision IDs so one immutable revision cannot be selected twice. */
    const revisionIds = [
      value.model.revisionId,
      ...value.prompts.map((prompt) => prompt.revisionId),
      ...value.skills.map((selection) => selection.skill.revisionId),
      value.budget.revisionId,
    ];
    if (new Set(logicalIds).size !== logicalIds.length) {
      context.addIssue({ code: 'custom', path: [], message: 'AgentProfile Resource logical IDs must be unique' });
    }
    if (new Set(revisionIds).size !== revisionIds.length) {
      context.addIssue({ code: 'custom', path: [], message: 'AgentProfile Resource revision IDs must be unique' });
    }
    /** Recomputes profile selection identity independently from display and lifecycle metadata. */
    const expected = resourceDigest('archer.agent-profile.v1', {
      model: value.model,
      prompts: value.prompts,
      skills: value.skills,
      budget: value.budget,
    });
    if (expected !== value.contentDigest) {
      context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'AgentProfile content digest mismatch' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as AgentProfileDto);

/** Discriminated Resource reference schema retained by ResourceSet receipts. */
export const ResourceRevisionRefDtoSchema = z.discriminatedUnion('resource', [
  ModelRefDtoSchema,
  PromptRefDtoSchema,
  SkillRefDtoSchema,
  BudgetPolicyRefDtoSchema,
]);

/** Explicit local or independently reviewed ResourceSet admission record. */
export const ResourceSetAdmissionDtoSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('local'), policy: z.literal('application') }),
  z.strictObject({ mode: z.literal('reviewed'), admissions: z.array(UuidV4Schema).min(1) }),
]);

/** Strict transport schema for one compiled ResourceSet receipt. */
export const ResourceSetDtoSchema = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ResourceSetId),
    object: z.literal('resource-set'),
    createdAt: TimestampSchema,
    profile: z.strictObject({
      id: UuidV4Schema.transform((value) => value as AgentProfileId),
      revisionId: UuidV4Schema.transform((value) => value as AgentProfileRevisionId),
      name: z.string().trim().min(1).max(256),
      contentDigest: Sha256DigestSchema,
    }),
    resources: z.array(ResourceRevisionRefDtoSchema).min(2),
    compilerRevision: z.literal(1),
    admission: ResourceSetAdmissionDtoSchema,
    evidenceDigest: Sha256DigestSchema,
  })
  .superRefine((value, context) => {
    /** Projects kind order before checking ResourceSet closure and canonical grouping. */
    const kinds = value.resources.map((resource) => resource.resource);
    /** Locates the Skill boundary so Prompt entries cannot appear after Skills begin. */
    const firstSkill = kinds.indexOf('skill');
    /** Locates the final Prompt so Skill ordering checks remain explicit for empty groups. */
    const lastPrompt = kinds.lastIndexOf('prompt');
    /** Requires one Model first, one Budget last, and contiguous Prompt then Skill groups. */
    const ordered =
      kinds[0] === 'model' &&
      kinds.at(-1) === 'budget-policy' &&
      kinds.filter((kind) => kind === 'model').length === 1 &&
      kinds.filter((kind) => kind === 'budget-policy').length === 1 &&
      (firstSkill === -1 || lastPrompt === -1 || lastPrompt < firstSkill);
    if (!ordered) {
      context.addIssue({
        code: 'custom',
        path: ['resources'],
        message: 'ResourceSet order must be Model, Prompts, Skills, then BudgetPolicy',
      });
    }
    /** Checks exact revision uniqueness separately from kind ordering and cardinality. */
    const revisionIds = value.resources.map((resource) => resource.revisionId);
    if (new Set(revisionIds).size !== revisionIds.length) {
      context.addIssue({ code: 'custom', path: ['resources'], message: 'ResourceSet revisions must be unique' });
    }
    if (value.admission.mode === 'reviewed' && value.admission.admissions.length !== value.resources.length) {
      context.addIssue({
        code: 'custom',
        path: ['admission', 'admissions'],
        message: 'Reviewed ResourceSet requires one admission per Resource',
      });
    }
    /** Recomputes ResourceSet evidence from the complete portable receipt and policy. */
    const expected = resourceDigest('archer.resource-set.v1', {
      profile: value.profile,
      resources: value.resources,
      compilerRevision: value.compilerRevision,
      admission: value.admission,
    });
    if (expected !== value.evidenceDigest) {
      context.addIssue({ code: 'custom', path: ['evidenceDigest'], message: 'ResourceSet evidence digest mismatch' });
    }
  })
  .transform((value) => immutableDto(value) as unknown as ResourceSetDto);

/** Kind-discriminated exact Resource reference shared by lifecycle facts. */
export const ResourceControlRefDtoSchema: z.ZodType<ResourceControlRef> = z
  .strictObject({
    kind: z.enum(['model', 'prompt', 'skill', 'budget-policy']),
    id: UuidV4Schema,
    revisionId: UuidV4Schema,
    name: z.string().trim().min(1).max(256),
    contentDigest: Sha256DigestSchema,
  })
  .transform((value) => immutableDto(value) as ResourceControlRef);

/** Strict data schema for one Resource proposal fact. */
export const ResourceProposalDtoSchema: z.ZodType<ResourceProposalDto> = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ResourceProposalId),
    object: z.literal('resource-proposal'),
    createdAt: TimestampSchema,
    resource: ResourceControlRefDtoSchema,
    proposedBy: PrincipalIdSchema,
  })
  .transform((value) => immutableDto(value) as ResourceProposalDto);

/** Strict data schema for one independent Resource review fact. */
export const ResourceReviewDtoSchema: z.ZodType<ResourceReviewDto> = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ResourceReviewId),
    object: z.literal('resource-review'),
    createdAt: TimestampSchema,
    proposalId: UuidV4Schema.transform((value) => value as ResourceProposalId),
    resource: ResourceControlRefDtoSchema,
    proposedBy: PrincipalIdSchema,
    reviewedBy: PrincipalIdSchema,
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(1).max(1024).optional(),
  })
  .superRefine((value, context) => {
    if (value.proposedBy === value.reviewedBy) {
      context.addIssue({ code: 'custom', path: ['reviewedBy'], message: 'Resource review must be independent' });
    }
  })
  .transform((value) => immutableDto(value) as ResourceReviewDto);

/** Strict data schema for one Resource admission fact. */
export const ResourceAdmissionDtoSchema: z.ZodType<ResourceAdmissionDto> = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ResourceAdmissionId),
    object: z.literal('resource-admission'),
    createdAt: TimestampSchema,
    resource: ResourceControlRefDtoSchema,
    reviewId: UuidV4Schema.transform((value) => value as ResourceReviewId),
    admittedBy: PrincipalIdSchema,
  })
  .transform((value) => immutableDto(value) as ResourceAdmissionDto);

/** Strict data schema for one Resource revocation fact. */
export const ResourceRevocationDtoSchema: z.ZodType<ResourceRevocationDto> = z
  .strictObject({
    id: UuidV4Schema.transform((value) => value as ResourceRevocationId),
    object: z.literal('resource-revocation'),
    createdAt: TimestampSchema,
    admissionId: UuidV4Schema.transform((value) => value as ResourceAdmissionId),
    resource: ResourceControlRefDtoSchema,
    revokedBy: PrincipalIdSchema,
    reason: z.string().trim().min(1).max(1024).optional(),
  })
  .transform((value) => immutableDto(value) as ResourceRevocationDto);

/** Strict portable chain schema that deliberately grants no verified admission authority. */
export const ResourceAdmissionChainDtoSchema: z.ZodType<ResourceAdmissionChain> = z
  .strictObject({
    proposal: ResourceProposalDtoSchema,
    review: ResourceReviewDtoSchema,
    admission: ResourceAdmissionDtoSchema,
  })
  .superRefine((value, context) => {
    /**
     * Compares the complete Resource identity repeated across one lifecycle chain.
     * @param left - Earlier lifecycle fact's exact Resource reference.
     * @param right - Later lifecycle fact's repeated Resource reference.
     * @returns Whether both references name the same behavior-bearing revision.
     */
    const same = (left: ResourceControlRef, right: ResourceControlRef): boolean =>
      left.kind === right.kind &&
      left.id === right.id &&
      left.revisionId === right.revisionId &&
      left.contentDigest === right.contentDigest;
    if (value.review.proposalId !== value.proposal.id) {
      context.addIssue({ code: 'custom', path: ['review', 'proposalId'], message: 'Review proposal does not match' });
    }
    if (value.review.proposedBy !== value.proposal.proposedBy) {
      context.addIssue({ code: 'custom', path: ['review', 'proposedBy'], message: 'Review proposer does not match' });
    }
    if (value.review.decision !== 'approve') {
      context.addIssue({ code: 'custom', path: ['review', 'decision'], message: 'Admission chain requires approval' });
    }
    if (value.admission.reviewId !== value.review.id) {
      context.addIssue({ code: 'custom', path: ['admission', 'reviewId'], message: 'Admission review does not match' });
    }
    if (
      !same(value.proposal.resource, value.review.resource) ||
      !same(value.proposal.resource, value.admission.resource)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['admission', 'resource'],
        message: 'Admission chain Resource does not match',
      });
    }
  })
  .transform((value) => immutableDto(value) as ResourceAdmissionChain);

/** Decodes Prompt DTO data without restoring Prompt behavior. */
export const PromptCodec = fromZod(PromptDtoSchema);

/** Decodes BudgetPolicy DTO data without restoring policy behavior. */
export const BudgetPolicyCodec = fromZod(BudgetPolicyDtoSchema);

/** Decodes BudgetAllocation DTO data without restoring delegated parent authority. */
export const BudgetAllocationCodec = fromZod(BudgetAllocationDtoSchema);

/** Decodes Skill DTO data without restoring acquired content guarantees. */
export const SkillCodec = fromZod(SkillDtoSchema);

/** Decodes AgentProfile DTO data without proving a legal transition. */
export const AgentProfileCodec = fromZod(AgentProfileDtoSchema);

/** Decodes a ResourceSet receipt without restoring its private behavior binding. */
export const ResourceSetCodec = fromZod(ResourceSetDtoSchema);

/** Decodes a proposal fact without granting locally earned proposal provenance. */
export const ResourceProposalCodec = fromZod(ResourceProposalDtoSchema);

/** Decodes a review fact without granting locally earned review provenance. */
export const ResourceReviewCodec = fromZod(ResourceReviewDtoSchema);

/** Decodes an admission fact without proving its review or authenticity. */
export const ResourceAdmissionCodec = fromZod(ResourceAdmissionDtoSchema);

/** Decodes a full chain without granting positive compiler evidence. */
export const ResourceAdmissionChainCodec = fromZod(ResourceAdmissionChainDtoSchema);

/** Decodes a revocation fact without deciding whether it is current. */
export const ResourceRevocationCodec = fromZod(ResourceRevocationDtoSchema);

/**
 * Copies one behavior value into detached Prompt transport data.
 * @param prompt - Exact behavior-bearing Prompt.
 * @returns Deeply immutable detached Prompt data.
 */
export function encodePrompt(prompt: Prompt): PromptDto {
  return PromptDtoSchema.parse(promptState(prompt));
}

/**
 * Copies one behavior value into detached BudgetPolicy transport data.
 * @param policy - Exact behavior-bearing BudgetPolicy.
 * @returns Deeply immutable detached policy data.
 */
export function encodeBudgetPolicy(policy: BudgetPolicy): BudgetPolicyDto {
  /** Domain state retains useful JavaScript numbers; canonical text is strictly transport policy. */
  const state = budgetPolicyState(policy);
  return BudgetPolicyDtoSchema.parse({
    ...state,
    limits: {
      ...(state.limits.outputTokens === undefined
        ? {}
        : { outputTokens: CanonicalDecimalSchema.parse(String(state.limits.outputTokens)) }),
      ...(state.limits.wallTimeMs === undefined
        ? {}
        : { wallTimeMs: CanonicalDecimalSchema.parse(String(state.limits.wallTimeMs)) }),
    },
  });
}

/**
 * Copies one admitted allocation into detached transport data.
 * @param allocation - Exact allocation carrying runtime parent authority.
 * @returns Deeply immutable detached allocation DTO.
 */
export function encodeBudgetAllocation(allocation: BudgetAllocation): BudgetAllocationDto {
  /** Domain state retains a useful JavaScript number until the transport boundary owns its encoding. */
  const state = budgetAllocationState(allocation);
  return BudgetAllocationDtoSchema.parse({
    ...state,
    outputTokens: CanonicalDecimalSchema.parse(String(state.outputTokens)),
  });
}

/**
 * Copies one behavior value into detached Skill transport data.
 * @param skill - Exact behavior-bearing Skill.
 * @returns Deeply immutable detached Skill data.
 */
export function encodeSkill(skill: Skill): SkillDto {
  return SkillDtoSchema.parse(skillState(skill));
}

/**
 * Copies one behavior value into detached AgentProfile transport data.
 * @param profile - Exact behavior-bearing AgentProfile.
 * @returns Deeply immutable detached profile data.
 */
export function encodeAgentProfile(profile: AgentProfile): AgentProfileDto {
  return AgentProfileDtoSchema.parse(agentProfileState(profile));
}

/**
 * Copies one compiled set into detached ResourceSet transport data.
 * @param resourceSet - Exact package-compiled ResourceSet.
 * @returns Deeply immutable detached ResourceSet receipt.
 */
export function encodeResourceSet(resourceSet: ResourceSet): ResourceSetDto {
  return ResourceSetDtoSchema.parse(resourceSetState(resourceSet));
}

/**
 * Copies one locally earned proposal into detached transport data.
 * @param proposal - Exact proposal carrying local runtime provenance.
 * @returns Deeply immutable proposal DTO.
 */
export function encodeResourceProposal(proposal: ResourceProposal): ResourceProposalDto {
  return ResourceProposalDtoSchema.parse(resourceProposalState(proposal));
}

/**
 * Copies one locally earned review into detached transport data.
 * @param review - Exact review carrying proposal-bound runtime provenance.
 * @returns Deeply immutable review DTO.
 */
export function encodeResourceReview(review: ResourceReview): ResourceReviewDto {
  return ResourceReviewDtoSchema.parse(resourceReviewState(review));
}

/**
 * Copies one verified admission chain into detached transport data.
 * @param evidence - Exact positive compiler evidence.
 * @returns Deeply immutable portable admission chain.
 */
export function encodeResourceAdmissionChain(evidence: VerifiedResourceAdmission): ResourceAdmissionChain {
  return ResourceAdmissionChainDtoSchema.parse(resourceAdmissionChainState(evidence));
}

/**
 * Copies one verified revocation into detached transport data.
 * @param evidence - Exact negative compiler evidence.
 * @returns Deeply immutable portable revocation fact.
 */
export function encodeResourceRevocation(evidence: VerifiedResourceRevocation): ResourceRevocationDto {
  return ResourceRevocationDtoSchema.parse(resourceRevocationState(evidence));
}
