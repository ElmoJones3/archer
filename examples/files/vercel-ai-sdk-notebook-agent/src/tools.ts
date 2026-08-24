/**
 * @file Adapts a checkpointable Archer Scratchpad into native Vercel AI SDK tools.
 *
 * The model sees a private notebook with ordinary file verbs. The application
 * retains the meaningful distinction: edits are live process-local work until
 * `checkpointNotes` acknowledges one recoverable immutable generation.
 */

import { IdempotencyKeySchema, type IdempotencyKey } from '@archer/core';
import type { GrantRef } from '@archer/core/authority';
import {
  type RetainedScratchpadHandle,
  type ScratchpadCheckpointAction,
  type ScratchpadCheckpointOutcome,
  type ScratchpadMutationOutcome,
  type ScratchpadReadAction,
  type ScratchpadWriteAction,
} from '@archer/files/scratchpad';
import { tool } from 'ai';
import * as z from 'zod';

/** Dependencies required to bind model-facing notebook verbs to one private owner. */
export type CreateCheckpointedScratchpadToolsOptions = Readonly<{
  /** Supplies living private notes with an actual checkpoint command. */
  scratchpad: RetainedScratchpadHandle<'checkpointed'>;
  /** Supplies current read permission selected by the host application. */
  readGrant: GrantRef<ScratchpadReadAction>;
  /** Supplies current write permission selected by the host application. */
  writeGrant: GrantRef<ScratchpadWriteAction>;
  /** Supplies current checkpoint permission selected by the host application. */
  checkpointGrant: GrantRef<ScratchpadCheckpointAction>;
  /** Maps an AI SDK call identity to Archer's UUIDv4 idempotency identity. */
  idempotencyKeyForToolCall?: (toolCallId: string) => IdempotencyKey;
}>;

/** Small model-facing mutation result that omits immutable tree and grant internals. */
export type ScratchpadMutationToolResult =
  | Readonly<{
      /** Confirms the private notebook advanced. */
      status: 'changed';
      /** Reports the acknowledged generation available to later UI or tool calls. */
      generation: number;
      /** Names the ordinary file operation that settled. */
      operation: 'add' | 'modify' | 'rename' | 'delete';
    }>
  | Readonly<{
      /** Confirms the command was safe but produced no content change. */
      status: 'unchanged';
      /** Reports the still-current acknowledged generation. */
      generation: number;
    }>
  | Readonly<{
      /** Reports a concurrency, path, quota, lifecycle, or permission refusal. */
      status: 'refused';
      /** Gives the model a bounded reason it can explain or use to re-plan. */
      reason: string;
      /** Reports current generation when preserved-state evidence was supplied. */
      generation?: number;
    }>;

/** Model-facing checkpoint result that states recoverability explicitly. */
export type ScratchpadCheckpointToolResult =
  | Readonly<{
      /** Confirms this exact private generation now has retained checkpoint evidence. */
      status: 'checkpointed';
      /** Names the exact generation protected by the checkpoint. */
      generation: number;
    }>
  | Readonly<{
      /** Reports staleness, conflict, closure, or current permission denial. */
      status: 'refused';
      /** Gives the model a bounded reason it can explain or use to re-plan. */
      reason: string;
      /** Reports current generation when the Scratchpad supplied it. */
      generation?: number;
    }>;

/** Model-facing private note read result. */
export type ScratchpadReadToolResult =
  | Readonly<{
      /** Selects an authorized existing private note. */
      status: 'found';
      /** Returns complete verified UTF-8 content. */
      content: string;
    }>
  | Readonly<{
      /** Reports absence, closure, or current permission denial. */
      status: 'unavailable';
      /** Gives the model a bounded reason without exposing Authority internals. */
      reason: string;
    }>;

/** Model-facing canonical private-note listing. */
export type ScratchpadListToolResult =
  | Readonly<{
      /** Selects an authorized current listing. */
      status: 'listed';
      /** Contains private logical note paths, never host paths. */
      notes: readonly string[];
    }>
  | Readonly<{
      /** Reports closure or current permission denial. */
      status: 'unavailable';
      /** Gives the model a bounded reason without exposing Authority internals. */
      reason: string;
    }>;

/** UTF-8 decoder matches this example's explicitly textual notebook contract. */
const TEXT_DECODER = new TextDecoder();

/**
 * Creates stable UUIDv4 command keys scoped to one AI SDK notebook tool set.
 * @param createId - UUIDv4 source; injectable for deterministic examples and tests.
 * @returns Resolver that preserves Archer idempotency across one retried tool call ID.
 */
export function createScratchpadToolCallKeys(
  createId: () => string = () => globalThis.crypto.randomUUID(),
): (toolCallId: string) => IdempotencyKey {
  /** Mapping retains call identity only and never private note content. */
  const keys = new Map<string, IdempotencyKey>();
  return (toolCallId) => {
    /** Existing mapping makes an AI SDK retry an exact Archer retry. */
    const existing = keys.get(toolCallId);
    if (existing !== undefined) return existing;
    /** Runtime admission rejects an injected generator that does not produce UUIDv4. */
    const created = IdempotencyKeySchema.parse(createId());
    keys.set(toolCallId, created);
    return created;
  };
}

