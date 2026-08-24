/**
 * @file Publishes Archer's logical immutable-file contracts and pure helpers.
 *
 * Storage products and host filesystem behavior remain behind explicit
 * implementations so this entry point cannot define identity by side effect.
 */

export {
  LogicalNameSchema,
  LogicalPathSchema,
  compareLogicalNames,
  compareLogicalPaths,
  type LogicalName,
  type LogicalPath,
} from './path.js';
export { FilesError, type FilesErrorCode, type FilesErrorOptions } from './errors.js';
export {
  BlobRefSchema,
  DirectoryNodeSchema,
  FileMode,
  TREE_FORMAT,
  TreeRefSchema,
  blobRefForBytes,
  createDirectoryNode,
  decodeDirectoryNode,
  encodeDirectoryNode,
  treeRefForBytes,
  type BlobRef,
  type DirectoryEntry,
  type DirectoryFileEntry,
  type DirectoryNode,
  type DirectoryTreeEntry,
  type FileMode as FileModeValue,
  type TreeRef,
} from './encoding.js';
export {
  memoryFileStore,
  publishTree,
  publishTreeEntries,
  restoreTree,
  type BlobRead,
  type BlobSource,
  type BlobStore,
  type FileStore,
  type FileStoreCloseEvidence,
  type ImmutableTree,
  type TreeFileEntry,
  type TreeFileSource,
  type TreeStore,
} from './store.js';
export {
  ChangeSetIdSchema,
  IngestionReceiptIdSchema,
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  ScratchpadCheckpointIdSchema,
  ScratchpadIdSchema,
  WorkspaceIdSchema,
  WorkspaceLineageIdSchema,
  WorkspaceSnapshotIdSchema,
  type ChangeSetId,
  type IngestionReceiptId,
  type MaterializedViewId,
  type MaterializerId,
  type ScratchpadCheckpointId,
  type ScratchpadId,
  type WorkspaceId,
  type WorkspaceLineageId,
  type WorkspaceSnapshotId,
} from './work-values.js';
export {
  PhysicalIngestionReceiptSchema,
  createPhysicalIngestionReceipt,
  physicalIngestionReceiptEvidence,
  type PhysicalIngestionReceipt,
  type PhysicalIngestionReceiptInput,
} from './ingestion.js';
export * from './workspace/index.js';
export * from './materializer/index.js';
export * from './scratchpad/index.js';
