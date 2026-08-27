/** @file Publishes Prompt behavior without transport or hydration internals. */

export {
  Prompt,
  definePrompt,
  promptRef,
  renderPrompt,
  revisePrompt,
  type DefinePromptInput,
  type PromptContribution,
  type PromptCreationContext,
  type PromptId,
  type PromptPlacement,
  type PromptRef,
  type PromptRevisionContext,
  type PromptRevisionId,
  type RevisePromptInput,
} from '../prompts/index.js';
export {
  composePromptContributions,
  type ComposedPrompt,
  type ComposePromptContributionsInput,
} from '../prompts/composition.js';
export {
  importPromptFile,
  type ImportPromptFileInput,
  type PromptImportDependencies,
  type PromptSourceFile,
  type PromptSourceImporter,
} from '../prompts/import.js';
