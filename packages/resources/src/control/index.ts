/** @file Defines portable review facts and pure reviewed ResourceSet compilation. */

import {
  Result,
  Sha256DigestSchema,
  TimestampSchema,
  UuidV4Schema,
  type ArcherObject,
  type Result as ResultValue,
  type Sha256Digest,
  type Timestamp,
  type UuidV4,
} from '@archer/core';
import { PrincipalIdSchema, type PrincipalId } from '@archer/core/authority';
import { modelRef, type Model, type ModelRef } from '@archer/models';
import * as z from 'zod';

import { type BudgetPolicy, budgetPolicyRef, type BudgetPolicyRef } from '../budgets/index.js';
import { ResourcesError } from '../errors.js';
import { type AgentProfile } from '../profiles/index.js';
import { type Prompt, promptRef, type PromptRef } from '../prompts/index.js';
import {
  compileResourceSetFromProfile,
  type ResourceSet,
  type ResourceSetAdmission,
  type ResourceSetCreationContext,
} from '../session.js';
import { type Skill, skillRef, type SkillRef } from '../skills/index.js';

/** Resource kinds implemented by the current review boundary. */
export type ResourceKind = 'model' | 'prompt' | 'skill' | 'budget-policy';

/** Behavior-bearing immutable revisions eligible for independent review. */
export type ResourceCandidate = Model | Prompt | Skill | BudgetPolicy;

/** Exact kind-discriminated revision reference carried by every control fact. */
export type ResourceControlRef = Readonly<{
  /** Selects the owning Resource domain. */
  kind: ResourceKind;

  /** Stable logical identity shared by the Resource's revisions. */
  id: UuidV4;

  /** Exact immutable revision under review or admission. */
  revisionId: UuidV4;

  /** Human-facing label retained for operator interfaces. */
  name: string;

  /** Behavior-bearing content identity preventing UUID reuse from hiding changes. */
  contentDigest: Sha256Digest;
}>;

/** Prevents an unrelated UUID from naming a Resource proposal fact. */
declare const resourceProposalIdBrand: unique symbol;

/** Stable identity of one immutable proposal. */
export type ResourceProposalId = UuidV4 & {
  /** Carries compile-time evidence of proposal identity admission. */
  readonly [resourceProposalIdBrand]: true;
};

/** Prevents proposal identity from posing as a review fact. */
declare const resourceReviewIdBrand: unique symbol;

/** Stable identity of one immutable independent review. */
export type ResourceReviewId = UuidV4 & {
  /** Carries compile-time evidence of review identity admission. */
  readonly [resourceReviewIdBrand]: true;
};

/** Prevents review identity from posing as an admission fact. */
declare const resourceAdmissionIdBrand: unique symbol;

/** Stable identity of one immutable Resource admission. */
export type ResourceAdmissionId = UuidV4 & {
  /** Carries compile-time evidence of admission identity admission. */
  readonly [resourceAdmissionIdBrand]: true;
};

/** Prevents admission identity from posing as a revocation fact. */
declare const resourceRevocationIdBrand: unique symbol;

/** Stable identity of one immutable Resource revocation. */
export type ResourceRevocationId = UuidV4 & {
  /** Carries compile-time evidence of revocation identity admission. */
  readonly [resourceRevocationIdBrand]: true;
};

/** Immutable attribution that submits one exact Resource revision for review. */
export type ResourceProposalState = ArcherObject<'resource-proposal', ResourceProposalId> &
  Readonly<{
    /** Exact kind-discriminated Resource revision proposed. */
    resource: ResourceControlRef;

    /** Actor attributable to the proposal without implying permission. */
    proposedBy: PrincipalId;
  }>;

/** Prevents restored proposal data from satisfying a locally earned proposal capability. */
declare const resourceProposalBrand: unique symbol;

/** Exact proposal object created by this module's ordinary behavior path. */
export type ResourceProposal = ResourceProposalState &
  Readonly<{
    /** Compile-time evidence complements the runtime proposal provenance set. */
    readonly [resourceProposalBrand]: true;
  }>;

/** Immutable independent decision over one exact Resource proposal. */
export type ResourceReviewState = ArcherObject<'resource-review', ResourceReviewId> &
  Readonly<{
    /** Proposal identity consumed by this decision. */
    proposalId: ResourceProposalId;

    /** Exact proposed revision repeated so no hidden join is needed for verification. */
    resource: ResourceControlRef;

    /** Proposal actor retained so separation of duty survives transport. */
    proposedBy: PrincipalId;

    /** Independent actor attributable to the review decision. */
    reviewedBy: PrincipalId;

    /** Explicit passing or rejecting decision. */
    decision: 'approve' | 'reject';

    /** Optional bounded operator context. */
    reason?: string;
  }>;

