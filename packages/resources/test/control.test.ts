/** @file Proves independent Resource lifecycle facts and reviewed ResourceSet compilation. */

import { PrincipalIdSchema, type PrincipalId } from '@archer/core/authority';
import { describe, expect, it, vi } from 'vitest';

import { defineBudgetPolicy } from '../src/entrypoints/budgets.js';
import { createAgentProfile } from '../src/entrypoints/profiles.js';
import { definePrompt } from '../src/entrypoints/prompts.js';
import {
  admitResource,
  compileReviewedResourceSet,
  proposeResource,
  reviewResource,
  revokeResource,
  verifyResourceAdmissionChain,
  type ResourceAdmissionId,
  type ResourceCandidate,
  type ResourceProposal,
  type ResourceProposalId,
  type ResourceReview,
  type ResourceReviewId,
  type ResourceRevocationId,
  type VerifiedResourceAdmission,
} from '../src/control/index.js';
import { hydrateResourceSet } from '../src/hydration/index.js';
import {
  ResourceAdmissionChainCodec,
  ResourceProposalCodec,
  ResourceReviewCodec,
  encodeResourceSet,
} from '../src/transport/index.js';
import {
  budgetContext,
  controlContext,
  modelFixture,
  profileContext,
  promptContext,
  resourceSetContext,
  uuid,
} from './support.js';

/** Stable actors make separation of duty visible without an Authority service. */
const ACTORS = Object.freeze({
  proposer: PrincipalIdSchema.parse(uuid(300)),
  reviewer: PrincipalIdSchema.parse(uuid(301)),
  admitter: PrincipalIdSchema.parse(uuid(302)),
  revoker: PrincipalIdSchema.parse(uuid(303)),
});

/** Monotonic test sequence supplies distinct lifecycle fact identities. */
let factSequence = 310;

/**
 * Earns one exact admission through proposal, independent review, and admission.
 * @param resource - Behavior-bearing Resource under review.
 * @param proposedBy - Attributable proposer.
 * @returns Opaque verified admission evidence.
 */
function admit(resource: ResourceCandidate, proposedBy: PrincipalId = ACTORS.proposer): VerifiedResourceAdmission {
  /** Earns a proposal through ordinary behavior so later review provenance is genuine. */
  const proposal = proposeResource(resource, proposedBy, controlContext<ResourceProposalId>(factSequence++));
  /** Uses an independent reviewer and approval to create the only passing review shape. */
  const reviewed = reviewResource(
    proposal,
    { reviewedBy: ACTORS.reviewer, decision: 'approve' },
    controlContext<ResourceReviewId>(factSequence++),
  );
  if (!reviewed.ok) throw reviewed.error;
  /** Earns opaque admission from the exact proposal-review-resource chain. */
  const admitted = admitResource(
    resource,
    proposal,
    reviewed.value,
    ACTORS.admitter,
    controlContext<ResourceAdmissionId>(factSequence++),
  );
  if (!admitted.ok) throw admitted.error;
  return admitted.value;
}

/**
 * Creates one profile whose three Resource kinds require independent admissions.
 * @returns Exact behavior owners and their reusable selection profile.
 */
function profileFixture() {
  /** Provides the selected Model whose admission and order will be compiled. */
  const model = modelFixture(350);
  /** Provides a behavior-bearing Prompt so reviewed compilation cannot rely on DTOs. */
  const prompt = definePrompt(
    { name: 'Support voice', placement: 'system', template: 'Be concise.' },
    promptContext(352),
  );
  /** Provides the enforceable BudgetPolicy completing the Wave 6 selection. */
  const budget = defineBudgetPolicy({ outputTokens: 600 }, budgetContext(354));
  /** Creates one exact profile so lifecycle tests share production-valid membership. */
  const profile = createAgentProfile({ model, prompts: [prompt], budget }, profileContext(356));
  return Object.freeze({ model, prompt, budget, profile });
}

