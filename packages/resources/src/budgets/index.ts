/**
 * @file Defines reusable BudgetPolicy behavior and pure one-step allocation.
 *
 * Policies own only generated-output and wall-time ceilings. They do not count
 * tokens, consume usage, or invent context-window capacity.
 */

import * as z from 'zod';

import {
  CanonicalDecimalSchema,
  Result,
  TimestampSchema,
  UuidV4Schema,
  createUuidV4,
  type ArcherObject,
  type CanonicalDecimal,
  type Result as ResultValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import { modelRef, type Model, type ModelRef } from '@archer/models';

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

/** Prevents unrelated UUIDs from naming a BudgetPolicy. */
declare const budgetPolicyIdBrand: unique symbol;

/** Stable identity shared by every revision of one BudgetPolicy. */
export type BudgetPolicyId = UuidV4 & {
  /** Carries compile-time evidence of BudgetPolicy identity admission. */
  readonly [budgetPolicyIdBrand]: true;
};

/** Prevents policy identity from posing as one exact policy revision. */
declare const budgetPolicyRevisionIdBrand: unique symbol;

/** Identity of one exact immutable BudgetPolicy revision. */
export type BudgetPolicyRevisionId = UuidV4 & {
  /** Carries compile-time evidence of BudgetPolicy revision admission. */
  readonly [budgetPolicyRevisionIdBrand]: true;
};

/** Prevents policy or model UUIDs from posing as one allocation identity. */
declare const budgetAllocationIdBrand: unique symbol;

/** Identity of one exact derived BudgetAllocation fact. */
export type BudgetAllocationId = UuidV4 & {
  /** Carries compile-time evidence of allocation identity admission. */
  readonly [budgetAllocationIdBrand]: true;
};

/** Exact initial BudgetPolicy facts accepted by deterministic application boundaries. */
export type BudgetPolicyCreationContext = ResourceCreationContext<BudgetPolicyId, BudgetPolicyRevisionId>;

/** Exact child facts required by pure BudgetPolicy narrowing. */
export type BudgetPolicyRevisionContext = ResourceRevisionContext<BudgetPolicyRevisionId>;

/** Optional positive ceilings owned by BudgetPolicy and allocation inputs. */
export type BudgetLimitsInput = Readonly<{
  /** Caps generated output tokens when present. */
  outputTokens?: number;

  /** Caps elapsed wall time in milliseconds when present. */
  wallTimeMs?: number;
}>;

/** Backward-compatible domain name retained for existing callers. */
export type BudgetLimits = BudgetLimitsInput;

/** Exact normalized limits retained by a policy. */
export type BudgetPolicyLimits = BudgetLimitsInput;

/** Portable exact reference retained by AgentProfile and BudgetAllocation. */
export type BudgetPolicyRef = Readonly<{
  /** Narrows the Wave 6 Resource family. */
  resource: 'budget-policy';

  /** Stable logical BudgetPolicy identity. */
  id: BudgetPolicyId;

  /** Exact selected immutable revision. */
  revisionId: BudgetPolicyRevisionId;

  /** Human-facing label for interfaces and diagnostics. */
  name: string;

  /** Content identity excludes lifecycle, ancestry, and display metadata. */
  contentDigest: Sha256Digest;
}>;

/** Canonical JSON-safe numeric fields used only at transport boundaries. */
export type BudgetLimitsDto = Readonly<{
  /** Canonical generated-output ceiling when present. */
  outputTokens?: CanonicalDecimal;

  /** Canonical wall-time ceiling when present. */
  wallTimeMs?: CanonicalDecimal;
}>;

/** JSON-safe BudgetPolicy state emitted at transport boundaries. */
export type BudgetPolicyDto = ResourceRevision<'budget-policy', BudgetPolicyId, BudgetPolicyRevisionId> &
  Readonly<{
    /** Narrows the Wave 6 Resource family. */
    resource: 'budget-policy';

    /** Canonical exact policy ceilings. */
    limits: BudgetLimitsDto;
  }>;

/** One derived finite allocation ready for request preparation. */
export type BudgetAllocation = ArcherObject<'budget-allocation', BudgetAllocationId> &
  Readonly<{
    /** Exact policy revision participating in the decision. */
    policy: BudgetPolicyRef;

    /** Exact selected Model evidence contributing the output ceiling. */
    model: ModelRef;

    /** Optional exact parent allocation contributing delegated authority. */
    parentId?: BudgetAllocationId;

    /** Mandatory effective generated-output ceiling. */
    outputTokens: number;

    /** Trusted operation start retained for deadline interpretation. */
    startedAt: Timestamp;

    /** Optional absolute deadline after every wall-time intersection. */
    deadline?: Timestamp;
  }>;

/** Inputs reconciled by pure Budget allocation. */
export type AllocateBudgetInput = Readonly<{
  /** Fresh identity for the derived allocation fact. */
  allocationId: BudgetAllocationId;

  /** Exact behavior-bearing policy whose ceilings participate. */
  policy: BudgetPolicy;

  /** Selected Model whose declared output ceiling always participates. */
  model: Model;

  /** Optional caller demand that may narrow but never widen available bounds. */
  request?: BudgetLimitsInput;

  /** Optional exact parent allocation delegated to this step. */
  parent?: BudgetAllocation;

  /** Optional application hard limits outside the reusable policy. */
  applicationLimits?: BudgetLimitsInput;

  /** Trusted operation start used to derive absolute deadline. */
  startedAt: Timestamp;
}>;

/** Stable dimensions used by validation and refusal precedence. */
type BudgetDimension = 'outputTokens' | 'wallTimeMs';

/** Stable authority sources used by widening evidence. */
type BudgetBoundSource = 'policy' | 'parent' | 'application' | 'model';

/** Positive safe integer boundary used by every numeric Budget input. */
const PositiveSafeIntegerSchema = z
  .number()
  .refine(Number.isSafeInteger, { message: 'Expected a safe integer' })
  .positive();

/** Optional exact limits boundary reused by policy and allocation inputs. */
const BudgetLimitsSchema = z
  .strictObject({
    outputTokens: PositiveSafeIntegerSchema.optional(),
    wallTimeMs: PositiveSafeIntegerSchema.optional(),
  })
  .transform((value) =>
    Object.freeze({
      ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
      ...(value.wallTimeMs === undefined ? {} : { wallTimeMs: value.wallTimeMs }),
    }),
  );

/** Runtime-only token prevents ordinary callers from invoking the class constructor. */
const BUDGET_CONSTRUCTION = Symbol('archer.budget.construction');

/** Runtime provenance distinguishes BudgetPolicy behavior from serialized field copies. */
const ADMITTED_BUDGET_POLICIES = new WeakSet<object>();

/** Runtime provenance prevents copied allocation fields from becoming delegated Budget authority. */
const ADMITTED_BUDGET_ALLOCATIONS = new WeakSet<object>();

/**
 * Admits optional positive limits and optionally requires at least one dimension.
 * @param input - Untrusted proposed numeric limits.
 * @param requireOne - Whether an empty limit set is illegal.
 * @returns Frozen normalized limits.
 */
function admitLimits(input: BudgetLimitsInput, requireOne: boolean): BudgetPolicyLimits {
  try {
    /** Normalizes caller values before the separate at-least-one-dimension invariant runs. */
    const limits = BudgetLimitsSchema.parse(input);
    if (requireOne && limits.outputTokens === undefined && limits.wallTimeMs === undefined) {
      throw new ResourcesError('budget_policy_empty', 'BudgetPolicy requires at least one ceiling');
    }
    return limits;
  } catch (cause) {
    if (cause instanceof ResourcesError) throw cause;
    throw new ResourcesError('budget_limit_invalid', 'Budget limit must be a positive safe integer', { cause });
  }
}

/**
 * Converts one safe integer to its canonical decimal transport representation.
 * @param value - Positive safe integer already admitted by the Budget domain.
 * @returns Canonical base-10 text without leading zeroes.
 */
function encodeLimit(value: number): CanonicalDecimal {
  return CanonicalDecimalSchema.parse(String(value));
}

/**
 * Converts canonical decimal transport text into a JavaScript-safe integer.
 * @param value - Canonical non-negative decimal text from a DTO.
 * @returns Positive safe integer admitted by the Budget domain.
 */
function decodeLimit(value: CanonicalDecimal): number {
  /** Converts only canonical transport text back into a JavaScript-safe budget value. */
  const parsed = Number(CanonicalDecimalSchema.parse(value));
  return PositiveSafeIntegerSchema.parse(parsed);
}

/**
 * Projects one exact BudgetPolicy reference without exposing behavior internals.
 * @param policy - Behavior-bearing policy whose revision is selected.
 * @returns Frozen portable exact reference.
 */
export function budgetPolicyRef(policy: BudgetPolicy): BudgetPolicyRef {
  if (!ADMITTED_BUDGET_POLICIES.has(policy)) {
    throw new ResourcesError('resources_invalid_budget', 'BudgetPolicy reference requires admitted behavior');
  }
  return Object.freeze({
    resource: 'budget-policy',
    id: policy.id,
    revisionId: policy.revisionId,
    name: policy.name,
    contentDigest: policy.contentDigest,
  });
}

/** Immutable reusable policy that owns narrowing and allocation decisions. */
export class BudgetPolicy implements ResourceRevision<'budget-policy', BudgetPolicyId, BudgetPolicyRevisionId> {
  /** Stable logical BudgetPolicy identity. */
  readonly id: BudgetPolicyId;

  /** Stable wire discriminator. */
  readonly object = 'budget-policy' as const;

  /** Narrows the Wave 6 Resource family. */
  readonly resource = 'budget-policy' as const;

  /** First creation instant shared by all revisions. */
  readonly createdAt: Timestamp;

  /** Human-facing reusable policy name. */
  readonly name: string;

  /** Exact immutable revision identity. */
  readonly revisionId: BudgetPolicyRevisionId;

  /** One-based revision sequence. */
  readonly revision: number;

  /** Exact parent revision when behavior earned a child. */
  readonly previousRevisionId?: BudgetPolicyRevisionId;

  /** Instant this exact revision was earned. */
  readonly updatedAt: Timestamp;

  /** Optional exact positive ceilings owned by this policy. */
  readonly ceilings: BudgetPolicyLimits;

  /** Deterministic identity over numeric policy behavior only. */
  readonly contentDigest: Sha256Digest;

  /**
   * Installs already-admitted policy state; ordinary callers use a policy factory.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param limits - At-least-one admitted positive ceiling.
   */
  protected constructor(
    token: typeof BUDGET_CONSTRUCTION,
    identity: RevisionIdentity<'budget-policy', BudgetPolicyId, BudgetPolicyRevisionId>,
    limits: BudgetPolicyLimits,
  ) {
    if (token !== BUDGET_CONSTRUCTION) throw new TypeError('Use a BudgetPolicy factory');
    this.id = identity.id;
    this.createdAt = identity.createdAt;
    this.name = identity.name;
    this.revisionId = identity.revisionId;
    this.revision = identity.revision;
    if (identity.previousRevisionId !== undefined) this.previousRevisionId = identity.previousRevisionId;
    this.updatedAt = identity.updatedAt;
    this.ceilings = admitLimits(limits, true);
    this.contentDigest = resourceDigest('archer.budget-policy.v1', { limits: this.ceilings });
    ADMITTED_BUDGET_POLICIES.add(this);
    Object.freeze(this);
  }

  /**
   * Earns a child whose supplied ceilings never widen this exact parent.
   * @param proposed - Partial ceilings; omitted dimensions inherit from the parent.
   * @param context - Fresh revision identity and trusted observed time.
   * @returns Child policy or exact widening/no-change refusal.
   */
  narrow(proposed: BudgetLimitsInput, context: BudgetPolicyRevisionContext): ResultValue<BudgetPolicy, ResourcesError> {
    return narrowBudgetPolicy(this, proposed, context);
  }

  /**
   * Allocates one step using this exact policy.
   * @param input - Allocation facts excluding the already-bound policy.
   * @returns Exact allocation or deterministic refusal.
   */
  allocate(input: Omit<AllocateBudgetInput, 'policy'>): ResultValue<BudgetAllocation, ResourcesError> {
    return allocateBudget({ ...input, policy: this });
  }

  /**
   * Emits JSON-safe exact state for an API, database, or asynchronous update boundary.
   * @returns Frozen DTO with canonical decimal limits.
   */
  toJSON(): BudgetPolicyDto {
    if (!ADMITTED_BUDGET_POLICIES.has(this)) {
      throw new ResourcesError('resources_invalid_budget', 'BudgetPolicy serialization requires admitted behavior');
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
      limits: Object.freeze({
        ...(this.ceilings.outputTokens === undefined ? {} : { outputTokens: encodeLimit(this.ceilings.outputTokens) }),
        ...(this.ceilings.wallTimeMs === undefined ? {} : { wallTimeMs: encodeLimit(this.ceilings.wallTimeMs) }),
      }),
      contentDigest: this.contentDigest,
    });
  }
}