/** Prevents restored review data from satisfying a locally earned review capability. */
declare const resourceReviewBrand: unique symbol;

/** Exact review object created from one locally admitted proposal. */
export type ResourceReview = ResourceReviewState &
  Readonly<{
    /** Compile-time evidence complements the runtime review-to-proposal binding. */
    readonly [resourceReviewBrand]: true;
  }>;

/** Immutable fact making one exactly reviewed revision eligible for compilation. */
export type ResourceAdmissionState = ArcherObject<'resource-admission', ResourceAdmissionId> &
  Readonly<{
    /** Exact Resource revision made eligible. */
    resource: ResourceControlRef;

    /** Passing review consumed by this admission. */
    reviewId: ResourceReviewId;

    /** Actor attributable to the admission without embedding authority. */
    admittedBy: PrincipalId;
  }>;

/** Immutable fact blocking one admission from future reviewed compilation. */
export type ResourceRevocationState = ArcherObject<'resource-revocation', ResourceRevocationId> &
  Readonly<{
    /** Exact admission made ineligible. */
    admissionId: ResourceAdmissionId;

    /** Resource reference repeated for self-contained inspection. */
    resource: ResourceControlRef;

    /** Actor attributable to the revocation decision. */
    revokedBy: PrincipalId;

    /** Optional bounded operator context. */
    reason?: string;
  }>;

/** Prevents detached revocation data from denying compiler-positive admission evidence. */
declare const verifiedResourceRevocationBrand: unique symbol;

/** Process-local proof that one revocation targets an exact verified admission. */
export type VerifiedResourceRevocation = ResourceRevocationState &
  Readonly<{
    /** Carries compile-time proof available only from revocation admission paths. */
    readonly [verifiedResourceRevocationBrand]: true;
  }>;

/** Input for one independent Resource review. */
export type ReviewResourceInput = Readonly<{
  /** Actor making the decision; it must differ from the proposer. */
  reviewedBy: PrincipalId;

  /** Passing or rejecting decision over the exact proposal. */
  decision: 'approve' | 'reject';

  /** Optional bounded operator context. */
  reason?: string;
}>;

/** Exact identity and trusted time supplied when pure control behavior earns one fact. */
export type ResourceControlFactContext<Id extends UuidV4> = Readonly<{
  /** Fresh UUIDv4 for the immutable lifecycle fact. */
  id: Id;

  /** Trusted instant at which the lifecycle decision was recorded. */
  createdAt: Timestamp;
}>;

/** Complete portable provenance required to restore one admission as positive evidence. */
export type ResourceAdmissionChain = Readonly<{
  /** Original proposal attributed to the application-recognized proposer. */
  proposal: ResourceProposalState;

  /** Independent passing review linked to the proposal. */
  review: ResourceReviewState;

  /** Admission linked to that exact review and Resource revision. */
  admission: ResourceAdmissionState;
}>;

/** Prevents transport records from satisfying compiler-positive evidence structurally. */
declare const verifiedResourceAdmissionBrand: unique symbol;

/** Process-local proof that one complete Resource admission chain passed a trusted boundary. */
export type VerifiedResourceAdmission = ResourceAdmissionChain &
  Readonly<{
    /** Carries compile-time proof available only from this module's admission paths. */
    readonly [verifiedResourceAdmissionBrand]: true;
  }>;

/** Application-owned authenticity decision for a restored portable admission chain. */
export type VerifyResourceAdmissionProvenance = (chain: ResourceAdmissionChain) => boolean | Promise<boolean>;

/** Application-owned authenticity decision for one restored portable revocation fact. */
export type VerifyResourceRevocationProvenance = (revocation: ResourceRevocationState) => boolean | Promise<boolean>;

/** Complete current fact slice accepted by reviewed ResourceSet compilation. */
export type CompileReviewedResourceSetInput = Readonly<{
  /** Legal behavior-bearing profile whose exact selections are compiled. */
  profile: AgentProfile;

  /** Visible immutable admissions; collection order has no meaning. */
  admissions: readonly VerifiedResourceAdmission[];

  /** Visible current revocations; omitted when no admissions were revoked. */
  revocations?: readonly VerifiedResourceRevocation[];

  /** Exact identity and trusted time for the compiled ResourceSet fact. */
  context: ResourceSetCreationContext;
}>;

