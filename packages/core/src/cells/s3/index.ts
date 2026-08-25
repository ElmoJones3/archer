/**
 * @file Adapts AWS SDK v3 S3 transport to Archer's conditional-object CellHost.
 *
 * Managed construction uses the SDK's standard Node credential provider chain.
 * Borrowed clients are never destroyed; explicitly owned and managed clients are.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

import { borrowed } from '../../ownership.js';
import { toPublicError } from '../../protocol.js';
import {
  CellIdSchema,
  type CellDiscoverAction,
  type CellDiscoveryOutcome,
  type CellDiscoveryRequest,
  type CellHost,
  type CellHostBaseOptions,
} from '../contracts.js';
import {
  probeConditionalObjectStore,
  type ConditionalObjectListPage,
  type ConditionalObjectProbeEvidence,
  type ConditionalObjectStore,
  type ConditionalObjectWriteOutcome,
  type ObjectVersion,
  type VersionedObject,
} from '../object-store.js';
import { createCellHostRuntime } from '../runtime.js';
import { createCellServiceAuthority } from '../service-authority.js';
import { createRecoverableCellService, type RecoverableCellService } from '../service.js';
import { S3CasCellStore } from './store.js';

/** Explicit application-owned or host-owned AWS SDK client. */
export type S3ClientReference = Readonly<{
  /** Determines whether CellHost closure calls `S3Client.destroy()`. */
  ownership: 'borrowed' | 'owned';

  /** Already configured AWS SDK v3 client. */
  value: S3Client;
}>;

/** S3 transport construction keeps managed and injected clients mutually exclusive. */
export type S3CellTransport =
  | Readonly<{
      /** Constructs an SDK client and owns its lifecycle. */
      type: 'managed';

      /** Uses SDK-native region, endpoint, retry, and credential-provider configuration. */
      config?: S3ClientConfig;
    }>
  | Readonly<{
      /** Uses one explicitly owned or borrowed existing client. */
      type: 'client';

      /** Makes destruction responsibility visible at configuration time. */
      client: S3ClientReference;
    }>;

/** Exact S3 CAS CellHost configuration. */
export type S3CasCellHostOptions = CellHostBaseOptions &
  Readonly<{
    /** Names the existing bucket; Archer never creates infrastructure implicitly. */
    bucket: string;

    /** Names the isolated object namespace below the bucket. */
    prefix: string;

    /** Caps the complete mutable Cell record before any remote publication. */
    stateLimitBytes: number;

    /** Caps head objects one wake-discovery scan may inspect. */
    maxHeadsPerScan: number;

    /** Selects managed default credentials or an explicit client and ownership. */
    transport: S3CellTransport;
  }>;

/** S3 host retains passing live-service evidence beside ordinary CellHost behavior. */
export interface S3CasCellHost extends CellHost {
  /** Proves the exact conditional semantics observed before serving. */
  readonly storageProbe: ConditionalObjectProbeEvidence;

  /** Finds expired Cells with due wakes or stranded acknowledged effects. */
  discoverRecoverable(
    request: CellDiscoveryRequest,
    grant: import('../../authority/contracts.js').GrantRef<CellDiscoverAction>,
  ): Promise<CellDiscoveryOutcome>;
}

/** Trusted single-service S3 configuration with policy wiring supplied by Archer. */
export type S3CellServiceOptions = Omit<S3CasCellHostOptions, 'authority'>;

/** Application-facing S3 Cells with service authorization already attached. */
export interface S3CellService extends RecoverableCellService {
  /** Proves the exact conditional semantics observed before serving. */
  readonly storageProbe: ConditionalObjectProbeEvidence;
}

/** Configuration for the standalone AWS SDK conditional-object adapter. */
export type S3ConditionalObjectStoreOptions = Readonly<{
  /** AWS SDK client whose lifecycle remains with its current owner. */
  client: S3Client;

  /** Existing bucket selected by deployment configuration. */
  bucket: string;
}>;

/** Minimal AWS service failure evidence used for branch classification. */
type AwsServiceFailure = Readonly<{
  /** AWS SDK service error identity when supplied. */
  name?: unknown;

  /** HTTP metadata retained by AWS SDK service errors. */
  $metadata?: Readonly<{
    /** HTTP status code when a response reached the service boundary. */
    httpStatusCode?: unknown;
  }>;
}>;

