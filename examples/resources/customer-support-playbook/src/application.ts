/** @file Builds one reusable support playbook and answers tickets through it. */

import type { FileStore } from '@archer/files';
import type { TransientDelivery } from '@archer/core/stream';
import type { Model, ModelRouter, ModelStepEvent, ModelStepResult } from '@archer/models';
import { createLocalResources } from '@archer/resources';

/** Caller-owned dependencies and reusable policy used by every support reply. */
export type CreateSupportPlaybookInput = Readonly<{
  /** Immutable storage borrowed while Archer snapshots the playbook and Prompt. */
  files: FileStore;

  /** Credential-free model configuration already bound to the supplied router. */
  model: Model;

  /** Live provider adapter owned and closed by the application shell. */
  router: ModelRouter;

  /** Real Agent Skills directory containing the support playbook. */
  skillDirectory: string;

  /** Parameterized Prompt file describing the company's support voice. */
  promptFile: string;

  /** Company name inserted into the checked Prompt template. */
  company: string;
}>;

/** Customer input that changes from one support reply to the next. */
export type AnswerSupportTicketInput = Readonly<{
  /** Current customer ticket sent as the user message. */
  ticket: string;

  /** Optional presentation callback for live text and missed-update notices. */
  onUpdate?: (update: SupportReplyUpdate) => void;
}>;

/** Application-level updates a terminal or UI can present without learning Archer's stream protocol. */
export type SupportReplyUpdate =
  | Readonly<{
      /** Presents answer text as the provider produces it. */
      type: 'text-delta';

      /** Next piece of display-only answer text. */
      text: string;
    }>
  | Readonly<{
      /** Tells the UI to wait for the complete terminal reply instead of trusting partial text. */
      type: 'live-updates-missed';

      /** Exact number of presentation updates this subscriber could not receive. */
      lostUpdates: string;
    }>;

/** Terminal model outcomes that prevent a support reply from completing. */
export type SupportReplyFailure = Extract<ModelStepResult, { type: 'failed' | 'aborted' }>;

/** Preserves the structured model outcome while remaining a normal application Error. */
export class SupportReplyError extends Error {
  /** Exact retry advice, public error code, or abort reason returned by the model operation. */
  readonly result: SupportReplyFailure;

  /**
   * Creates one application error without flattening Archer's terminal result.
   * @param result - Failed or aborted model result retained for application policy.
   */
  constructor(result: SupportReplyFailure) {
    super(result.type === 'failed' ? result.error.message : `Support reply aborted: ${result.reason}`);
    this.name = 'SupportReplyError';
    this.result = result;
  }
}

/**
 * Bridges Archer stream deliveries into the two updates this application can present.
 * @param delivery - One model progress event or an explicit transient delivery gap.
 * @returns Application update, or undefined for model events the support UI does not display.
 */
export function toSupportReplyUpdate(delivery: TransientDelivery<ModelStepEvent>): SupportReplyUpdate | undefined {
  if (delivery.kind === 'gap') {
    return Object.freeze({ type: 'live-updates-missed', lostUpdates: delivery.lostItems });
  }
  if (delivery.value.type === 'text-delta') {
    return Object.freeze({ type: 'text-delta', text: delivery.value.text });
  }
  return undefined;
}

/** Useful application result kept separate from low-level digests and control facts. */
export type SupportReply = Readonly<{
  /** Complete authoritative reply from the terminal model result. */
  reply: string;

  /** False when this subscriber missed display updates; `reply` remains complete either way. */
  liveUpdatesComplete: boolean;

  /** Human-readable revisions that shaped the request. */
  revisions: Readonly<{
    /** Reusable profile selected by the application. */
    profile: string;

    /** Provider target selected by the profile. */
    model: string;

    /** Prompt source selected by the profile. */
    prompt: string;

    /** Support playbook selected by the profile. */
    skill: string;

    /** Budget policy selected by the profile. */
    budget: string;
  }>;

  /** Effective generated-output ceiling after every application bound intersects. */
  outputTokens: number;

  /** Optional absolute deadline derived before the provider call. */
  deadline?: string;
}>;