/** Runtime provenance recognizes only exact proposals created by ordinary control behavior. */
const ADMITTED_RESOURCE_PROPOSALS = new WeakSet<object>();

/** Exact-object binding prevents a review from being replayed with a copied proposal. */
const ADMITTED_RESOURCE_REVIEWS = new WeakMap<object, ResourceProposal>();

/** Private canonical chains, rather than caller-facing fields, authorize compilation and revocation. */
const VERIFIED_RESOURCE_ADMISSIONS = new WeakMap<object, ResourceAdmissionChain>();

/** Private canonical revocations, rather than copied fields, authorize negative compiler evidence. */
const VERIFIED_RESOURCE_REVOCATIONS = new WeakMap<object, ResourceRevocationState>();

/** Operator context boundary shared by reviews and revocations. */
const ReasonSchema = z.string().trim().min(1).max(1024);

/** Runtime review decision boundary prevents nominal casts from entering durable facts. */
const ReviewDecisionSchema = z.enum(['approve', 'reject']);

/** Runtime Resource-kind boundary shared by restored control references. */
const ResourceKindSchema = z.enum(['model', 'prompt', 'skill', 'budget-policy']);

/** Human-facing Resource label boundary retained in self-contained control facts. */
const ResourceControlNameSchema = z.string().trim().min(1).max(256);

/**
 * Projects one behavior-bearing revision into a kind-discriminated control reference.
 * @param resource - Exact immutable Resource revision.
 * @returns Frozen portable reference with no behavior or secret-bearing client.
 */
export function resourceControlRef(resource: ResourceCandidate): ResourceControlRef {
  switch (resource.object) {
    case 'model':
      return controlRef('model', modelRef(resource));
    case 'prompt':
      return controlRef('prompt', promptRef(resource));
    case 'skill':
      return controlRef('skill', skillRef(resource));
    case 'budget-policy':
      return controlRef('budget-policy', budgetPolicyRef(resource));
  }
}

/**
 * Adds a Resource discriminator without retaining subtype-specific reference fields.
 * @param kind - Owning Resource domain.
 * @param reference - Existing exact immutable reference.
 * @returns Uniform portable control reference.
 */
function controlRef(
  kind: ResourceKind,
  reference: ModelRef | PromptRef | SkillRef | BudgetPolicyRef,
): ResourceControlRef {
  return Object.freeze({
    kind,
    id: reference.id,
    revisionId: reference.revisionId,
    name: reference.name,
    contentDigest: reference.contentDigest,
  });
}

/**
 * Compares behavior-bearing identity without trusting display metadata.
 * @param left - First exact control reference.
 * @param right - Second exact control reference.
 * @returns Whether both name the same kind, revision UUID pair, and content digest.
 */
function sameResource(left: ResourceControlRef, right: ResourceControlRef): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.revisionId === right.revisionId &&
    left.contentDigest === right.contentDigest
  );
}

/**
 * Creates the shared immutable fact envelope from explicit identity and time facts.
 * @param object - Stable lifecycle fact discriminator.
 * @param context - Caller-supplied fresh identity and trusted creation time.
 * @returns Validated fact identity, object discriminator, and canonical creation time.
 */
function factEnvelope<ObjectName extends string, Id extends UuidV4>(
  object: ObjectName,
  context: ResourceControlFactContext<Id>,
): ArcherObject<ObjectName, Id> {
  return Object.freeze({
    id: UuidV4Schema.parse(context.id) as Id,
    object,
    createdAt: TimestampSchema.parse(context.createdAt),
  });
}

/**
 * Copies and admits one restored control reference without invoking a transport codec.
 * @param reference - Proposed self-contained Resource identity.
 * @returns Frozen intrinsic control state with admitted scalar fields.
 */
function copyControlRef(reference: ResourceControlRef): ResourceControlRef {
  return Object.freeze({
    kind: ResourceKindSchema.parse(reference.kind),
    id: UuidV4Schema.parse(reference.id),
    revisionId: UuidV4Schema.parse(reference.revisionId),
    name: ResourceControlNameSchema.parse(reference.name),
    contentDigest: Sha256DigestSchema.parse(reference.contentDigest),
  });
}