/** Package-local concrete policy keeps the public class non-constructible in TypeScript. */
class InstalledBudgetPolicy extends BudgetPolicy {
  /**
   * Delegates admitted state to BudgetPolicy's runtime-token-checked constructor.
   * @param token - Module-private construction authority.
   * @param identity - Exact Resource revision identity.
   * @param limits - Admitted at-least-one positive ceiling.
   */
  constructor(
    token: typeof BUDGET_CONSTRUCTION,
    identity: RevisionIdentity<'budget-policy', BudgetPolicyId, BudgetPolicyRevisionId>,
    limits: BudgetPolicyLimits,
  ) {
    super(token, identity, limits);
  }
}

/**
 * Defines one reusable BudgetPolicy with no unrelated implicit dimensions.
 * @param input - At-least-one positive ceiling and optional display label.
 * @param context - Optional deterministic initial identity and time.
 * @returns Immutable policy ready to narrow and allocate.
 */
export function defineBudgetPolicy(
  input: BudgetLimitsInput &
    Readonly<{
      /** Keeps a display label optional because omitted names are derived after identity exists. */
      name?: string;
    }>,
  context?: BudgetPolicyCreationContext,
): BudgetPolicy {
  try {
    /** Separates display metadata from the behavior limits used for content identity. */
    const { name, ...proposed } = input;
    /** Admits both dimensions without installing a default the caller did not request. */
    const limits = admitLimits(proposed, true);
    /** Resolves identity and trusted time once before any immutable state is constructed. */
    const facts = initialResourceContext(context);
    /** Generates an omitted name once so later revisions preserve the same human label. */
    const identity = createInitialRevisionIdentity('budget-policy', name?.trim() || resourcePetname(facts.id), facts);
    return new InstalledBudgetPolicy(BUDGET_CONSTRUCTION, identity, limits);
  } catch (cause) {
    if (cause instanceof ResourcesError) throw cause;
    throw new ResourcesError('resources_invalid_budget', 'Invalid BudgetPolicy definition', { cause });
  }
}

