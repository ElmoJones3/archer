/**
 * @file Publishes the product-neutral Materializer contract and directory reference.
 *
 * Importing this subpath does not create directories, inspect host paths, or
 * start a hot operation. Construction and activation remain explicit calls.
 */

export {
  DIRECTORY_MAPPING_VERSION,
  DIRECTORY_MATERIALIZER_ADAPTER_ID,
  DirectoryCooperativeQuiescenceSchema,
  DirectoryIngestionInputSchema,
  FILES_INGEST_ACTION,
  FILES_MATERIALIZE_ACTION,
  IngestionReceiptSchema,
  MATERIALIZER_PROTOCOL_VERSION,
  type CreateDirectoryMaterializerOptions,
  type DirectoryCooperativeQuiescence,
  type DirectoryIngestionInput,
  type DirectoryIngestionResult,
  type DirectoryMaterializationInput,
  type DirectoryMaterializationResult,
  type DirectoryMaterializationTarget,
  type DirectoryMaterializedView,
  type DirectoryMaterializedViewCloseEvidence,
  type DirectoryMaterializer,
  type DirectoryMaterializerAction,
  type DirectoryMaterializerCloseEvidence,
  type DirectoryViewPaths,
  type FilesIngestAction,
  type FilesIngestScope,
  type FilesMaterializeAction,
  type FilesMaterializeScope,
  type IngestionEvent,
  type IngestionOperationCloseEvidence,
  type IngestionReceipt,
  type IngestionStartOutcome,
  type MaterializationEvent,
  type MaterializationOperationCloseEvidence,
  type MaterializationStartOutcome,
  type MaterializedScratchpadRetention,
  type ReadonlyTreeMount,
  type ScratchpadMount,
} from './contracts.js';
export { createDirectoryMaterializer, directoryMaterializationInputDigest } from './directory.js';
export {
  DIRECTORY_MATERIALIZER_CONFORMANCE_CASES,
  DIRECTORY_MATERIALIZER_CONFORMANCE_VERSION,
  runDirectoryMaterializerConformance,
  type DirectoryMaterializerConformanceCase,
  type DirectoryMaterializerConformanceCaseId,
  type DirectoryMaterializerConformanceCaseResult,
  type DirectoryMaterializerConformanceExecution,
  type DirectoryMaterializerConformanceFixture,
  type DirectoryMaterializerConformanceReport,
  type DirectoryMaterializerConformanceTarget,
  type FailedDirectoryMaterializerConformanceCase,
  type PassedDirectoryMaterializerConformanceCase,
} from './conformance.js';
export {
  IngestionReceiptIdSchema,
  MaterializedViewIdSchema,
  MaterializerIdSchema,
  type IngestionReceiptId,
  type MaterializedViewId,
  type MaterializerId,
} from '../work-values.js';