/**
 * Collects one verification-bearing private blob stream into UTF-8 text.
 * @param content - Public async byte stream whose terminal iteration verifies identity.
 * @returns Complete text after terminal verification.
 */
async function collectText(content: AsyncIterable<Uint8Array>): Promise<string> {
  /** Bounded tool reads retain copies so storage buffers cannot be aliased. */
  const chunks: Uint8Array[] = [];
  /** Exact byte count allocates one final decode buffer. */
  let byteLength = 0;
  /** Every chunk must be consumed before the immutable read is considered verified. */
  for await (const chunk of content) {
    /** Independent copy prevents a store from mutating already-delivered bytes. */
    const copied = Uint8Array.from(chunk);
    chunks.push(copied);
    byteLength += copied.byteLength;
  }
  /** Final owned buffer makes decoding independent of stream chunk boundaries. */
  const bytes = new Uint8Array(byteLength);
  /** Offset tracks deterministic source-order concatenation. */
  let offset = 0;
  /** Copied chunks are flattened only after terminal verification succeeds. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return TEXT_DECODER.decode(bytes);
}

/**
 * Projects the detailed private mutation settlement into useful model feedback.
 * @param outcome - Exact checkpointed Scratchpad mutation settlement.
 * @returns Bounded notebook-operation result suitable for AI SDK serialization.
 */
function mutationToolResult(outcome: ScratchpadMutationOutcome<'checkpointed'>): ScratchpadMutationToolResult {
  if (outcome.kind === 'applied') {
    return Object.freeze({
      status: 'changed',
      generation: outcome.snapshot.generation,
      operation: outcome.operation.type,
    });
  }
  if (outcome.kind === 'unchanged') {
    return Object.freeze({ status: 'unchanged', generation: outcome.snapshot.generation });
  }
  if (outcome.kind === 'refused') {
    return Object.freeze({ status: 'refused', reason: outcome.reason, generation: outcome.snapshot.generation });
  }
  return Object.freeze({ status: 'refused', reason: `permission-${outcome.refusal.reason}` });
}

/**
 * Projects exact checkpoint evidence into useful model feedback.
 * @param outcome - Current checkpoint command settlement.
 * @returns Bounded recoverability result suitable for AI SDK serialization.
 */
function checkpointToolResult(outcome: ScratchpadCheckpointOutcome): ScratchpadCheckpointToolResult {
  if (outcome.kind === 'created') {
    return Object.freeze({ status: 'checkpointed', generation: outcome.checkpoint.generation });
  }
  if (outcome.kind === 'stale-generation') {
    return Object.freeze({ status: 'refused', reason: outcome.kind, generation: outcome.actualGeneration });
  }
  if (outcome.kind === 'authority-refused') {
    return Object.freeze({ status: 'refused', reason: `permission-${outcome.refusal.reason}` });
  }
  return Object.freeze({ status: 'refused', reason: outcome.kind });
}

/**
 * Creates native AI SDK tools over one already-configured checkpointable notebook.
 * @param options - Scratchpad, current grants, and optional tool-call key strategy.
 * @returns Tool map ready for `generateText`, `streamText`, or an existing agent loop.
 */
export function createCheckpointedScratchpadTools(options: CreateCheckpointedScratchpadToolsOptions) {
  /** One call-ID resolver gives retries stable identity across edits and checkpoints. */
  const commandKey = options.idempotencyKeyForToolCall ?? createScratchpadToolCallKeys();

  return Object.freeze({
    listNotes: tool({
      description: 'List private working-note files, optionally below one logical folder.',
      inputSchema: z.strictObject({
        prefix: z.string().min(1).optional().describe('Optional private note folder or file prefix.'),
      }),
      /**
       * Lists logical note names without revealing storage or materialization placement.
       * @param input - Optional private subtree selected by the model.
       * @returns Current canonical note paths or a bounded unavailable reason.
       */
      execute: async (input): Promise<ScratchpadListToolResult> => {
        /** Exact-optional request preserves omission rather than passing explicit undefined. */
        const request = input.prefix === undefined ? {} : { prefix: input.prefix };
        /** Public handle checks current read permission before returning private names. */
        const outcome = await options.scratchpad.list(request, options.readGrant);
        if (outcome.kind === 'listed') {
          return Object.freeze({ status: 'listed', notes: Object.freeze(outcome.entries.map((entry) => entry.path)) });
        }
        return Object.freeze({
          status: 'unavailable',
          reason: outcome.kind === 'closed' ? 'notebook-closed' : `permission-${outcome.refusal.reason}`,
        });
      },
    }),
    readNote: tool({
      description: 'Read one UTF-8 file from the private working notebook.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Private note path returned by listNotes.'),
      }),
      /**
       * Reads verified private bytes and returns ordinary text to the model.
       * @param input - Exact private note selected by the model.
       * @returns Verified UTF-8 content or a bounded unavailable reason.
       */
      execute: async (input): Promise<ScratchpadReadToolResult> => {
        /** Public handle checks current read permission before opening immutable content. */
        const outcome = await options.scratchpad.read(input, options.readGrant);
        if (outcome.kind === 'found') {
          return Object.freeze({ status: 'found', content: await collectText(outcome.read.content) });
        }
        return Object.freeze({
          status: 'unavailable',
          reason:
            outcome.kind === 'not-found'
              ? 'note-not-found'
              : outcome.kind === 'closed'
                ? 'notebook-closed'
                : `permission-${outcome.refusal.reason}`,
        });
      },
    }),
    addNote: tool({
      description: 'Add a new UTF-8 file to the private notebook. Existing notes are never overwritten.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('New private note path.'),
        content: z.string().describe('Complete UTF-8 note content.'),
      }),
      /**
       * Adds only an absent note, preserving the no-implicit-overwrite rule.
       * @param input - New private path and complete note text.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation or an actionable refusal.
       */
      execute: async (input, execution): Promise<ScratchpadMutationToolResult> =>
        mutationToolResult(
          await options.scratchpad.apply(
            {
              type: 'add',
              ...input,
              precondition: { kind: 'absent' },
              idempotencyKey: commandKey(execution.toolCallId),
            },
            options.writeGrant,
          ),
        ),
    }),
    modifyNote: tool({
      description: 'Replace the complete UTF-8 content of one existing private note.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Existing private note path.'),
        content: z.string().describe('Complete replacement UTF-8 content.'),
      }),
      /**
       * Pins the edit to the acknowledged generation observed immediately before execution.
       * @param input - Existing private path and complete replacement text.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation, no-op, or actionable concurrency refusal.
       */
      execute: async (input, execution): Promise<ScratchpadMutationToolResult> => {
        /** Snapshot read hides mechanical generation plumbing while retaining a real precondition. */
        const generation = options.scratchpad.getSnapshot().generation;
        return mutationToolResult(
          await options.scratchpad.apply(
            {
              type: 'modify',
              ...input,
              precondition: { kind: 'generation', generation },
              idempotencyKey: commandKey(execution.toolCallId),
            },
            options.writeGrant,
          ),
        );
      },
    }),
    renameNote: tool({
      description: 'Rename one existing private note without changing its content.',
      inputSchema: z.strictObject({
        from: z.string().min(1).describe('Existing private source path.'),
        to: z.string().min(1).describe('Absent private destination path.'),
      }),
      /**
       * Keeps movement explicit instead of asking review code to infer it from equal bytes.
       * @param input - Existing source and absent destination paths.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation, no-op, or actionable concurrency refusal.
       */
      execute: async (input, execution): Promise<ScratchpadMutationToolResult> => {
        /** Snapshot read hides mechanical generation plumbing while retaining a real precondition. */
        const generation = options.scratchpad.getSnapshot().generation;
        return mutationToolResult(
          await options.scratchpad.apply(
            {
              type: 'rename',
              ...input,
              precondition: { kind: 'generation', generation },
              idempotencyKey: commandKey(execution.toolCallId),
            },
            options.writeGrant,
          ),
        );
      },
    }),
    deleteNote: tool({
      description: 'Delete one existing file from the private working notebook.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Existing private note path.'),
      }),
      /**
       * Deletes only the generation observed immediately before execution.
       * @param input - Existing private path selected by the model.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation or an actionable refusal.
       */
      execute: async (input, execution): Promise<ScratchpadMutationToolResult> => {
        /** Snapshot read hides mechanical generation plumbing while retaining a real precondition. */
        const generation = options.scratchpad.getSnapshot().generation;
        return mutationToolResult(
          await options.scratchpad.apply(
            {
              type: 'delete',
              ...input,
              precondition: { kind: 'generation', generation },
              idempotencyKey: commandKey(execution.toolCallId),
            },
            options.writeGrant,
          ),
        );
      },
    }),
    checkpointNotes: tool({
      description:
        'Checkpoint the current private notebook generation so it remains recoverable after this process closes.',
      inputSchema: z.strictObject({}),
      /**
       * Turns current live working notes into one explicit retained recovery point.
       * @param _input - Empty model input because current generation is read from living state.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Exact checkpoint generation or an actionable refusal.
       */
      execute: async (_input, execution): Promise<ScratchpadCheckpointToolResult> => {
        /** Snapshot read pins checkpoint evidence to the current acknowledged note generation. */
        const expectedGeneration = options.scratchpad.getSnapshot().generation;
        return checkpointToolResult(
          await options.scratchpad.checkpoint(
            { expectedGeneration, idempotencyKey: commandKey(execution.toolCallId) },
            options.checkpointGrant,
          ),
        );
      },
    }),
  });
}

/** Public inferred tool map consumed unchanged by Vercel AI SDK generation APIs. */
export type CheckpointedScratchpadTools = ReturnType<typeof createCheckpointedScratchpadTools>;
