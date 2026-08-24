/**
 * @file Runs a Vercel AI SDK agent over an Archer-backed private project copy.
 *
 * The AI SDK owns model calls, schema validation, tool dispatch, and loop
 * continuation. Archer owns immutable input, authorization, private edits, and
 * the review diff. Neither layer is impersonated by application code.
 */

import { TimestampSchema, createUuidV4, borrowed } from '@archer/core';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
} from '@archer/core/authority';
import { memoryFileStore, publishTree, type BlobRef, type FileStore, type TreeFileSource } from '@archer/files';
import {
  CHANGE_SET_CREATE_ACTION,
  WORKSPACE_INGESTION_ACCEPT_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_WRITE_ACTION,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  createMemoryWorkspace,
  type ChangeSetOperation,
  type WorkspaceAction,
  type WorkspaceReadAction,
  type WorkspaceWriteAction,
} from '@archer/files/workspace';
import { ToolLoopAgent, stepCountIs, type LanguageModel } from 'ai';

import { createWorkspaceTools } from './tools.js';

/** Input for one model-owned editing loop over a private project copy. */
export type RunCodeEditorOptions = Readonly<{
  /** AI SDK model used by the real `ToolLoopAgent` execution path. */
  model: LanguageModel;
  /** Current project bytes imported before the model receives its task. */
  project: readonly TreeFileSource[];
  /** User request the model must perform through project-file tools. */
  task: string;
}>;

/** Complete review content represented honestly for both text and binary files. */
export type CodeReviewContent =
  | Readonly<{
      /** Selects directly readable valid UTF-8 source. */
      encoding: 'utf8';
      /** Contains the complete admitted file content. */
      value: string;
    }>
  | Readonly<{
      /** Selects lossless base64 when bytes are not valid UTF-8. */
      encoding: 'base64';
      /** Contains the complete encoded file bytes. */
      value: string;
    }>;

/** Human-review projection paired with machine-authoritative ChangeSet operations. */
export type CodeReviewChange =
  | Readonly<{
      /** Identifies a newly added path. */
      type: 'add';
      /** Names the added project-relative file. */
      path: string;
      /** Carries complete candidate content before the private store closes. */
      after: CodeReviewContent;
    }>
  | Readonly<{
      /** Identifies replacement at one retained path. */
      type: 'modify';
      /** Names the modified project-relative file. */
      path: string;
      /** Carries exact base content. */
      before: CodeReviewContent;
      /** Carries exact candidate content. */
      after: CodeReviewContent;
    }>
  | Readonly<{
      /** Identifies one explicit path move. */
      type: 'rename';
      /** Names the removed source path. */
      from: string;
      /** Names the new destination path. */
      to: string;
      /** Carries the exact content preserved across the move. */
      content: CodeReviewContent;
    }>
  | Readonly<{
      /** Identifies removal of one base path. */
      type: 'delete';
      /** Names the removed project-relative file. */
      path: string;
      /** Carries exact deleted content for review. */
      before: CodeReviewContent;
    }>;

/** Useful result returned to a host application for review or presentation. */
export type CodeEditorResult = Readonly<{
  /** Final model response after the AI SDK has executed every tool step. */
  response: string;
  /** Canonical project paths visible after the private editing loop. */
  files: readonly string[];
  /** Base-to-head semantic edits suitable for human review. */
  changes: readonly ChangeSetOperation[];
  /** Complete before-and-after content rendered while immutable blobs remain available. */
  review: readonly CodeReviewChange[];
}>;

/** Fatal UTF-8 decoding keeps binary review lossless instead of inserting replacement characters. */
const REVIEW_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Parses one fresh UUIDv4 through a domain-specific identity codec.
 * @param parse - Runtime codec parser for the requested branded identity.
 * @returns Fresh admitted identity without sharing brands through casts.
 */
function freshId<Identity>(parse: (value: unknown) => Identity): Identity {
  return parse(createUuidV4());
}

