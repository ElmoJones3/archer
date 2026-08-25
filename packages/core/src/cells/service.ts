/// <reference lib="esnext.disposable" preserve="true" />

/**
 * @file Binds trusted service permissions to a CellHost once at composition.
 *
 * Application code can then create, read, resume, and dispatch Cells without
 * carrying the same Principal and grant through every call. The raw CellHost
 * remains available when an application needs per-request authority.
 */

import type { AuthorityBrokerCloseEvidence } from '../authority/index.js';
import type { IdempotencyKey } from '../protocol.js';
import type { JsonValue } from '../values.js';
import type {
  CellAttachOutcome,
  CellAttachRequest,
  CellCreateOutcome,
  CellCreateRequest,
  CellDiscoveryOutcome,
  CellDiscoveryRequest,
  CellDispatchOutcome,
  CellHandle,
  CellHost,
  CellHostCloseEvidence,
  CellHostId,
  CellStateReadOutcome,
  CellStateReadRequest,
} from './contracts.js';
import type { CellServiceAuthority } from './service-authority.js';

/** Creation input after a trusted service identity has been bound once. */
export type CellServiceCreateRequest<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue> = Omit<
  CellCreateRequest<State, StateView, Event, Effect, Progress>,
  'subject'
>;

/** Attachment input after a trusted service identity has been bound once. */
export type CellServiceAttachRequest<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue> = Omit<
  CellAttachRequest<State, StateView, Event, Effect, Progress>,
  'subject'
>;

/** State-read input after a trusted service identity has been bound once. */
export type CellServiceStateReadRequest<State> = Omit<CellStateReadRequest<State>, 'subject'>;

/** Dispatch input after a trusted service identity has been bound once. */
export type CellServiceCommand<Event> = Readonly<{
  /** Carries caller-owned input admitted through the Cell protocol. */
  event: Event;

  /** Deduplicates this exact command at the Cell boundary. */
  idempotencyKey: IdempotencyKey;
}>;

/** Recovery input after a trusted service identity has been bound once. */
export type CellServiceDiscoveryRequest = Omit<CellDiscoveryRequest, 'subject'>;

/** Evidence that both the CellHost and its process-local service policy closed. */
export type CellServiceCloseEvidence = Readonly<{
  /** Distinguishes composite service cleanup from closing either dependency alone. */
  kind: 'cell-service-closed';

  /** Retains the underlying durability-service cleanup evidence. */
  host: CellHostCloseEvidence;

  /** Retains the underlying policy cleanup evidence. */
  authority: AuthorityBrokerCloseEvidence;
}>;

/** CellHost shape that also supports bounded recovery discovery. */
export interface RecoverableCellHost extends CellHost {
  /** Finds one bounded page of Cell identities eligible for recovery. */
  discoverRecoverable(
    request: CellDiscoveryRequest,
    grant: CellServiceAuthority['grants']['discover'],
  ): Promise<CellDiscoveryOutcome>;
}

/** Trusted single-service API with authorization details already attached. */
export interface CellService extends AsyncDisposable {
  /** Names the underlying durability service and its authority scope. */
  readonly hostId: CellHostId;

  /** Publishes the exact acknowledgement and recovery guarantee of the host. */
  readonly durability: CellHost['durability'];

  /** Settles after the owned host and service policy have both closed. */
  readonly closed: Promise<CellServiceCloseEvidence>;

  /** Creates one Cell as the service's configured Principal. */
  create<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
    request: CellServiceCreateRequest<State, StateView, Event, Effect, Progress>,
  ): Promise<CellCreateOutcome<StateView, Event, Progress>>;

  /** Restores one Cell as the service's configured Principal. */
  attach<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
    request: CellServiceAttachRequest<State, StateView, Event, Effect, Progress>,
  ): Promise<CellAttachOutcome<StateView, Event, Progress>>;

  /** Reads one Cell as the service's configured Principal. */
  readState<State>(request: CellServiceStateReadRequest<State>): Promise<CellStateReadOutcome<State>>;

  /** Sends one event through the configured dispatch grant. */
  dispatch<StateView, Event, Progress extends JsonValue = JsonValue>(
    handle: CellHandle<StateView, Event, Progress>,
    command: CellServiceCommand<Event>,
  ): Promise<CellDispatchOutcome>;

  /** Closes the owned host first and then closes its service policy. */
  close(): Promise<CellServiceCloseEvidence>;
}

/** Trusted Cell service that can also scan for unfinished work. */
export interface RecoverableCellService extends CellService {
  /** Finds one bounded page of recoverable Cell identities as this service. */
  discoverRecoverable(request: CellServiceDiscoveryRequest): Promise<CellDiscoveryOutcome>;
}