/**
 * Copies one proposal into admitted intrinsic domain state.
 * @param proposal - Locally earned or transport-admitted proposal fields.
 * @returns Detached deeply immutable proposal state.
 */
function copyProposalState(proposal: ResourceProposalState): ResourceProposalState {
  return Object.freeze({
    ...factEnvelope('resource-proposal', {
      id: UuidV4Schema.parse(proposal.id) as ResourceProposalId,
      createdAt: TimestampSchema.parse(proposal.createdAt),
    }),
    resource: copyControlRef(proposal.resource),
    proposedBy: PrincipalIdSchema.parse(proposal.proposedBy),
  });
}

/**
 * Copies one review into admitted intrinsic domain state.
 * @param review - Locally earned or transport-admitted review fields.
 * @returns Detached deeply immutable review state.
 */
function copyReviewState(review: ResourceReviewState): ResourceReviewState {
  return Object.freeze({
    ...factEnvelope('resource-review', {
      id: UuidV4Schema.parse(review.id) as ResourceReviewId,
      createdAt: TimestampSchema.parse(review.createdAt),
    }),
    proposalId: UuidV4Schema.parse(review.proposalId) as ResourceProposalId,
    resource: copyControlRef(review.resource),
    proposedBy: PrincipalIdSchema.parse(review.proposedBy),
    reviewedBy: PrincipalIdSchema.parse(review.reviewedBy),
    decision: ReviewDecisionSchema.parse(review.decision),
    ...(review.reason === undefined ? {} : { reason: ReasonSchema.parse(review.reason) }),
  });
}

/**
 * Copies one admission into admitted intrinsic domain state.
 * @param admission - Locally earned or transport-admitted admission fields.
 * @returns Detached deeply immutable admission state.
 */
function copyAdmissionState(admission: ResourceAdmissionState): ResourceAdmissionState {
  return Object.freeze({
    ...factEnvelope('resource-admission', {
      id: UuidV4Schema.parse(admission.id) as ResourceAdmissionId,
      createdAt: TimestampSchema.parse(admission.createdAt),
    }),
    resource: copyControlRef(admission.resource),
    reviewId: UuidV4Schema.parse(admission.reviewId) as ResourceReviewId,
    admittedBy: PrincipalIdSchema.parse(admission.admittedBy),
  });
}

/**
 * Copies one revocation into admitted intrinsic domain state.
 * @param revocation - Locally earned or transport-admitted revocation fields.
 * @returns Detached deeply immutable revocation state.
 */
function copyRevocationState(revocation: ResourceRevocationState): ResourceRevocationState {
  return Object.freeze({
    ...factEnvelope('resource-revocation', {
      id: UuidV4Schema.parse(revocation.id) as ResourceRevocationId,
      createdAt: TimestampSchema.parse(revocation.createdAt),
    }),
    admissionId: UuidV4Schema.parse(revocation.admissionId) as ResourceAdmissionId,
    resource: copyControlRef(revocation.resource),
    revokedBy: PrincipalIdSchema.parse(revocation.revokedBy),
    ...(revocation.reason === undefined ? {} : { reason: ReasonSchema.parse(revocation.reason) }),
  });
}

/**
 * Copies one complete admission chain into domain-owned intrinsic state.
 * @param chain - Locally earned or transport-admitted proposal, review, and admission facts.
 * @returns Deeply detached immutable facts suitable for private positive evidence.
 */
function copyAdmissionChain(chain: ResourceAdmissionChain): ResourceAdmissionChain {
  /** Proposal fields are copied independently so no nested caller alias survives. */
  const proposal = copyProposalState(chain.proposal);
  /** Review fields are copied independently before cross-fact verification. */
  const review = copyReviewState(chain.review);
  /** Admission fields are copied independently before positive authority is installed. */
  const admission = copyAdmissionState(chain.admission);
  return Object.freeze({ proposal, review, admission });
}

/**
 * Projects one locally earned proposal for explicit transport encoding.
 * @param proposal - Exact proposal carrying local runtime provenance.
 * @returns Detached immutable intrinsic state.
 * @internal
 */
export function resourceProposalState(proposal: ResourceProposal): ResourceProposalState {
  if (!ADMITTED_RESOURCE_PROPOSALS.has(proposal)) {
    throw new ResourcesError('resources_admission_refused', 'Proposal projection requires locally earned evidence');
  }
  return copyProposalState(proposal);
}

