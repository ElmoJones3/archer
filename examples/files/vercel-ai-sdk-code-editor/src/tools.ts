/**
 * @file Adapts an Archer Workspace into ordinary Vercel AI SDK tool definitions.
 *
 * The model sees familiar project-file verbs and Zod schemas. It does not need
 * to know whether the working copy is backed by memory, a host directory, a
 * container, or a later Firecracker Materializer; that guarantee remains an
 * application composition decision outside the tool vocabulary.
 */

import { IdempotencyKeySchema, type IdempotencyKey } from '@archer/core';
import type { GrantRef } from '@archer/core/authority';
import {
  type WorkspaceHandle,
  type WorkspaceMutationOutcome,
  type WorkspaceReadAction,
  type WorkspaceWriteAction,
} from '@archer/files/workspace';
import { tool } from 'ai';
import * as z from 'zod';

/** Dependencies required to bind model-facing file verbs to one private working copy. */
export type CreateWorkspaceToolsOptions = Readonly<{
  /** Supplies the live private working copy; storage and placement stay behind this handle. */
  workspace: WorkspaceHandle;
  /** Supplies current read permission selected by the host application. */
  readGrant: GrantRef<WorkspaceReadAction>;
  /** Supplies current write permission selected by the host application. */
  writeGrant: GrantRef<WorkspaceWriteAction>;
  /** Maps an AI SDK call identity to Archer's UUIDv4 idempotency identity. */
  idempotencyKeyForToolCall?: (toolCallId: string) => IdempotencyKey;
}>;

/** Small model-facing mutation result that omits internal trees and grant evidence. */
export type WorkspaceMutationToolResult =
  | Readonly<{
      /** Confirms the private working copy advanced. */
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
      /** Reports current generation when the Workspace supplied preserved-state evidence. */
      generation?: number;
    }>;

/** Model-facing file read result with verified content fully collected for this bounded tool call. */
export type WorkspaceReadToolResult =
  | Readonly<{
      /** Selects an authorized existing file. */
      status: 'found';
      /** Returns UTF-8 content suitable for direct model consumption. */
      content: string;
    }>
  | Readonly<{
      /** Reports absence, closure, or current permission denial. */
      status: 'unavailable';
      /** Gives the model a bounded reason without leaking Authority internals. */
      reason: string;
    }>;

/** Model-facing canonical listing result. */
export type WorkspaceListToolResult =
  | Readonly<{
      /** Selects an authorized current listing. */
      status: 'listed';
      /** Contains logical project paths, never host filesystem paths. */
      files: readonly string[];
    }>
  | Readonly<{
      /** Reports closure or current permission denial. */
      status: 'unavailable';
      /** Gives the model a bounded reason without leaking Authority internals. */
      reason: string;
    }>;

/** UTF-8 decoder turns a verified blob stream into the text expected by this coding tool. */
const TEXT_DECODER = new TextDecoder();

/**
 * Creates a stable UUIDv4 command-key resolver scoped to one AI SDK tool set.
 * @param createId - UUIDv4 source; injectable so examples and tests remain deterministic.
 * @returns Resolver that reuses one key when the AI SDK retries the same tool call ID.
 */
export function createToolCallIdempotencyKeys(
  createId: () => string = () => globalThis.crypto.randomUUID(),
): (toolCallId: string) => IdempotencyKey {
  /** Tool-call mappings remain process-local and contain no private file content. */
  const keys = new Map<string, IdempotencyKey>();
  return (toolCallId) => {
    /** Existing mapping makes an AI SDK retry an exact Archer idempotent retry. */
    const existing = keys.get(toolCallId);
    if (existing !== undefined) return existing;
    /** Runtime admission rejects any injected generator that does not produce UUIDv4. */
    const created = IdempotencyKeySchema.parse(createId());
    keys.set(toolCallId, created);
    return created;
  };
}

/**
 * Collects one verification-bearing blob stream as UTF-8 text.
 * @param content - Public async byte stream whose terminal iteration verifies identity.
 * @returns Complete text after terminal verification.
 */
