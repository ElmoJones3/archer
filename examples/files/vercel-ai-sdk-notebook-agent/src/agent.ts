/**
 * @file Runs a Vercel AI SDK agent with a private checkpointable notebook.
 *
 * The AI SDK owns model turns and tool dispatch. Archer owns note identity,
 * current authorization, optimistic edits, explicit checkpointing, and cleanup
 * evidence. The caller retains the immutable store containing checkpoint bytes.
 */

import { TimestampSchema, createUuidV4, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
} from '@archer/core/authority';
import type { FileStore, TreeRef } from '@archer/files';
import {
  SCRATCHPAD_CHECKPOINT_ACTION,
  SCRATCHPAD_READ_ACTION,
  SCRATCHPAD_WRITE_ACTION,
  ScratchpadIdSchema,
  createMemoryScratchpad,
  type ScratchpadAction,
  type ScratchpadCheckpointAction,
  type ScratchpadCloseEvidence,
  type ScratchpadReadAction,
  type ScratchpadWriteAction,
} from '@archer/files/scratchpad';
import { ToolLoopAgent, stepCountIs, type LanguageModel } from 'ai';

import { createCheckpointedScratchpadTools } from './tools.js';

/** Input for one AI SDK agent that owns private working notes during a task. */
export type RunNotebookAgentOptions = Readonly<{
  /** AI SDK model used by the real `ToolLoopAgent` path. */
  model: LanguageModel;
  /** Caller-owned immutable storage retaining checkpoint bytes. */
  store: FileStore;
  /** User request the agent may decompose in its private notebook. */
  task: string;
}>;

/** Useful task and recovery output returned to the host application. */
export type NotebookAgentResult = Readonly<{
  /** Final model response after the multi-step tool loop. */
  response: string;
  /** Logical private note paths present when the loop finished. */
  notes: readonly string[];
  /** Exact immutable checkpoint root the host may retain for later recovery. */
  checkpoint?: TreeRef;
  /** Honest cleanup disposition when the model omitted checkpointing. */
  disposition: ScratchpadCloseEvidence['disposition'];
}>;

/**
 * Parses one fresh UUIDv4 through a domain-specific identity codec.
 * @param parse - Runtime codec parser for the requested branded identity.
 * @returns Fresh admitted identity without cross-brand casts.
 */
function freshId<Identity>(parse: (value: unknown) => Identity): Identity {
  return parse(createUuidV4());
}

/**
 * Runs the actual AI SDK notebook loop.
 * @param options - Model, caller-owned store, and task prompt.
 * @returns Final response, note names, and exact retained checkpoint evidence.
 */
export async function runNotebookAgent(options: RunNotebookAgentOptions): Promise<NotebookAgentResult> {
  /** Independent identity names the broker serving only this private notebook. */
  const ledgerId = freshId(AuthorityLedgerIdSchema.parse);
  /** One external application user remains attributable across all model calls. */
  const principalId = freshId(PrincipalIdSchema.parse);
  /** Scratchpad identity stays independent from current note contents. */
  const scratchpadId = freshId(ScratchpadIdSchema.parse);
  /** External owner keeps this example independent from Archer Task and Thread layers. */
  const owner = Object.freeze({ type: 'external' as const, id: createUuidV4() });
  /** Bootstrap grants become facts at one application-owned wall instant. */
  const createdAt = TimestampSchema.parse(new Date().toISOString());
  /** Read permission lets tools list and inspect the complete private notebook. */
  const readRoot = createBootstrapAuthorizationGrant<ScratchpadReadAction>(SCRATCHPAD_READ_ACTION, {
    id: freshId(AuthorizationGrantIdSchema.parse),
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-read', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** Write permission lets tools edit notes without also granting retention authority. */
  const writeRoot = createBootstrapAuthorizationGrant<ScratchpadWriteAction>(SCRATCHPAD_WRITE_ACTION, {
    id: freshId(AuthorizationGrantIdSchema.parse),
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-write', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** Separate checkpoint permission makes recoverability an explicit model action. */
  const checkpointRoot = createBootstrapAuthorizationGrant<ScratchpadCheckpointAction>(SCRATCHPAD_CHECKPOINT_ACTION, {
    id: freshId(AuthorizationGrantIdSchema.parse),
    ledgerId,
    subject: principalId,
    scope: { kind: 'scratchpad-checkpoint', scratchpadId },
    issuedBy: principalId,
    createdAt,
  });
  /** The current broker checks every note operation rather than trusting a stored reference. */
  const authority = createMemoryAuthorityLedger<ScratchpadAction>({
    ledgerId,
    actions: [SCRATCHPAD_READ_ACTION, SCRATCHPAD_WRITE_ACTION, SCRATCHPAD_CHECKPOINT_ACTION],
    bootstrap: [readRoot, writeRoot, checkpointRoot],
  });
  /** The process-local handle borrows durable object storage owned by the host application. */
  const opened = await createMemoryScratchpad({
    scratchpadId,
    owner,
    retention: 'checkpointed',
    subject: principalId,
    store: borrowed(options.store),
    authority: borrowed(authority),
  });
  if (!opened.ok) {
    await authority.close();
    throw opened.error;
  }
  /** Retained handle owns live notes and checkpoint state for the duration of this agent run. */
  const scratchpad = opened.value;

  try {
    /** Native tools expose notebook verbs while hiding grants, generations, and immutable roots. */
    const tools = createCheckpointedScratchpadTools({
      scratchpad,
      readGrant: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
      writeGrant: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
      checkpointGrant: Object.freeze({ grantId: checkpointRoot.id, action: checkpointRoot.action }),
    });
    /** ToolLoopAgent owns every provider turn and invokes tool callbacks after schema validation. */
    const agent = new ToolLoopAgent({
      model: options.model,
      instructions:
        'Use the private notebook to organize useful working notes for the task. Checkpoint the current notes before giving a final answer so the host can retain a recovery point.',
      tools,
      stopWhen: stepCountIs(12),
    });
    /** The AI SDK performs the real multi-step model and tool execution path. */
    const generated = await agent.generate({ prompt: options.task });
    /** Host presentation lists private note names after the model loop settles. */
    const listing = await scratchpad.list({}, { grantId: readRoot.id, action: readRoot.action });
    if (listing.kind !== 'listed') throw new Error(`Could not list private notes: ${listing.kind}`);
    /** Close evidence states whether the model actually earned a recoverable checkpoint. */
    const closed = await scratchpad.close();
    return Object.freeze({
      response: generated.text,
      notes: Object.freeze(listing.entries.map((entry) => entry.path)),
      ...(closed.checkpoint === undefined ? {} : { checkpoint: closed.checkpoint }),
      disposition: closed.disposition,
    });
  } finally {
    /** Repeated close observes retained evidence and never deletes caller-owned immutable bytes. */
    await scratchpad.close();
    await authority.close();
  }
}