/**
 * Projects one locally earned review for explicit transport encoding.
 * @param review - Exact review bound to a locally earned proposal.
 * @returns Detached immutable intrinsic state.
 * @internal
 */
export function resourceReviewState(review: ResourceReview): ResourceReviewState {
  if (!ADMITTED_RESOURCE_REVIEWS.has(review)) {
    throw new ResourcesError('resources_admission_refused', 'Review projection requires locally earned evidence');
  }
  return copyReviewState(review);
}

/**
 * Projects one verified admission chain for explicit transport encoding.
 * @param evidence - Exact positive compiler evidence.
 * @returns Detached immutable intrinsic chain.
 * @internal
 */
export function resourceAdmissionChainState(evidence: VerifiedResourceAdmission): ResourceAdmissionChain {
  /** Private lookup prevents structural lifecycle data from becoming an encode source. */
  const canonical = VERIFIED_RESOURCE_ADMISSIONS.get(evidence);
  if (canonical === undefined) {
    throw new ResourcesError('resources_admission_refused', 'Admission projection requires verified evidence');
  }
  return copyAdmissionChain(canonical);
}

/**
 * Projects one verified revocation for explicit transport encoding.
 * @param evidence - Exact negative compiler evidence.
 * @returns Detached immutable intrinsic revocation state.
 * @internal
 */
export function resourceRevocationState(evidence: VerifiedResourceRevocation): ResourceRevocationState {
  /** Private lookup prevents structural revocation data from becoming an encode source. */
  const canonical = VERIFIED_RESOURCE_REVOCATIONS.get(evidence);
  if (canonical === undefined) {
    throw new ResourcesError('resources_admission_refused', 'Revocation projection requires verified evidence');
  }
  return copyRevocationState(canonical);
}

/**
 * Records one exact Resource proposal with explicit attribution.
 * @param resource - Behavior-bearing immutable revision entering review.
 * @param proposedBy - Principal attributable to the proposal.
 * @param context - Fresh proposal identity and trusted creation time.
 * @returns Portable immutable proposal fact.
 */
export function proposeResource(
  resource: ResourceCandidate,
  proposedBy: PrincipalId,
  context: ResourceControlFactContext<ResourceProposalId>,
): ResourceProposal {
  /** Runtime admission prevents a cast string from entering durable attribution. */
  const actor = PrincipalIdSchema.parse(proposedBy);
  /** The exact frozen fact earns local proposal provenance only after every field succeeds. */
  const proposal = Object.freeze({
    ...factEnvelope('resource-proposal', context),
    resource: resourceControlRef(resource),
    proposedBy: actor,
  }) as ResourceProposal;
  ADMITTED_RESOURCE_PROPOSALS.add(proposal);
  return proposal;
}

/**
 * Records an independent decision or refuses self-review without altering proposal evidence.
 * @param proposal - Exact immutable proposal under review.
 * @param input - Reviewer identity, decision, and optional context.
 * @param context - Fresh review identity and trusted creation time.
 * @returns Review fact or stable separation-of-duty refusal.
 */
export function reviewResource(
  proposal: ResourceProposal,
  input: ReviewResourceInput,
  context: ResourceControlFactContext<ResourceReviewId>,
): ResultValue<ResourceReview, ResourcesError> {
  try {
    if (!ADMITTED_RESOURCE_PROPOSALS.has(proposal)) {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'Resource review requires a locally admitted proposal'),
      );
    }
    /** Runtime admission makes actor comparison meaningful at a JavaScript boundary. */
    const reviewedBy = PrincipalIdSchema.parse(input.reviewedBy);
    if (reviewedBy === proposal.proposedBy) {
      return Result.error(
        new ResourcesError('resources_self_review_refused', 'A Resource proposer cannot review the same proposal'),
      );
    }
    /** Optional context is copied only after its bounded contract succeeds. */
    const reason = input.reason === undefined ? undefined : ReasonSchema.parse(input.reason);
    /** Runtime decision admission keeps transport facts inside the public discriminated union. */
    const decision = ReviewDecisionSchema.parse(input.decision);
    /** Review identity is bound to this exact proposal object, not merely matching fields. */
    const review = Object.freeze({
      ...factEnvelope('resource-review', context),
      proposalId: proposal.id,
      resource: proposal.resource,
      proposedBy: proposal.proposedBy,
      reviewedBy,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }) as ResourceReview;
    ADMITTED_RESOURCE_REVIEWS.set(review, proposal);
    return Result.ok(review);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Resource review input is invalid', { cause }),
    );
  }
}