/** Reusable application behavior after Prompt, Skill, budget, and profile setup. */
export type SupportPlaybook = Readonly<{
  /**
   * Answers one ticket with a fresh budget allocation and provider request.
   * @param input - Customer ticket and optional live text presentation callback.
   * @returns Complete reply and the useful policy evidence that shaped it.
   */
  answer(input: AnswerSupportTicketInput): Promise<SupportReply>;
}>;

/**
 * Imports support policy once and binds a reusable Resource graph.
 * @param input - Caller-owned storage/router plus the playbook and Prompt source.
 * @returns Application that prepares a fresh bounded request for each ticket.
 */
export async function createSupportPlaybook(input: CreateSupportPlaybookInput): Promise<SupportPlaybook> {
  const resources = createLocalResources({
    files: input.files,
    applicationLimits: { outputTokens: 1_200, wallTimeMs: 30_000 },
  });
  const skill = await resources.skills.importDirectory(input.skillDirectory);
  if (!skill.ok) throw skill.error;
  /** Loads the exact support policy named by SKILL.md before it can influence a model request. */
  const orderStatusGuide = await resources.skills.loadSupport(skill.value, 'references/order-status.md');
  if (!orderStatusGuide.ok) throw orderStatusGuide.error;
  /** Refuses replacement decoding so invalid policy bytes never become model instructions. */
  const orderStatusPolicy = new TextDecoder('utf-8', { fatal: true }).decode(orderStatusGuide.value.content);
  const prompt = await resources.prompts.importFile(input.promptFile, {
    name: 'Customer support voice',
    placement: 'system',
    variables: ['company'],
  });
  if (!prompt.ok) throw prompt.error;
  /** Makes explicitly disclosed Skill support visible as checked application-owned instructions. */
  const supportPolicy = resources.prompts.define({
    name: 'Order status policy',
    placement: 'system',
    template: orderStatusPolicy,
  });
  const budget = resources.budgets.define({
    name: 'Interactive support reply',
    outputTokens: 800,
    wallTimeMs: 20_000,
  });
  const profile = resources.profiles.create({
    name: 'Customer order support',
    model: input.model,
    prompts: [prompt.value, supportPolicy],
    skills: [{ skill: skill.value, activation: 'active' }],
    budget,
  });
  const session = resources.bind(profile);

  return Object.freeze({
    async answer(ticketInput: AnswerSupportTicketInput): Promise<SupportReply> {
      const prepared = session.prepareStep({
        promptInputs: { company: input.company },
        history: [],
        userMessage: ticketInput.ticket,
      });
      if (!prepared.ok) throw prepared.error;

      const started = await input.router.startStep(prepared.value.request);
      if (!started.ok) throw started.error;
      const subscription = started.value.events.subscribe();
      try {
        /** Records whether the optional live presentation can be trusted as complete. */
        let liveUpdatesComplete = true;
        const streamed = (async (): Promise<void> => {
          for await (const delivery of subscription) {
            /** The bridge makes gaps explicit while omitting model events this UI does not show. */
            const update = toSupportReplyUpdate(delivery);
            if (update === undefined) continue;
            if (update.type === 'live-updates-missed') liveUpdatesComplete = false;
            ticketInput.onUpdate?.(update);
          }
        })();
        const [terminal] = await Promise.all([started.value.result, streamed]);
        if (terminal.type !== 'completed') throw new SupportReplyError(terminal);
        const reply = terminal.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        return Object.freeze({
          reply,
          liveUpdatesComplete,
          revisions: Object.freeze({
            profile: profile.name,
            model: input.model.name,
            prompt: prompt.value.name,
            skill: skill.value.name,
            budget: budget.name,
          }),
          outputTokens: prepared.value.allocation.outputTokens,
          ...(prepared.value.allocation.deadline === undefined ? {} : { deadline: prepared.value.allocation.deadline }),
        });
      } finally {
        await subscription.close();
        await started.value.close();
      }
    },
  });
}
