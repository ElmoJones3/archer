/**
 * @file Publishes the short local Resource workflow and its prepared evidence.
 *
 * Domain construction, reviewed control, transport, and hydration remain on
 * explicit subpaths so ordinary autocomplete leads with the application job.
 */

export { ResourcesError, type ResourcesErrorCode, type ResourcesErrorOptions } from './errors.js';
export type { BudgetAllocation, BudgetLimitsInput, BudgetPolicy, BudgetPolicyRef } from './budgets/index.js';
export type {
  AgentProfile,
  AgentProfileRef,
  AgentProfileSkillSelection,
  SelectSkillInput,
  SkillActivation,
} from './profiles/index.js';
export type { Prompt, PromptContribution, PromptRef } from './prompts/index.js';
export type { Skill, SkillRef, SkillSummary } from './skills/index.js';
export {
  ResourceSet,
  bindCompiledResources,
  createLocalResources,
  nodeResourceSourceImporter,
  type LocalResourceDependencies,
  type LocalResources,
  type PreparedModelStep,
  type PrepareStepInput,
  type ResourceKind,
  type ResourceRevisionRef,
  type ResourceSetAdmission,
  type ResourceSetCreationContext,
  type ResourceSetDto,
  type ResourceSetId,
  type ResourceSession,
  type ResourceSourceImporter,
} from './session.js';