/**
 * Makes one exact independently approved revision eligible for reviewed compilation.
 * @param resource - Current behavior-bearing candidate expected by the review.
 * @param proposal - Exact proposal linked to the supplied review.
 * @param review - Immutable independent review consumed by the decision.
 * @param admittedBy - Principal attributable to admission.
 * @param context - Fresh admission identity and trusted creation time.
 * @returns Admission fact or exact rejected/mismatched review refusal.
 */
export function admitResource(
  resource: ResourceCandidate,
  proposal: ResourceProposal,
  review: ResourceReview,
  admittedBy: PrincipalId,
  context: ResourceControlFactContext<ResourceAdmissionId>,
): ResultValue<VerifiedResourceAdmission, ResourcesError> {
  try {
    if (!ADMITTED_RESOURCE_PROPOSALS.has(proposal) || ADMITTED_RESOURCE_REVIEWS.get(review) !== proposal) {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'Resource admission requires exact locally earned facts'),
      );
    }
    if (review.decision !== 'approve') {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'A rejected Resource review cannot be admitted'),
      );
    }
    /** Candidate projection prevents a passing review from being replayed against changed content. */
    const reference = resourceControlRef(resource);
    if (
      review.proposalId !== proposal.id ||
      review.proposedBy !== proposal.proposedBy ||
      !sameResource(proposal.resource, review.resource) ||
      !sameResource(reference, proposal.resource)
    ) {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'Resource candidate does not match its proposal and review'),
      );
    }
    /** Admission actor is validated independently from proposer and reviewer attribution. */
    const actor = PrincipalIdSchema.parse(admittedBy);
    /** Admission fact stays portable while the wrapper retains process-local positive evidence. */
    const admission: ResourceAdmissionState = Object.freeze({
      ...factEnvelope('resource-admission', context),
      resource: reference,
      reviewId: review.id,
      admittedBy: actor,
    });
    return Result.ok(verifiedAdmission({ proposal, review, admission }));
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Resource admission input is invalid', { cause }),
    );
  }
}

/**
 * Creates opaque positive evidence after every linked fact has already been checked.
 * @param chain - Complete exact proposal, review, and admission provenance.
 * @returns Frozen process-local evidence recognized by reviewed compilation.
 */
function verifiedAdmission(chain: ResourceAdmissionChain): VerifiedResourceAdmission {
  /** Domain normalization copies nested facts without depending on transport ownership. */
  const canonical = copyAdmissionChain(chain);
  /** The brand is compile-time only; the private canonical map is the runtime source of provenance. */
  const evidence = canonical as VerifiedResourceAdmission;
  VERIFIED_RESOURCE_ADMISSIONS.set(evidence, canonical);
  return evidence;
}

/**
 * Checks every structural link in one restored admission chain against a behavior owner.
 * @param resource - Exact current Resource behavior selected by the application.
 * @param chain - Transport-restored proposal, review, and admission facts.
 * @returns Whether all links, actors, decision, and content identities agree.
 */
function chainMatchesResource(resource: ResourceCandidate, chain: ResourceAdmissionChain): boolean {
  /** Candidate identity anchors restored facts to behavior rather than display metadata. */
  const reference = resourceControlRef(resource);
  return (
    chain.review.decision === 'approve' &&
    chain.proposal.proposedBy !== chain.review.reviewedBy &&
    chain.review.proposalId === chain.proposal.id &&
    chain.review.proposedBy === chain.proposal.proposedBy &&
    chain.admission.reviewId === chain.review.id &&
    sameResource(reference, chain.proposal.resource) &&
    sameResource(reference, chain.review.resource) &&
    sameResource(reference, chain.admission.resource)
  );
}

/**
 * Restores positive admission evidence only after application-owned authenticity verification.
 * @param resource - Exact behavior-bearing Resource selected by later compilation.
 * @param chain - Complete transport-decoded lifecycle chain.
 * @param verifyProvenance - Application boundary that authenticates actors and durable provenance.
 * @returns Verified evidence or a refusal that leaves all portable facts unchanged.
 */