/**
 * Collects one verification-bearing immutable blob before its store attachment closes.
 * @param store - Application-owned store containing base and private candidate blobs.
 * @param ref - Exact content identity carried by a ChangeSet operation.
 * @returns Complete verified bytes owned by the review projection.
 */
async function readBlob(store: FileStore, ref: BlobRef): Promise<Uint8Array> {
  /** Opening through the public store preserves digest and expected-length verification. */
  const opened = await store.blobs.read(ref);
  if (!opened.ok) throw opened.error;
  /** Copied chunks cannot alias buffers owned by the store adapter. */
  const chunks: Uint8Array[] = [];
  /** Exact length controls one final application-owned allocation. */
  let length = 0;
  /** Terminal iteration must finish before verified bytes escape the store boundary. */
  for await (const chunk of opened.value.content) {
    /** Every retained chunk is independent from adapter buffer reuse. */
    const copied = Uint8Array.from(chunk);
    chunks.push(copied);
    length += copied.byteLength;
  }
  /** One contiguous value supports strict decoding or lossless base64 encoding. */
  const bytes = new Uint8Array(length);
  /** Offset preserves the verified source order. */
  let offset = 0;
  /** Copied chunks are concatenated only after the read reaches terminal verification. */
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Presents exact bytes without pretending arbitrary project files are text.
 * @param bytes - Complete verified file bytes.
 * @returns Readable UTF-8 or lossless base64 review content.
 */
function presentContent(bytes: Uint8Array): CodeReviewContent {
  try {
    return Object.freeze({ encoding: 'utf8', value: REVIEW_TEXT_DECODER.decode(bytes) });
  } catch {
    return Object.freeze({ encoding: 'base64', value: Buffer.from(bytes).toString('base64') });
  }
}

/**
 * Resolves semantic operations into content a person can actually review.
 * @param store - Still-open immutable store containing base and candidate blobs.
 * @param operations - Base-to-head operations in canonical review order.
 * @returns Complete content projection retaining operation intent.
 */
async function createReview(
  store: FileStore,
  operations: readonly ChangeSetOperation[],
): Promise<readonly CodeReviewChange[]> {
  /** Each projection remains paired by position with its authoritative semantic operation. */
  const review: CodeReviewChange[] = [];
  /** Every referenced blob is verified while the private application store is still retained. */
  for (const operation of operations) {
    if (operation.type === 'add') {
      review.push(
        Object.freeze({
          type: 'add',
          path: operation.path,
          after: presentContent(await readBlob(store, operation.after)),
        }),
      );
    } else if (operation.type === 'modify') {
      review.push(
        Object.freeze({
          type: 'modify',
          path: operation.path,
          before: presentContent(await readBlob(store, operation.before)),
          after: presentContent(await readBlob(store, operation.after)),
        }),
      );
    } else if (operation.type === 'rename') {
      review.push(
        Object.freeze({
          type: 'rename',
          from: operation.from,
          to: operation.to,
          content: presentContent(await readBlob(store, operation.blob)),
        }),
      );
    } else {
      review.push(
        Object.freeze({
          type: 'delete',
          path: operation.path,
          before: presentContent(await readBlob(store, operation.before)),
        }),
      );
    }
  }
  return Object.freeze(review);
}

/**
 * Runs the actual AI SDK tool loop.
 * @param options - Model, initial project, and requested project change.
 * @returns Final model response plus the exact private review diff.
 */
export async function runCodeEditor(options: RunCodeEditorOptions): Promise<CodeEditorResult> {
  /** The application owns immutable bytes backing both base and private heads. */
  const store = memoryFileStore();
  /** Initial project content enters through the same public canonical publication path as other callers. */
  const base = await publishTree(store, options.project);
  if (!base.ok) {
    await store.close();
    throw base.error;
  }

  /** Independent identities keep authorization and private lineage explicit. */
  const ledgerId = freshId(AuthorityLedgerIdSchema.parse);
  /** One external application user is attributed to every model-selected command. */
  const principalId = freshId(PrincipalIdSchema.parse);
  /** Workspace identity names this private editing session. */
  const workspaceId = freshId(WorkspaceIdSchema.parse);
  /** Lineage identity prevents snapshots from another private session being substituted. */
  const lineageId = freshId(WorkspaceLineageIdSchema.parse);
  /** Bootstrap grants become facts at one application-owned wall instant. */
  const createdAt = TimestampSchema.parse(new Date().toISOString());
  /** Read permission lets model tools inspect the complete private project copy. */
  const readRoot = createBootstrapAuthorizationGrant<WorkspaceReadAction>(WORKSPACE_READ_ACTION, {
    id: freshId(AuthorizationGrantIdSchema.parse),
    ledgerId,
    subject: principalId,
    scope: { kind: 'workspace-read', workspaceId },
    issuedBy: principalId,
    createdAt,
  });
  /** Write permission allows project-file tools to mutate this Workspace only. */
  const writeRoot = createBootstrapAuthorizationGrant<WorkspaceWriteAction>(WORKSPACE_WRITE_ACTION, {
    id: freshId(AuthorizationGrantIdSchema.parse),
    ledgerId,
    subject: principalId,
    scope: { kind: 'workspace-write', workspaceId },
    issuedBy: principalId,
    createdAt,
  });
  /** The in-memory broker enforces current grants on every tool-selected operation. */
  const authority = createMemoryAuthorityLedger<WorkspaceAction>({
    ledgerId,
    actions: [
      WORKSPACE_READ_ACTION,
      WORKSPACE_WRITE_ACTION,
      WORKSPACE_INGESTION_ACCEPT_ACTION,
      CHANGE_SET_CREATE_ACTION,
    ],
    bootstrap: [readRoot, writeRoot],
  });
  /** Public construction verifies the immutable base before exposing the living copy. */
  const opened = await createMemoryWorkspace({
    workspaceId,
    lineageId,
    base: base.value.ref,
    subject: principalId,
    store: borrowed(store),
    authority: borrowed(authority),
  });
  if (!opened.ok) {
    await authority.close();
    await store.close();
    throw opened.error;
  }
  /** This retained handle remains private to the host while tools expose ordinary file verbs. */
  const workspace = opened.value;

  try {
    /** Native AI SDK definitions hide generation and authorization mechanics from the model. */
    const tools = createWorkspaceTools({
      workspace,
      readGrant: Object.freeze({ grantId: readRoot.id, action: readRoot.action }),
      writeGrant: Object.freeze({ grantId: writeRoot.id, action: writeRoot.action }),
    });
    /** ToolLoopAgent owns every provider turn and tool execution until final text or the explicit bound. */
    const agent = new ToolLoopAgent({
      model: options.model,
      instructions:
        'You edit a private project copy. Inspect files when needed, perform the requested change with the provided file tools, and summarize only work you actually completed.',
      tools,
      stopWhen: stepCountIs(12),
    });
    /** The AI SDK, not this application, decides when and how each tool callback runs. */
    const generated = await agent.generate({ prompt: options.task });
    /** Host review happens after the model loop and uses current read permission. */
    const diff = await workspace.diff({}, { grantId: readRoot.id, action: readRoot.action });
    if (diff.kind !== 'diffed') throw new Error(`Could not review the private edit: ${diff.kind}`);
    /** Final project paths give a UI or CLI a compact post-run view. */
    const listing = await workspace.list({}, { grantId: readRoot.id, action: readRoot.action });
    if (listing.kind !== 'listed') throw new Error(`Could not list the private edit: ${listing.kind}`);
    /** Review content is resolved before cleanup makes the in-memory blob identities unreachable. */
    const review = await createReview(store, diff.operations);
    return Object.freeze({
      response: generated.text,
      files: Object.freeze(listing.entries.map((entry) => entry.path)),
      changes: diff.operations,
      review,
    });
  } finally {
    /** Workspace closes before the borrowed broker and store it can no longer use. */
    await workspace.close();
    await authority.close();
    await store.close();
  }
}