async function collectText(content: AsyncIterable<Uint8Array>): Promise<string> {
  /** Bounded tool reads retain copied chunks so storage buffers cannot be aliased. */
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
 * Projects Archer's detailed mutation settlement into useful model feedback.
 * @param outcome - Exact private Workspace settlement.
 * @returns Bounded file-operation result suitable for AI SDK serialization.
 */
function mutationToolResult(outcome: WorkspaceMutationOutcome): WorkspaceMutationToolResult {
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
 * Creates native AI SDK tools over one already-configured private working copy.
 * @param options - Workspace, current grants, and optional tool-call key strategy.
 * @returns Tool map ready for `generateText`, `streamText`, or an existing agent loop.
 */
export function createWorkspaceTools(options: CreateWorkspaceToolsOptions) {
  /** One call-ID resolver gives retries stable identity across every file verb. */
  const commandKey = options.idempotencyKeyForToolCall ?? createToolCallIdempotencyKeys();

  return Object.freeze({
    listFiles: tool({
      description: 'List files in the private project working copy, optionally below one directory.',
      inputSchema: z.strictObject({
        prefix: z.string().min(1).optional().describe('Optional project-relative directory or file prefix.'),
      }),
      /**
       * Lists logical names without revealing how or where the working copy is stored.
       * @param input - Optional logical subtree selected by the model.
       * @returns Current canonical logical paths or a bounded unavailable reason.
       */
      execute: async (input): Promise<WorkspaceListToolResult> => {
        /** Exact-optional request preserves omission instead of passing explicit undefined. */
        const request = input.prefix === undefined ? {} : { prefix: input.prefix };
        /** Public handle checks current read permission before returning private names. */
        const outcome = await options.workspace.list(request, options.readGrant);
        if (outcome.kind === 'listed') {
          return Object.freeze({ status: 'listed', files: Object.freeze(outcome.entries.map((entry) => entry.path)) });
        }
        return Object.freeze({
          status: 'unavailable',
          reason: outcome.kind === 'closed' ? 'working-copy-closed' : `permission-${outcome.refusal.reason}`,
        });
      },
    }),
    readFile: tool({
      description: 'Read one UTF-8 file from the private project working copy.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Project-relative file path returned by listFiles.'),
      }),
      /**
       * Reads verified immutable bytes and returns ordinary text to the model.
       * @param input - Exact logical file selected by the model.
       * @returns Verified UTF-8 content or a bounded unavailable reason.
       */
      execute: async (input): Promise<WorkspaceReadToolResult> => {
        /** Public handle checks current read permission before opening immutable content. */
        const outcome = await options.workspace.read(input, options.readGrant);
        if (outcome.kind === 'found') {
          return Object.freeze({ status: 'found', content: await collectText(outcome.read.content) });
        }
        return Object.freeze({
          status: 'unavailable',
          reason:
            outcome.kind === 'not-found'
              ? 'file-not-found'
              : outcome.kind === 'closed'
                ? 'working-copy-closed'
                : `permission-${outcome.refusal.reason}`,
        });
      },
    }),
    addFile: tool({
      description: 'Add a new UTF-8 file to the private project working copy. Existing files are never overwritten.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('New project-relative file path.'),
        content: z.string().describe('Complete UTF-8 file content.'),
      }),
      /**
       * Adds only an absent path, preserving Archer's no-implicit-overwrite rule.
       * @param input - New logical path and complete text content.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation or an actionable refusal.
       */
      execute: async (input, execution): Promise<WorkspaceMutationToolResult> =>
        mutationToolResult(
          await options.workspace.apply(
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
    modifyFile: tool({
      description: 'Replace the complete UTF-8 content of an existing file in the private project working copy.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Existing project-relative file path.'),
        content: z.string().describe('Complete replacement UTF-8 content.'),
      }),
      /**
       * Pins the edit to the acknowledged generation observed immediately before execution.
       * @param input - Existing logical path and complete replacement text.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation, no-op, or actionable concurrency refusal.
       */
      execute: async (input, execution): Promise<WorkspaceMutationToolResult> => {
        /** Snapshot read makes optimistic concurrency automatic without adding jargon to the tool schema. */
        const generation = options.workspace.getSnapshot().generation;
        return mutationToolResult(
          await options.workspace.apply(
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
    renameFile: tool({
      description: 'Rename one existing file in the private project working copy without changing its content.',
      inputSchema: z.strictObject({
        from: z.string().min(1).describe('Existing project-relative source path.'),
        to: z.string().min(1).describe('Absent project-relative destination path.'),
      }),
      /**
       * Makes movement explicit so audit and review never infer rename from equal bytes.
       * @param input - Existing source and absent destination paths.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation, no-op, or actionable concurrency refusal.
       */
      execute: async (input, execution): Promise<WorkspaceMutationToolResult> => {
        /** Snapshot read hides mechanical generation plumbing while retaining a real precondition. */
        const generation = options.workspace.getSnapshot().generation;
        return mutationToolResult(
          await options.workspace.apply(
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
    deleteFile: tool({
      description: 'Delete one existing file from the private project working copy.',
      inputSchema: z.strictObject({
        path: z.string().min(1).describe('Existing project-relative file path.'),
      }),
      /**
       * Deletes only the generation observed immediately before execution.
       * @param input - Existing logical path selected by the model.
       * @param execution - AI SDK call identity used for exact retry semantics.
       * @returns Acknowledged generation or an actionable refusal.
       */
      execute: async (input, execution): Promise<WorkspaceMutationToolResult> => {
        /** Snapshot read hides mechanical generation plumbing while retaining a real precondition. */
        const generation = options.workspace.getSnapshot().generation;
        return mutationToolResult(
          await options.workspace.apply(
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
  });
}

/** Public inferred tool map consumed unchanged by Vercel AI SDK generation APIs. */
export type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
