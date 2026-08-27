/** @file Provides compile-time proof that root imports expose behavior, not codecs. */

import { ResourceSet, bindCompiledResources } from '../src/index.js';
import {
  BudgetPolicy,
  defineBudgetPolicy,
  type BudgetAllocation,
  type BudgetPolicyCreationContext,
} from '../src/entrypoints/budgets.js';
import { createAgentProfile, type AgentProfileCreationContext } from '../src/entrypoints/profiles.js';
import { Prompt, definePrompt, type PromptCreationContext } from '../src/entrypoints/prompts.js';
import type { Skill } from '../src/entrypoints/skills.js';
import type {
  ResourceAdmissionCodec,
  BudgetAllocationCodec,
  ResourceProposalCodec,
  ResourceReviewCodec,
  ResourceRevocationCodec,
} from '../src/transport/index.js';
import type {
  ResourceProposal,
  ResourceReview,
  VerifiedResourceAdmission,
  VerifiedResourceRevocation,
} from '../src/control/index.js';

/** Application composition supplies identity and time to the standalone Prompt constructor. */
declare const promptCreation: PromptCreationContext;
/** Explicit lower construction still produces the behavior-bearing class. */
const prompt: Prompt = definePrompt({ name: 'Voice', placement: 'system', template: 'Be concise.' }, promptCreation);

/** Standalone Prompt construction cannot hide identity, time, or naming policy. */
// @ts-expect-error Ordinary zero-policy construction belongs to createLocalResources().
definePrompt({ name: 'Voice', placement: 'system', template: 'Be concise.' });

/** Constructor requires module-private authority and is not ordinary hydration. */
// @ts-expect-error Agent callers cannot obtain the module-private construction token.
new Prompt(Symbol('forged'), {}, 'system', 0, 'forged', []);

/** A compiled fact must come from local binding or the explicit reviewed compiler. */
// @ts-expect-error Application code cannot obtain ResourceSet construction authority.
new ResourceSet(Symbol('forged'), {}, { mode: 'local' });

/** Structural copies cannot impersonate a package-compiled ResourceSet. */
// @ts-expect-error ResourceSet carries private nominal identity in its emitted declaration.
const forgedSet: ResourceSet = { receipt: {}, model: {}, prompts: [], skills: [], budget: {} };

/** Session binding accepts only a package-compiled ResourceSet. */
// @ts-expect-error A spread loses ResourceSet's private nominal identity.
bindCompiledResources({ ...forgedSet });

/** Root barrel intentionally does not publish transport codecs. */
// @ts-expect-error Transport codecs require the explicit @archer/resources/transport entry point.
void import('../src/index.js').PromptCodec;

void prompt;

/** Support content remains behind the explicit asynchronous SkillContentReader boundary. */
declare const skill: Skill;
// @ts-expect-error Skill exposes no second synchronous byte-loading path.
skill.read('references/example.md');

/** BudgetPolicy behavior is nominal even though its portable fields remain serializable. */
declare const budgetCreation: BudgetPolicyCreationContext;
/** Explicit creation facts produce the behavior-bearing BudgetPolicy class. */
const policy = defineBudgetPolicy({ outputTokens: 1_000 }, budgetCreation);
/** This impossible assignment proves serialization fields are not policy behavior. */
// @ts-expect-error Object spread loses BudgetPolicy's private declaration identity.
const forgedPolicy: BudgetPolicy = { ...policy };

void forgedPolicy;

/** Thread-owned model-call accounting is not a Wave 6 BudgetPolicy input. */
// @ts-expect-error BudgetPolicy exposes only limits this layer mechanically enforces.
defineBudgetPolicy({ modelSteps: 1 }, budgetCreation);

/** Tool execution accounting remains owned by the later Thread/tool runtime. */
// @ts-expect-error BudgetPolicy cannot promise a tool-call limit before a consumer exists.
defineBudgetPolicy({ toolCalls: 1 }, budgetCreation);

/** Context limits require real model-specific measurement before becoming public policy. */
// @ts-expect-error BudgetPolicy cannot claim unmeasured context admission.
defineBudgetPolicy({ contextTokens: 1 }, budgetCreation);

/** Standalone BudgetPolicy construction cannot hide identity, time, or naming policy. */
// @ts-expect-error Ordinary zero-policy construction belongs to createLocalResources().
defineBudgetPolicy({ outputTokens: 1_000 });

/** AgentProfile uses the same explicit standalone construction boundary. */
declare const profileCreation: AgentProfileCreationContext;
/** Only the missing context matters; behavior-bearing selections are intentionally elided. */
// @ts-expect-error Ordinary zero-policy construction belongs to createLocalResources().
createAgentProfile({} as never);
void profileCreation;

/** Transport admissions remain DTOs and cannot become reviewed compiler evidence. */
type ParsedAdmission = ReturnType<typeof ResourceAdmissionCodec.parse>;
/** This impossible assignment proves transport shape is not positive review evidence. */
// @ts-expect-error Parsing JSON cannot mint the module-private verified-admission brand.
const verifiedAdmission: VerifiedResourceAdmission = {} as ParsedAdmission;

void verifiedAdmission;

/** Transport-decoded proposal facts cannot enter the local review path. */
type ParsedProposal = ReturnType<typeof ResourceProposalCodec.parse>;
/** A local proposal requires process provenance absent from the parsed type. */
// @ts-expect-error Local proposal behavior carries module-private admission evidence.
const localProposal: ResourceProposal = {} as ParsedProposal;

/** Transport-decoded reviews cannot enter the local admission path. */
type ParsedReview = ReturnType<typeof ResourceReviewCodec.parse>;
/** A local review requires exact proposal-bound provenance absent from the parsed type. */
// @ts-expect-error Local review behavior carries exact proposal-bound evidence.
const localReview: ResourceReview = {} as ParsedReview;

void localProposal;
void localReview;

/** Transport-decoded revocation data cannot deny a verified admission by structural assignment. */
type ParsedRevocation = ReturnType<typeof ResourceRevocationCodec.parse>;
/** Negative compiler authority requires the private verified-revocation brand. */
// @ts-expect-error Parsing JSON cannot mint verified revocation provenance.
const verifiedRevocation: VerifiedResourceRevocation = {} as ParsedRevocation;

void verifiedRevocation;

/** Transport-decoded allocation state cannot become delegated Budget authority structurally. */
type ParsedBudgetAllocation = ReturnType<typeof BudgetAllocationCodec.parse>;
/** Runtime parent authority requires allocation behavior or authenticated hydration provenance. */
// @ts-expect-error Parsing JSON cannot mint the module-private BudgetAllocation brand.
const admittedAllocation: BudgetAllocation = {} as ParsedBudgetAllocation;

void admittedAllocation;