describe('Resource control behavior', () => {
  it('refuses self-review and rejected admission without changing earned facts', () => {
    /** Uses Prompt behavior because one Resource is sufficient to isolate separation of duty. */
    const { prompt } = profileFixture();
    /** Earns the proposal before testing that its proposer cannot also review it. */
    const proposal = proposeResource(prompt, ACTORS.proposer, controlContext<ResourceProposalId>(360));
    /** Serializes the immutable proposal so every refusal can prove the input stayed unchanged. */
    const before = JSON.stringify(proposal);
    /** Attempts review with the proposer identity to exercise independent-review refusal. */
    const selfReview = reviewResource(
      proposal,
      { reviewedBy: ACTORS.proposer, decision: 'approve' },
      controlContext<ResourceReviewId>(361),
    );
    /** Bypasses TypeScript to prove a Result-returning review still refuses invalid actor data as Result. */
    const invalidReviewer = reviewResource(
      proposal,
      { reviewedBy: 'not-a-principal' as PrincipalId, decision: 'approve' },
      controlContext<ResourceReviewId>(364),
    );
    /** Bypasses TypeScript again so an unknown decision cannot enter a portable review fact. */
    const invalidDecision = reviewResource(
      proposal,
      { reviewedBy: ACTORS.reviewer, decision: 'maybe' as never },
      controlContext<ResourceReviewId>(365),
    );
    /** Creates a genuine rejected review so admission cannot key only on review provenance. */
    const rejected = reviewResource(
      proposal,
      { reviewedBy: ACTORS.reviewer, decision: 'reject' },
      controlContext<ResourceReviewId>(362),
    );
    if (!rejected.ok) throw rejected.error;
    /** Attempts to admit the rejected decision with the exact Resource and proposal. */
    const admission = admitResource(
      prompt,
      proposal,
      rejected.value,
      ACTORS.admitter,
      controlContext<ResourceAdmissionId>(363),
    );

    expect(selfReview).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_self_review_refused' }),
    });
    expect(invalidReviewer).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_admission_refused' }),
    });
    expect(invalidDecision).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_admission_refused' }),
    });
    expect(admission).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_admission_refused' }) });
    expect(JSON.stringify(proposal)).toBe(before);
  });

  it('compiles and restores exact admissions in deterministic profile order', async () => {
    /** Builds a complete behavior-bearing selection for successful reviewed compilation. */
    const { model, prompt, budget, profile } = profileFixture();
    /** Earns one current admission per selected Resource revision. */
    const admissions = [admit(model), admit(prompt), admit(budget)] as const;
    /** Compiles from shuffled lifecycle facts and proves deterministic profile order. */
    const compiled = compileReviewedResourceSet({
      profile,
      admissions,
      context: resourceSetContext(370),
    });
    /** Casts malformed compilation identity to prove the Result boundary never leaks a validator throw. */
    const invalidContext = compileReviewedResourceSet({
      profile,
      admissions,
      context: { ...resourceSetContext(371), id: 'not-a-uuid' as never },
    });
    if (!compiled.ok) throw compiled.error;
    /** Restores the reviewed receipt from the same opaque admissions to prove that hydration path. */
    const hydrated = await hydrateResourceSet({
      dto: encodeResourceSet(compiled.value),
      profile,
      admission: { mode: 'reviewed', admissions },
    });
    if (!hydrated.ok) throw hydrated.error;

    expect(compiled.value.resources.map((resource) => resource.resource)).toEqual(['model', 'prompt', 'budget-policy']);
    expect(invalidContext).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_compile_refused' }),
    });
    expect(compiled.value.admission).toEqual({
      mode: 'reviewed',
      admissions: admissions.map((evidence) => evidence.admission.id),
    });
    expect(hydrated.value.toJSON()).toEqual(compiled.value.toJSON());
  });

  it('refuses missing, ambiguous, or revoked admission without mutating supplied facts', () => {
    /** Builds one selection reused across missing, ambiguous, and revoked admission cases. */
    const { model, prompt, budget, profile } = profileFixture();
    /** Earns the Model admission that remains valid in every failure scenario. */
    const modelAdmission = admit(model);
    /** Earns the Prompt admission targeted by ambiguity and revocation scenarios. */
    const promptAdmission = admit(prompt);
    /** Earns a second valid Prompt admission so ambiguity is real rather than malformed input. */
    const duplicatePromptAdmission = admit(prompt);
    /** Earns the Budget admission that keeps failures isolated to the Prompt. */
    const budgetAdmission = admit(budget);
    /** Snapshots every admission so failed compilation must prove non-mutation. */
    const snapshot = JSON.stringify([modelAdmission, promptAdmission, duplicatePromptAdmission, budgetAdmission]);

    expect(
      compileReviewedResourceSet({
        profile,
        admissions: [modelAdmission, promptAdmission],
        context: resourceSetContext(380),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_compile_refused' }) });
    expect(
      compileReviewedResourceSet({
        profile,
        admissions: [modelAdmission, promptAdmission, duplicatePromptAdmission, budgetAdmission],
        context: resourceSetContext(381),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_compile_refused' }) });

    /** Revokes the exact first Prompt admission while leaving historical facts intact. */
    const revoked = revokeResource(
      promptAdmission,
      ACTORS.revoker,
      controlContext<ResourceRevocationId>(382),
      'Retired configuration',
    );
    expect(
      compileReviewedResourceSet({
        profile,
        admissions: [modelAdmission, promptAdmission, budgetAdmission],
        revocations: [revoked],
        context: resourceSetContext(383),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_compile_refused' }) });
    expect(JSON.stringify([modelAdmission, promptAdmission, duplicatePromptAdmission, budgetAdmission])).toBe(snapshot);
  });

  it('keeps decoded proposal and review DTOs outside locally earned provenance', () => {
    /** Uses one Prompt to isolate runtime provenance from lifecycle identity matching. */
    const { prompt } = profileFixture();
    /** Earns an ordinary proposal whose encoded copy must lose local capability. */
    const proposal = proposeResource(prompt, ACTORS.proposer, controlContext<ResourceProposalId>(390));
    /** Earns an ordinary review whose encoded copy must lose exact-object proposal binding. */
    const reviewed = reviewResource(
      proposal,
      { reviewedBy: ACTORS.reviewer, decision: 'approve' },
      controlContext<ResourceReviewId>(391),
    );
    if (!reviewed.ok) throw reviewed.error;
    /** Parses proposal data to prove strict transport validity is not earned provenance. */
    const decodedProposal = ResourceProposalCodec.parse(proposal);
    /** Parses review data to prove a valid DTO cannot authorize admission. */
    const decodedReview = ResourceReviewCodec.parse(reviewed.value);

    expect(
      reviewResource(
        decodedProposal as ResourceProposal,
        { reviewedBy: ACTORS.reviewer, decision: 'approve' },
        controlContext<ResourceReviewId>(392),
      ),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_admission_refused' }) });
    expect(
      admitResource(
        prompt,
        proposal,
        decodedReview as ResourceReview,
        ACTORS.admitter,
        controlContext<ResourceAdmissionId>(393),
      ),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_admission_refused' }) });
  });

  it('restores positive evidence only after exact-chain and application provenance verification', async () => {
    /** Uses one exact behavior owner to anchor restored lifecycle chain verification. */
    const { prompt } = profileFixture();
    /** Earns a complete chain before deliberately crossing the JSON transport boundary. */
    const earned = admit(prompt);
    /** Creates detached portable data with every structural invariant initially intact. */
    const decoded = ResourceAdmissionChainCodec.parse(JSON.parse(JSON.stringify(earned)));
    /** Records application provenance checks and proves the supplied canonical chain is deeply immutable. */
    const verifier = vi.fn((chain: typeof decoded) => {
      expect(Object.isFrozen(chain)).toBe(true);
      expect(Object.isFrozen(chain.proposal.resource)).toBe(true);
      expect(Object.isFrozen(chain.review.resource)).toBe(true);
      return true;
    });
    /** Restores positive evidence only after both Archer and the application accept the chain. */
    const restored = await verifyResourceAdmissionChain(prompt, decoded, verifier);
    /** Refuses the same structurally valid chain when the application denies authenticity. */
    const refused = await verifyResourceAdmissionChain(prompt, decoded, () => false);

    expect(restored.ok).toBe(true);
    expect(verifier).toHaveBeenCalledOnce();
    expect(refused).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_admission_refused' }) });

    /** Enumerates each independent portable-chain invariant before application authenticity may run. */
    const mismatches = [
      {
        label: 'proposal identity',
        chain: { ...decoded, proposal: { ...decoded.proposal, id: uuid(399) as ResourceProposalId } },
      },
      {
        label: 'Resource kind',
        chain: {
          ...decoded,
          review: { ...decoded.review, resource: { ...decoded.review.resource, kind: 'model' as const } },
        },
      },
      {
        label: 'logical Resource identity',
        chain: {
          ...decoded,
          review: { ...decoded.review, resource: { ...decoded.review.resource, id: uuid(400) } },
        },
      },
      {
        label: 'Resource revision identity',
        chain: {
          ...decoded,
          review: { ...decoded.review, resource: { ...decoded.review.resource, revisionId: uuid(401) } },
        },
      },
      {
        label: 'Resource content digest',
        chain: {
          ...decoded,
          review: {
            ...decoded.review,
            resource: { ...decoded.review.resource, contentDigest: `sha256:${'0'.repeat(64)}` },
          },
        },
      },
      {
        label: 'reviewer independence',
        chain: { ...decoded, review: { ...decoded.review, reviewedBy: decoded.proposal.proposedBy } },
      },
      {
        label: 'passing decision',
        chain: { ...decoded, review: { ...decoded.review, decision: 'reject' as const } },
      },
      {
        label: 'admission review identity',
        chain: {
          ...decoded,
          admission: { ...decoded.admission, reviewId: uuid(402) as ResourceReviewId },
        },
      },
      {
        label: 'admission UUIDv4 identity',
        chain: { ...decoded, admission: { ...decoded.admission, id: 'not-a-uuid' } },
      },
    ] as const;
    /** Every mismatch is refused by Archer before the application is asked to authenticate it. */
    for (const mismatch of mismatches) {
      /** Records accidental provenance calls so structural rejection order remains observable. */
      const shouldNotVerify = vi.fn(() => true);
      await expect(verifyResourceAdmissionChain(prompt, mismatch.chain as never, shouldNotVerify)).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'resources_admission_refused' }),
      });
      expect(shouldNotVerify, mismatch.label).not.toHaveBeenCalled();
    }
  });
});
