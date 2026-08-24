/**
 * @file Publishes retention-discriminated Scratchpad contracts and memory reference.
 *
 * The process-local constructor intentionally omits `thread-durable`; the public
 * retained handle contract remains available to adapters that can prove recovery.
 */

export {
  SCRATCHPAD_CHECKPOINT_ACTION,
  SCRATCHPAD_READ_ACTION,
  SCRATCHPAD_WRITE_ACTION,
  ScratchpadCheckpointSchema,
  ScratchpadOwnerSchema,
  scratchpadCheckpointEvidence,
  type CreateMemoryScratchpadOptions,
  type EphemeralScratchpadHandle,
  type MemoryScratchpadRetention,
  type RetainedScratchpadHandle,
  type ScratchpadAction,
  type ScratchpadCheckpoint,
  type ScratchpadCheckpointAction,
  type ScratchpadCheckpointCommand,
  type ScratchpadCheckpointEvent,
  type ScratchpadCheckpointOutcome,
  type ScratchpadCheckpointScope,
  type ScratchpadCloseEvidence,
  type ScratchpadCursor,
  type ScratchpadHandle,
  type ScratchpadHandleBase,
  type ScratchpadLifecycle,
  type ScratchpadListOutcome,
  type ScratchpadListRequest,
  type ScratchpadMutation,
  type ScratchpadMutationOutcome,
  type ScratchpadMutationRefusalReason,
  type ScratchpadOwner,
  type ScratchpadPathScope,
  type ScratchpadQuota,
  type ScratchpadQuotaState,
  type ScratchpadReadAction,
  type ScratchpadReadOutcome,
  type ScratchpadReadRequest,
  type ScratchpadRetention,
  type ScratchpadSnapshot,
  type ScratchpadSnapshotBase,
  type ScratchpadUpdate,
  type ScratchpadWriteAction,
} from './contracts.js';
export { createMemoryScratchpad } from './memory.js';
export {
  ScratchpadCheckpointIdSchema,
  ScratchpadIdSchema,
  type ScratchpadCheckpointId,
  type ScratchpadId,
} from '../work-values.js';
export {
  SCRATCHPAD_CONFORMANCE_CASES,
  SCRATCHPAD_CONFORMANCE_VERSION,
  runScratchpadConformance,
  type FailedScratchpadConformanceCase,
  type PassedScratchpadConformanceCase,
  type ScratchpadConformanceCase,
  type ScratchpadConformanceCaseId,
  type ScratchpadConformanceCaseResult,
  type ScratchpadConformanceExecution,
  type ScratchpadConformanceFixture,
  type ScratchpadConformanceReport,
  type ScratchpadConformanceTarget,
} from './conformance.js';
