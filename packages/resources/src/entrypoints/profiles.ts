/** @file Publishes AgentProfile behavior without transport or persistence concerns. */

export {
  AgentProfile,
  activateSkill,
  agentProfileRef,
  createAgentProfile,
  renameAgentProfile,
  replaceAgentProfileSelections,
  type ActivateSkillCommand,
  type AgentProfileCommand,
  type AgentProfileCreationContext,
  type AgentProfileId,
  type AgentProfileRef,
  type AgentProfileRevisionId,
  type AgentProfileSelectionsInput,
  type AgentProfileSkillSelection,
  type CreateAgentProfileInput,
  type RenameAgentProfileCommand,
  type ReplaceAgentProfileSelectionsCommand,
  type SelectSkillInput,
  type SkillActivation,
} from '../profiles/index.js';