export async function verifyResourceAdmissionChain(
  resource: ResourceCandidate,
  chain: ResourceAdmissionChain,
  verifyProvenance: VerifyResourceAdmissionProvenance,
): Promise<ResultValue<VerifiedResourceAdmission, ResourcesError>> {
  /** Snapshotting before checks closes mutation during the awaited application verifier. */
  let canonical: ResourceAdmissionChain;
  try {
    canonical = copyAdmissionChain(chain);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Restored Resource admission chain is invalid', { cause }),
    );
  }
  if (!chainMatchesResource(resource, canonical)) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Restored Resource admission chain does not match'),
    );
  }
  /** Authenticity is deliberately delegated to the application boundary that owns Authority and storage. */
  let authentic: boolean;
  try {
    authentic = await verifyProvenance(canonical);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Resource admission provenance verification failed', {
        cause,
      }),
    );
  }
  if (!authentic) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Resource admission provenance was not authenticated'),
    );
  }
  return Result.ok(verifiedAdmission(canonical));
}

/**
 * Records that one exact admission is no longer eligible for future compilation.
 * @param evidence - Verified historical admission being revoked.
 * @param revokedBy - Principal attributable to the revocation.
 * @param context - Fresh revocation identity and trusted creation time.
 * @param proposedReason - Optional bounded operator context.
 * @returns Portable immutable revocation fact.
 */
export function revokeResource(
  evidence: VerifiedResourceAdmission,
  revokedBy: PrincipalId,
  context: ResourceControlFactContext<ResourceRevocationId>,
  proposedReason?: string,
): VerifiedResourceRevocation {
  /** Exact evidence identity retrieves the immutable chain authenticated earlier. */
  const chain = VERIFIED_RESOURCE_ADMISSIONS.get(evidence);
  if (chain === undefined) {
    throw new ResourcesError('resources_admission_refused', 'Revocation requires verified Resource admission evidence');
  }
  /** Revocation consumes the private authenticated snapshot, never caller-facing nested fields. */
  const admission = chain.admission;
  /** Validate optional context before minting a durable fact identity. */
  const reason = proposedReason === undefined ? undefined : ReasonSchema.parse(proposedReason);
  /** Canonical state repeats the exact admission reference and validated revocation attribution. */
  const canonical: ResourceRevocationState = Object.freeze({
    ...factEnvelope('resource-revocation', context),
    admissionId: admission.id,
    resource: copyControlRef(admission.resource),
    revokedBy: PrincipalIdSchema.parse(revokedBy),
    ...(reason === undefined ? {} : { reason }),
  });
  /** Compile-time branding is backed by the exact private canonical snapshot at runtime. */
  const revocationEvidence = canonical as VerifiedResourceRevocation;
  VERIFIED_RESOURCE_REVOCATIONS.set(revocationEvidence, canonical);
  return revocationEvidence;
}

/**
 * Restores negative compiler evidence only after exact admission binding and application authentication.
 * @param admissionEvidence - Exact verified admission the revocation claims to deny.
 * @param revocation - Transport-decoded revocation data carrying no authority by itself.
 * @param verifyProvenance - Application boundary authenticating actor and durable provenance.
 * @returns Verified revocation or a refusal that grants no compiler-negative authority.
 */
export async function verifyResourceRevocation(
  admissionEvidence: VerifiedResourceAdmission,
  revocation: ResourceRevocationState,
  verifyProvenance: VerifyResourceRevocationProvenance,
): Promise<ResultValue<VerifiedResourceRevocation, ResourcesError>> {
  try {
    /** Exact positive evidence anchors restored negative authority to an already trusted admission. */
    const admissionChain = VERIFIED_RESOURCE_ADMISSIONS.get(admissionEvidence);
    if (admissionChain === undefined) {
      return Result.error(
        new ResourcesError(
          'resources_admission_refused',
          'Revocation verification requires verified admission evidence',
        ),
      );
    }
    /** Snapshotting before the awaited verifier closes mutation and prototype-based aliasing. */
    const canonical = copyRevocationState(revocation);
    if (
      canonical.admissionId !== admissionChain.admission.id ||
      !sameResource(canonical.resource, admissionChain.admission.resource) ||
      canonical.resource.name !== admissionChain.admission.resource.name
    ) {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'Restored revocation does not match its exact admission'),
      );
    }
    /** Authenticity stays with the application that owns durable storage and actor verification. */
    const authentic = await verifyProvenance(canonical);
    if (!authentic) {
      return Result.error(
        new ResourcesError('resources_admission_refused', 'Resource revocation provenance was not authenticated'),
      );
    }
    /** Only this exact object can retrieve the private canonical revocation during compilation. */
    const evidence = canonical as VerifiedResourceRevocation;
    VERIFIED_RESOURCE_REVOCATIONS.set(evidence, canonical);
    return Result.ok(evidence);
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_admission_refused', 'Resource revocation provenance verification failed', {
        cause,
      }),
    );
  }
}