/** Small head fields required by bounded recovery discovery. */
type S3DiscoveryHead = Readonly<{
  /** Lease boundary used to exclude a currently owned Cell. */
  leaseExpiresAt: string;

  /** Optional durable wake instant projected from acknowledged state. */
  wakeAt?: string;

  /** Signals pending, failed, or stranded claimed external work. */
  recoverableWork?: boolean;
}>;

/**
 * Returns whether one AWS SDK failure represents an ordinary precondition race.
 * @param error - Unknown AWS SDK or transport rejection.
 * @returns Whether the service reported an HTTP precondition conflict.
 */
function isPreconditionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  /** Narrow service failure view avoids importing product-specific exception classes. */
  const candidate = error as AwsServiceFailure;
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

/**
 * Requires an S3 response to carry the opaque ETag needed for later replacement.
 * @param value - Optional ETag returned by an S3 read or write.
 * @returns Opaque version admitted for later If-Match use.
 */
function objectVersion(value: string | undefined): ObjectVersion {
  if (value === undefined || value.length === 0) throw new Error('S3 response omitted the object version ETag');
  return value as ObjectVersion;
}

/** AWS SDK implementation of Archer's minimal conditional-object protocol. */
class AwsS3ConditionalObjectStore implements ConditionalObjectStore {
  /** Borrowed SDK client used only for request transport. */
  readonly #client: S3Client;

  /** Existing bucket selected by explicit configuration. */
  readonly #bucket: string;

  /**
   * Captures one borrowed S3 client and bucket.
   * @param options - SDK client and non-empty existing bucket name.
   */
  constructor(options: S3ConditionalObjectStoreOptions) {
    if (options.bucket.trim().length === 0) throw new RangeError('S3 bucket must not be empty');
    this.#client = options.client;
    this.#bucket = options.bucket;
  }

  /**
   * Reads one object to fresh bytes with its exact current ETag.
   * @param key - Exact object key below the configured bucket.
   * @returns Current bytes/version pair or absence.
   */
  async read(key: string): Promise<VersionedObject | undefined> {
    try {
      /** AWS response remains private to this transport adapter. */
      const output = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (output.Body === undefined) throw new Error('S3 object response omitted its body');
      return Object.freeze({
        key,
        bytes: Uint8Array.from(await output.Body.transformToByteArray()),
        version: objectVersion(output.ETag),
      });
    } catch (error) {
      /** Minimal service failure view distinguishes ordinary absence. */
      const candidate = error as AwsServiceFailure;
      if (candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }

  /**
   * Creates one object through S3's absence precondition.
   * @param key - Exact object key below the configured bucket.
   * @param bytes - Caller-owned payload copied before AWS transport.
   * @returns Written opaque version or ordinary conflict.
   */
  async create(key: string, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome> {
    try {
      /** Conditional put cannot overwrite any existing object version. */
      const output = await this.#client.send(
        new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: Uint8Array.from(bytes), IfNoneMatch: '*' }),
      );
      return Object.freeze({ kind: 'written', version: objectVersion(output.ETag) });
    } catch (error) {
      if (isPreconditionConflict(error)) return Object.freeze({ kind: 'conflict' });
      throw error;
    }
  }

  /**
   * Replaces one object through S3's exact current-ETag precondition.
   * @param key - Exact object key below the configured bucket.
   * @param version - Opaque current ETag passed unchanged to If-Match.
   * @param bytes - Caller-owned replacement payload copied before transport.
   * @returns Written opaque successor version or ordinary conflict.
   */
  async replace(key: string, version: ObjectVersion, bytes: Uint8Array): Promise<ConditionalObjectWriteOutcome> {
    try {
      /** Conditional put succeeds only while the supplied opaque ETag remains current. */
      const output = await this.#client.send(
        new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: Uint8Array.from(bytes), IfMatch: version }),
      );
      return Object.freeze({ kind: 'written', version: objectVersion(output.ETag) });
    } catch (error) {
      if (isPreconditionConflict(error)) return Object.freeze({ kind: 'conflict' });
      throw error;
    }
  }

  /**
   * Lists one bounded S3 key page for explicit wake discovery.
   * @param prefix - Exact object namespace to scan.
   * @param limit - Positive page bound no greater than S3's service maximum.
   * @param cursor - Optional opaque S3 continuation token.
   * @returns Frozen key page with optional continuation token.
   */
  async list(prefix: string, limit: number, cursor?: string): Promise<ConditionalObjectListPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('S3 list limit must be between 1 and 1000');
    }
    /** Bounded service page preserves S3's opaque continuation semantics. */
    const output = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: prefix,
        MaxKeys: limit,
        ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
      }),
    );
    return Object.freeze({
      keys: Object.freeze(
        (output.Contents ?? []).flatMap(
          /**
           * Omits malformed entries whose service response lacks a key.
           * @param item - One AWS SDK object-list entry.
           * @returns Empty or singleton key projection.
           */
          (item) => (item.Key === undefined ? [] : [item.Key]),
        ),
      ),
      ...(output.NextContinuationToken === undefined ? {} : { cursor: output.NextContinuationToken }),
    });
  }
}