/**
 * Narrows an exact parent without persistence, hidden time, or hidden identity.
 * @param parent - Exact admitted parent BudgetPolicy.
 * @param requested - Partial child ceilings; omitted dimensions inherit.
 * @param context - Fresh child identity and trusted observed time.
 * @returns Child policy or exact widening/no-change refusal.
 */
export function narrowBudgetPolicy(
  parent: BudgetPolicy,
  requested: BudgetLimitsInput,
  context: BudgetPolicyRevisionContext,
): ResultValue<BudgetPolicy, ResourcesError> {
  if (!ADMITTED_BUDGET_POLICIES.has(parent)) {
    return Result.error(new ResourcesError('resources_invalid_budget', 'Budget narrowing requires admitted behavior'));
  }
  try {
    /** Validates proposed child limits before comparing them with the exact parent. */
    const proposed = admitLimits(requested, false);
    /** Parent dimensions are inherited unless a legal child value replaces them. */
    const next: BudgetPolicyLimits = Object.freeze({
      ...((proposed.outputTokens ?? parent.ceilings.outputTokens) === undefined
        ? {}
        : { outputTokens: proposed.outputTokens ?? parent.ceilings.outputTokens }),
      ...((proposed.wallTimeMs ?? parent.ceilings.wallTimeMs) === undefined
        ? {}
        : { wallTimeMs: proposed.wallTimeMs ?? parent.ceilings.wallTimeMs }),
    });
    /** Stable dimension order makes widening evidence deterministic. */
    for (const dimension of ['outputTokens', 'wallTimeMs'] as const) {
      /** Reads the parent ceiling separately so an omitted child dimension can inherit it. */
      const prior = parent.ceilings[dimension];
      /** Distinguishes an omitted override from an explicit proposed ceiling. */
      const value = proposed[dimension];
      if (prior !== undefined && value !== undefined && value > prior) {
        return Result.error(
          new ResourcesError('budget_widening_refused', 'A child BudgetPolicy cannot widen its parent', {
            details: { dimension, current: prior, proposed: value },
          }),
        );
      }
    }
    if (next.outputTokens === parent.ceilings.outputTokens && next.wallTimeMs === parent.ceilings.wallTimeMs) {
      return Result.error(
        new ResourcesError('resources_budget_no_change', 'BudgetPolicy narrowing must change a ceiling'),
      );
    }
    /** Mints child ancestry only after every dimension proves it does not widen authority. */
    const identity = createRevisionIdentity('budget-policy', parent.name, parent, context);
    return Result.ok(new InstalledBudgetPolicy(BUDGET_CONSTRUCTION, identity, next));
  } catch (cause) {
    /** Preserves exact Budget errors while bounding malformed revision input uniformly. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('budget_limit_invalid', 'Invalid BudgetPolicy narrowing', { cause });
    return Result.error(error);
  }
}

/**
 * Returns the first widening source for one demanded dimension.
 * @param dimension - Stable Budget dimension under comparison.
 * @param requested - Explicit caller demand.
 * @param bounds - Bounds in deterministic authority precedence.
 * @returns The first source the demand widens, or undefined when legal.
 */
function widenedSource(
  dimension: BudgetDimension,
  requested: number,
  bounds: readonly Readonly<{
    /** Identifies the enclosing authority whose ceiling may be exceeded. */
    source: BudgetBoundSource;
    /** Supplies that authority's optional ceiling for the selected dimension. */
    value?: number;
  }>[],
):
  | Readonly<{
      /** Identifies the first enclosing authority widened by the request. */
      source: BudgetBoundSource;
      /** Reports the exact existing ceiling that the request exceeded. */
      value: number;
    }>
  | undefined {
  /** Checks enclosing bounds in documented refusal order and stops at the first widening. */
  for (const bound of bounds) {
    if (bound.value !== undefined && requested > bound.value) {
      return Object.freeze({ source: bound.source, value: bound.value });
    }
  }
  return undefined;
}

/**
 * Adds a positive duration to a trusted instant without permitting Date overflow.
 * @param startedAt - Canonical operation start instant.
 * @param durationMs - Positive safe integer elapsed ceiling.
 * @returns Canonical absolute deadline or an overflow refusal.
 */
function deadlineFromDuration(startedAt: Timestamp, durationMs: number): ResultValue<Timestamp, ResourcesError> {
  /** Uses epoch arithmetic only after timestamp and duration admission to detect overflow exactly. */
  const deadlineMs = Date.parse(startedAt) + durationMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > 8_640_000_000_000_000) {
    return Result.error(new ResourcesError('budget_deadline_overflow', 'Budget deadline exceeds timestamp range'));
  }
  try {
    return Result.ok(TimestampSchema.parse(new Date(deadlineMs).toISOString()));
  } catch (cause) {
    return Result.error(
      new ResourcesError('budget_deadline_overflow', 'Budget deadline exceeds timestamp range', { cause }),
    );
  }
}

/**
 * Reconciles exact bounds into one generated-output ceiling and optional deadline.
 * @param input - Policy, request, parent, application, model, identity, and trusted start facts.
 * @returns Deeply immutable allocation or deterministic widening/expiry refusal.
 */
export function allocateBudget(input: AllocateBudgetInput): ResultValue<BudgetAllocation, ResourcesError> {
  if (!ADMITTED_BUDGET_POLICIES.has(input.policy)) {
    return Result.error(new ResourcesError('resources_invalid_budget', 'Budget allocation requires admitted behavior'));
  }
  try {
    /** Runtime UUID admission keeps lower-level allocation calls honest across JavaScript boundaries. */
    const allocationId = UuidV4Schema.parse(input.allocationId) as BudgetAllocationId;
    if (input.parent !== undefined && !ADMITTED_BUDGET_ALLOCATIONS.has(input.parent)) {
      return Result.error(
        new ResourcesError(
          'resources_invalid_budget_allocation',
          'Parent BudgetAllocation requires allocation behavior provenance',
        ),
      );
    }
    /** Requires admitted Model behavior before its output ceiling participates in allocation. */
    const selectedModel = modelRef(input.model);
    /** Normalizes the explicit trusted start once so every derived deadline shares one instant. */
    const startedAt = TimestampSchema.parse(input.startedAt);
    /** Admits caller demands without confusing omission with a zero-token request. */
    const request = admitLimits(input.request ?? {}, false);
    /** Admits application hard limits independently from reusable policy limits. */
    const application = admitLimits(input.applicationLimits ?? {}, false);
    if (input.parent?.deadline !== undefined && input.parent.deadline <= startedAt) {
      return Result.error(
        new ResourcesError('budget_parent_expired', 'Parent BudgetAllocation deadline has elapsed', {
          details: { parentId: input.parent.id, deadline: input.parent.deadline, startedAt },
        }),
      );
    }
    /** Parent absolute deadline converts to a comparable remaining duration. */
    const parentWallTime =
      input.parent?.deadline === undefined ? undefined : Date.parse(input.parent.deadline) - Date.parse(startedAt);
    /** Every explicit request dimension is a demand checked in source precedence. */
    for (const dimension of ['outputTokens', 'wallTimeMs'] as const) {
      /** Skips absent caller dimensions because only explicit demands can constitute widening. */
      const demanded = request[dimension];
      if (demanded === undefined) continue;
      /** Parent authority uses remaining output or remaining duration for the selected dimension. */
      const parentBound = dimension === 'outputTokens' ? input.parent?.outputTokens : parentWallTime;
      /** Finds the first violated authority source using the stable policy-to-model precedence. */
      const widened = widenedSource(dimension, demanded, [
        {
          source: 'policy',
          ...(input.policy.ceilings[dimension] === undefined ? {} : { value: input.policy.ceilings[dimension] }),
        },
        {
          source: 'parent',
          ...(parentBound === undefined ? {} : { value: parentBound }),
        },
        {
          source: 'application',
          ...(application[dimension] === undefined ? {} : { value: application[dimension] }),
        },
        {
          source: 'model',
          ...(dimension === 'outputTokens' ? { value: input.model.maxOutputTokens } : {}),
        },
      ]);
      if (widened !== undefined) {
        return Result.error(
          new ResourcesError('budget_request_widens_bound', 'Requested Budget widens available authority', {
            details: {
              source: widened.source,
              dimension,
              requested: demanded,
              bound: widened.value,
            },
          }),
        );
      }
    }
    /** Model output capacity makes the effective generated-output ceiling mandatory. */
    const outputTokens = Math.min(
      ...[
        request.outputTokens,
        input.policy.ceilings.outputTokens,
        input.parent?.outputTokens,
        application.outputTokens,
        input.model.maxOutputTokens,
      ].filter((value): value is number => value !== undefined),
    );
    /** Durations become absolute deadlines before parent intersection. */
    const durationCandidates = [request.wallTimeMs, input.policy.ceilings.wallTimeMs, application.wallTimeMs].filter(
      (value): value is number => value !== undefined,
    );
    /** Remains absent when no wall-time source contributes a deadline. */
    let deadline: Timestamp | undefined;
    if (durationCandidates.length > 0) {
      /** Derives one deadline from the tightest relative duration before intersecting parent time. */
      const derived = deadlineFromDuration(startedAt, Math.min(...durationCandidates));
      if (!derived.ok) return derived;
      deadline = derived.value;
    }
    if (input.parent?.deadline !== undefined && (deadline === undefined || input.parent.deadline < deadline)) {
      deadline = input.parent.deadline;
    }
    /** The complete allocation earns parent authority only after every contributing bound succeeds. */
    const allocation = Object.freeze({
      id: allocationId,
      object: 'budget-allocation' as const,
      createdAt: startedAt,
      policy: budgetPolicyRef(input.policy),
      model: selectedModel,
      ...(input.parent === undefined ? {} : { parentId: input.parent.id }),
      outputTokens,
      startedAt,
      ...(deadline === undefined ? {} : { deadline }),
    });
    ADMITTED_BUDGET_ALLOCATIONS.add(allocation);
    return Result.ok(allocation);
  } catch (cause) {
    /** Returns exact Budget failures while converting malformed boundary input into one stable error. */
    const error =
      cause instanceof ResourcesError
        ? cause
        : new ResourcesError('resources_invalid_budget_allocation', 'Invalid Budget allocation input', { cause });
    return Result.error(error);
  }
}

/**
 * Reconstructs admitted BudgetPolicy state after transport and parent checks.
 * @param dto - Transport-validated exact policy state.
 * @returns Behavior-bearing policy with persisted identity.
 * @internal
 */
export function hydrateBudgetPolicyState(dto: BudgetPolicyDto): BudgetPolicy {
  /** Decodes portable decimal ceilings before restoring behavior provenance. */
  const limits = admitLimits(
    {
      ...(dto.limits.outputTokens === undefined ? {} : { outputTokens: decodeLimit(dto.limits.outputTokens) }),
      ...(dto.limits.wallTimeMs === undefined ? {} : { wallTimeMs: decodeLimit(dto.limits.wallTimeMs) }),
    },
    true,
  );
  /** Reconstructs lineage fields exactly; hydration must not mint new identity or time. */
  const identity: RevisionIdentity<'budget-policy', BudgetPolicyId, BudgetPolicyRevisionId> = Object.freeze({
    object: dto.object,
    id: dto.id,
    revisionId: dto.revisionId,
    revision: dto.revision,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...(dto.previousRevisionId === undefined ? {} : { previousRevisionId: dto.previousRevisionId }),
    name: dto.name,
  });
  /** Constructs behavior before comparing its canonical content identity with transported evidence. */
  const policy = new InstalledBudgetPolicy(BUDGET_CONSTRUCTION, identity, limits);
  if (policy.contentDigest !== dto.contentDigest) {
    throw new ResourcesError(
      'resources_hydration_failed',
      'BudgetPolicy DTO content does not match its content digest',
    );
  }
  return policy;
}

/**
 * Generates ordinary allocation identity for advanced callers that already own the allocation boundary.
 * @returns Fresh UUIDv4 narrowed to BudgetAllocation identity.
 */
export function createBudgetAllocationId(): BudgetAllocationId {
  return createUuidV4() as BudgetAllocationId;
}