/**
 * Projects exact profile selections in deterministic request-compilation order.
 * @param profile - Legal immutable selection owner.
 * @returns Model, Prompt, Skill, then Budget references in profile order.
 */
function selectedResources(profile: AgentProfile): readonly ResourceControlRef[] {
  return Object.freeze([
    controlRef('model', profile.model),
    ...profile.prompts.map((prompt) => controlRef('prompt', prompt)),
    ...profile.skills.map((selection) => controlRef('skill', selection.skill)),
    controlRef('budget-policy', profile.budget),
  ]);
}

/**
 * Compiles a profile only when every exact selection has one current admission.
 * @param input - Profile and complete caller-supplied lifecycle fact slice.
 * @returns Reviewed ResourceSet or stable missing, ambiguous, or revoked refusal.
 */
export function compileReviewedResourceSet(
  input: CompileReviewedResourceSetInput,
): ResultValue<ResourceSet, ResourcesError> {
  try {
    /** Every supplied positive fact must carry exact process-local provenance before matching begins. */
    const admissions = input.admissions.map((evidence) => VERIFIED_RESOURCE_ADMISSIONS.get(evidence));
    if (admissions.some((chain) => chain === undefined)) {
      return Result.error(
        new ResourcesError('resources_compile_refused', 'Reviewed compilation requires verified admissions'),
      );
    }
    /** Exact cardinality prevents valid but unselected authority from disappearing silently. */
    const selected = selectedResources(input.profile);
    if (admissions.length !== selected.length) {
      return Result.error(
        new ResourcesError('resources_compile_refused', 'Reviewed compilation requires one admission per selection'),
      );
    }
    /** A revocation targets admission identity rather than rewriting historical facts. */
    const revoked = new Set<ResourceAdmissionId>();
    /** Admits every supplied negative fact before any selected Resource is evaluated. */
    for (const evidence of input.revocations ?? []) {
      /** Exact-object lookup prevents a transport record or structural copy from denying admission. */
      const canonical = VERIFIED_RESOURCE_REVOCATIONS.get(evidence);
      if (canonical === undefined) {
        return Result.error(
          new ResourcesError('resources_compile_refused', 'Reviewed compilation requires verified revocations'),
        );
      }
      revoked.add(canonical.admissionId);
    }
    /** Profile order becomes the only order retained by reviewed compilation. */
    const admissionIds: ResourceAdmissionId[] = [];
    /** Every selected revision must resolve to exactly one current lifecycle fact. */
    for (const selectedResource of selected) {
      /** Exact content matching prevents logical UUID reuse from bypassing review. */
      const matches = admissions.flatMap((canonical) =>
        canonical !== undefined && sameResource(canonical.admission.resource, selectedResource)
          ? [canonical.admission]
          : [],
      );
      if (matches.length !== 1) {
        return Result.error(
          new ResourcesError(
            'resources_compile_refused',
            matches.length === 0
              ? `Selected ${selectedResource.kind} Resource has no exact admission`
              : `Selected ${selectedResource.kind} Resource has ambiguous admissions`,
            { details: { resourceId: selectedResource.id, revisionId: selectedResource.revisionId } },
          ),
        );
      }
      /** Current revocation is evaluated at compilation rather than mutating admission history. */
      const admission = matches[0] as ResourceAdmissionState;
      if (revoked.has(admission.id)) {
        return Result.error(
          new ResourcesError(
            'resources_compile_refused',
            `Selected ${selectedResource.kind} Resource admission is revoked`,
            {
              details: {
                resourceId: selectedResource.id,
                revisionId: selectedResource.revisionId,
                admissionId: admission.id,
              },
            },
          ),
        );
      }
      admissionIds.push(admission.id);
    }
    /** Evidence is copied before crossing into the ResourceSet compilation owner. */
    const evidence: ResourceSetAdmission = Object.freeze({
      mode: 'reviewed',
      admissions: Object.freeze(admissionIds),
    });
    return Result.ok(compileResourceSetFromProfile(input.profile, evidence, input.context));
  } catch (cause) {
    return Result.error(
      new ResourcesError('resources_compile_refused', 'Reviewed ResourceSet compilation input is invalid', { cause }),
    );
  }
}