/**
 * Adapts a borrowed AWS SDK v3 client to the conditional-object protocol.
 * @param options - Existing client and bucket.
 * @returns Store facade with no client destruction authority.
 */
export function s3ConditionalObjectStore(options: S3ConditionalObjectStoreOptions): ConditionalObjectStore {
  return new AwsS3ConditionalObjectStore(options);
}

/**
 * Opens direct S3 CAS Cells only after proving live service semantics.
 * @param options - Bucket, prefix, bounds, transport ownership, and base Cell configuration.
 * @returns Retained S3 host carrying startup probe evidence.
 */
export async function s3CasCells(options: S3CasCellHostOptions): Promise<S3CasCellHost> {
  if (
    !Number.isSafeInteger(options.maxHeadsPerScan) ||
    options.maxHeadsPerScan < 1 ||
    options.maxHeadsPerScan > 1_000
  ) {
    throw new RangeError('maxHeadsPerScan must be between 1 and 1000');
  }
  /** Managed construction delegates credentials to the SDK's standard Node provider chain. */
  const client =
    options.transport.type === 'managed'
      ? new S3Client(options.transport.config ?? {})
      : options.transport.client.value;
  /** Only managed or explicitly owned injected clients transfer destruction responsibility. */
  const ownsClient = options.transport.type === 'managed' || options.transport.client.ownership === 'owned';
  try {
    /** Minimal conditional-object facade keeps AWS types out of neutral Cell contracts. */
    const objectStore = s3ConditionalObjectStore({ client, bucket: options.bucket });
    /** Store construction validates namespace and record bounds before any remote probe write. */
    const store = new S3CasCellStore({
      store: objectStore,
      prefix: options.prefix,
      stateLimitBytes: options.stateLimitBytes,
      /** Releases only a managed or explicitly owned AWS SDK client. */
      closeTransport: async () => {
        if (ownsClient) client.destroy();
      },
    });
    /** Unique retained probe object prevents startup checks from racing each other. */
    const probeKey = `${options.prefix.replace(/\/+$/u, '')}/_probe/${options.hostId}/${globalThis.crypto.randomUUID()}.txt`;
    /** Passing live semantic evidence must exist before a host can be returned. */
    const probe = await probeConditionalObjectStore(objectStore, probeKey);
    if (!probe.ok) throw probe.error;
    /** Product-neutral runtime owns acknowledgement, fencing, wakes, and effect semantics. */
    const host = createCellHostRuntime({
      base: options,
      durability: Object.freeze({
        type: 's3-cas',
        persistence: 'node-independent',
        acknowledgement: 'immutable-revision-head-cas',
        stateLimitBytes: options.stateLimitBytes,
        wakeDiscovery: Object.freeze({ type: 'bounded-scan', maxHeadsPerScan: options.maxHeadsPerScan }),
      }),
      store,
    });
    /** Closes discovery admission synchronously while delegating retained cleanup to the base host. */
    let adapterClosed = false;
    /**
     * Shares the base host's idempotent close settlement across both lifecycle entry points.
     * @returns Retained base-host close settlement.
     */
    const close = () => {
      adapterClosed = true;
      return host.close();
    };
    return Object.freeze({
      ...host,
      close,
      /** Routes language-level disposal through the same adapter-aware close boundary. */
      async [Symbol.asyncDispose]() {
        await close();
      },
      storageProbe: probe.value,
      /**
       * Lists small head objects only after current host-wide discovery authority.
       * @param request - Trusted scan instant, bound, continuation, and subject.
       * @param grant - Current Cell discovery grant.
       * @returns Recoverable identities without state, event, effect, or credential data.
       */
      async discoverRecoverable(
        request: CellDiscoveryRequest,
        grant: import('../../authority/contracts.js').GrantRef<CellDiscoverAction>,
      ): Promise<CellDiscoveryOutcome> {
        if (adapterClosed) {
          return Object.freeze({
            kind: 'unavailable',
            failure: toPublicError(new Error('CellHost is closed'), {
              code: 'cell_host_closed',
              message: 'CellHost is closed',
            }),
          });
        }
        /** Current host-wide discovery authority precedes every S3 list or read. */
        const decision = await options.authority.value.verify<CellDiscoverAction>({
          grant,
          subject: request.subject,
          scope: { kind: 'cell', hostId: options.hostId },
        });
        if (!decision.allowed) return Object.freeze({ kind: 'authority-refused', refusal: decision.refusal });
        try {
          /** Caller bound may narrow but never expand configured scan cardinality. */
          const limit = request.limit ?? options.maxHeadsPerScan;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > options.maxHeadsPerScan) {
            throw new RangeError('Cell discovery limit exceeds maxHeadsPerScan');
          }
          /** Normalized namespace must match the store's dedicated head-key construction. */
          const normalizedPrefix = options.prefix.replace(/^\/+|\/+$/gu, '');
          /** Heads have their own namespace so immutable history cannot consume scan pages. */
          const discoveryPrefix = `${normalizedPrefix}/heads/`;
          /** Bounded key page preserves the caller's opaque continuation token. */
          const page =
            request.cursor === undefined
              ? await objectStore.list(discoveryPrefix, limit)
              : await objectStore.list(discoveryPrefix, limit, request.cursor);
          /** Accumulates identities only, never state, event, effect, or credential data. */
          const recoverable: import('../contracts.js').CellId[] = [];
          /** Inspects each bounded key at most once. */
          for (const key of page.keys) {
            if (!key.endsWith('.json')) continue;
            /** Current head bytes may disappear between list and read. */
            const object = await objectStore.read(key);
            if (object === undefined) continue;
            /** Minimal decoded head view excludes the immutable record pointer from results. */
            const head = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(object.bytes)) as S3DiscoveryHead;
            /** Active leases exclude recovery even when work is otherwise due. */
            const leaseExpired = Date.parse(head.leaseExpiresAt) <= Date.parse(request.at);
            /** Due wake is evaluated against the trusted caller-supplied scan instant. */
            const wakeDue = head.wakeAt !== undefined && Date.parse(head.wakeAt) <= Date.parse(request.at);
            if (!leaseExpired || (!wakeDue && head.recoverableWork !== true)) continue;
            /** Key path yields only the branded Cell identity after strict admission. */
            const cellId = key.slice(discoveryPrefix.length, -'.json'.length);
            recoverable.push(CellIdSchema.parse(cellId));
          }
          return Object.freeze({
            kind: 'found',
            cellIds: Object.freeze(recoverable),
            ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          });
        } catch (error) {
          return Object.freeze({
            kind: 'unavailable',
            failure: toPublicError(error, {
              code: 'cell_discovery_unavailable',
              message: 'Recoverable Cell discovery is unavailable',
            }),
          });
        }
      },
    });
  } catch (error) {
    /** Failed construction returns transferred transport ownership to the caller boundary. */
    if (ownsClient) client.destroy();
    throw error;
  }
}

/**
 * Opens S3 Cells for one trusted service without repeating Authority on every call.
 *
 * This path owns both the S3 host and a process-local host-wide policy. Use
 * `s3CasCells()` when callers need narrower grants, tenant attribution, durable
 * revocation, or independent lifecycle ownership.
 * @param options - Bucket, prefix, bounds, transport, and base Cell configuration.
 * @returns One owned service with authorized operations and recovery discovery.
 */
export async function s3Cells(options: S3CellServiceOptions): Promise<S3CellService> {
  /** A service-local ledger provides current checks without per-call setup. */
  const authority = createCellServiceAuthority({
    hostId: options.hostId,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  try {
    /** The raw host borrows the ledger because the returned service owns both. */
    const host = await s3CasCells({ ...options, authority: borrowed(authority.ledger) });
    /** Binding removes authorization plumbing while preserving real host guarantees. */
    const service = createRecoverableCellService({ host, authority });
    return Object.freeze({ ...service, storageProbe: host.storageProbe });
  } catch (error) {
    await authority.ledger.close();
    throw error;
  }
}