/** Dependencies whose lifecycles transfer into one trusted Cell service. */
export type CellServiceOptions<Host extends CellHost = CellHost> = Readonly<{
  /** CellHost closed when the service closes. */
  host: Host;

  /** Process-local identity, grants, and ledger closed after the host. */
  authority: CellServiceAuthority;
}>;

/**
 * Creates the shared authorized operations used by finite and recoverable services.
 * @param options - Host and matching service policy whose lifecycles transfer here.
 * @returns An owned application-facing Cell service.
 */
export function createCellService(options: CellServiceOptions): CellService {
  /** Retains one settlement for callers waiting before or after shutdown starts. */
  let settleClosed!: (evidence: CellServiceCloseEvidence) => void;
  /** Preserves closure failure for every waiter instead of leaving `closed` pending. */
  let rejectClosed!: (error: unknown) => void;
  /** Public retained settlement created before the service becomes reachable. */
  const closed = new Promise<CellServiceCloseEvidence>((resolve, reject) => {
    settleClosed = resolve;
    rejectClosed = reject;
  });
  /** Keeps repeated cleanup calls on one exact operation. */
  let closePromise: Promise<CellServiceCloseEvidence> | undefined;

  /**
   * Closes both owned dependencies even when host cleanup fails.
   * @returns Immutable evidence from both successful close operations.
   */
  const close = (): Promise<CellServiceCloseEvidence> => {
    closePromise ??= (async () => {
      /** Keeps the host failure authoritative while still releasing policy state. */
      try {
        /** Host cleanup runs before its borrowed verification ledger disappears. */
        const host = await options.host.close();
        /** The service is the only remaining owner of this process-local ledger. */
        const authority = await options.authority.ledger.close();
        return Object.freeze({ kind: 'cell-service-closed' as const, host, authority });
      } catch (error) {
        await options.authority.ledger.close();
        throw error;
      }
    })();
    void closePromise.then(settleClosed, rejectClosed);
    return closePromise;
  };

  return Object.freeze({
    hostId: options.host.hostId,
    durability: options.host.durability,
    closed,
    /**
     * Binds creation to the service Principal and exact create grant.
     * @param request - Application Cell identity, initial state, protocol, and command identity.
     * @returns Raw host outcome with an owned handle only when creation opens.
     */
    create<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
      request: CellServiceCreateRequest<State, StateView, Event, Effect, Progress>,
    ) {
      return options.host.create({ ...request, subject: options.authority.subject }, options.authority.grants.create);
    },
    /**
     * Binds attachment to the service Principal and exact attach grant.
     * @param request - Cell identity, protocol, and process-local activation capabilities.
     * @returns Raw host outcome with an owned handle only when attachment opens.
     */
    attach<State, StateView, Event, Effect, Progress extends JsonValue = JsonValue>(
      request: CellServiceAttachRequest<State, StateView, Event, Effect, Progress>,
    ) {
      return options.host.attach({ ...request, subject: options.authority.subject }, options.authority.grants.attach);
    },
    /**
     * Binds inspection to the service Principal and exact read grant.
     * @param request - Cell identity, stored protocol revision, codec, and optional sequence.
     * @returns Finite raw host read outcome without activating the Cell.
     */
    readState<State>(request: CellServiceStateReadRequest<State>) {
      return options.host.readState({ ...request, subject: options.authority.subject }, options.authority.grants.read);
    },
    /**
     * Binds a handle command to the service Principal and exact dispatch grant.
     * @param handle - Active Cell that receives the application event.
     * @param command - Event and command identity without repeated authorization fields.
     * @returns Raw durable dispatch outcome from the active handle.
     */
    dispatch<StateView, Event, Progress extends JsonValue = JsonValue>(
      handle: CellHandle<StateView, Event, Progress>,
      command: CellServiceCommand<Event>,
    ) {
      return handle.dispatch({ ...command, subject: options.authority.subject }, options.authority.grants.dispatch);
    },
    close,
    /** Delegates language-level asynchronous disposal to the owned service lifecycle. */
    async [Symbol.asyncDispose]() {
      await close();
    },
  });
}

/**
 * Creates a Cell service that also binds recovery discovery to the same policy.
 * @param options - Recoverable host and matching service policy transferred here.
 * @returns One owned service with ordinary Cell operations and bounded discovery.
 */
export function createRecoverableCellService(options: CellServiceOptions<RecoverableCellHost>): RecoverableCellService {
  /** The finite service owns shared operations and both dependency lifecycles. */
  const service = createCellService(options);
  return Object.freeze({
    ...service,
    /**
     * Binds recovery scans to the service Principal and exact discovery grant.
     * @param request - Trusted scan time, optional page size, and continuation cursor.
     * @returns One raw bounded discovery outcome from the recoverable host.
     */
    discoverRecoverable(request: CellServiceDiscoveryRequest) {
      return options.host.discoverRecoverable(
        { ...request, subject: options.authority.subject },
        options.authority.grants.discover,
      );
    },
  });
}
