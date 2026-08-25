/**
 * @file Proves the S3 adapter gates startup on live CAS semantics and restores direct revisions.
 */

import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { s3CasCells, s3Cells } from '../src/cells/s3/index.js';
import { runCellHostConformance, type CellHostConformanceTarget } from '../src/cells/conformance.js';
import type { CellHost } from '../src/cells/index.js';
import { TimestampSchema } from '../src/values.js';
import {
  CELL_COMMAND_KEY,
  CELL_CREATE_KEY,
  CELL_HOST_ID,
  CELL_ID,
  CELL_SUBJECT,
  cellHostOptions,
  createCellAuthorityFixture,
  createCounterProtocol,
} from './support/cell-fixture.js';

/** Object retained by the fake SDK boundary with an opaque quoted ETag. */
type FakeS3Object = Readonly<{
  /** Source-owned object bytes. */
  bytes: Uint8Array;

  /** Opaque quoted version token shaped like an S3 ETag. */
  etag: string;
}>;

/** Minimal real-command view consumed by the fake AWS SDK client. */
type FakeS3Command = Readonly<{
  /** Real AWS SDK command class supplies the operation identity. */
  constructor: Readonly<{
    /** Class name selects GetObject, PutObject, or ListObjectsV2 behavior. */
    name: string;
  }>;

  /** Real AWS SDK command input retains its exact runtime field names. */
  input: Record<string, unknown>;
}>;

/** AWS SDK-shaped service failure used by adapter branch classification. */
type FakeS3ServiceError = Error & {
  /** AWS service exception identity. */
  name: string;

  /** HTTP response metadata carried by the SDK. */
  $metadata: {
    /** Exact service status code. */
    httpStatusCode: number;
  };
};

/**
 * Returns a fixed trusted instant after fixture grants were issued.
 * @returns Stable fixture clock read.
 */
function fixedClock(): Date {
  return new Date('2026-08-24T00:00:01.000Z');
}

/**
 * Prevents timers from changing deterministic lease and wake fixtures.
 * @returns No-op cancellation capability.
 */
function inertSchedule(): () => void {
  return () => undefined;
}

/**
 * Minimal AWS SDK request boundary that enforces real S3 conditional semantics.
 * Command classes and response bodies remain the real SDK types used by production.
 */
class FakeS3Client {
  /** Retains objects by exact bucket/key pair. */
  readonly #objects = new Map<string, FakeS3Object>();

  /** Records every bucket-qualified list prefix selected by recovery discovery. */
  readonly listPrefixes: string[] = [];

  /** Generates opaque versions independently of payload identity. */
  #revision = 0;

  /** Counts explicit destruction to prove borrowed ownership. */
  destroyCount = 0;

  /**
   * Handles the exact GetObject, PutObject, and ListObjects commands used by the adapter.
   * @param command - Real AWS SDK command instance.
   * @returns SDK-shaped response sufficient for the production adapter.
   */
  async send(command: FakeS3Command): Promise<unknown> {
    /** Exact bucket string participates in every fake storage key. */
    const bucket = String(command.input.Bucket);
    if (command.constructor.name === 'PutObjectCommand') {
      /** Bucket-qualified key isolates fake objects exactly like S3. */
      const key = `${bucket}/${String(command.input.Key)}`;
      /** Current object supplies absence and If-Match precondition evidence. */
      const current = this.#objects.get(key);
      if (command.input.IfNoneMatch === '*' && current !== undefined) throw this.#preconditionFailure();
      if (command.input.IfMatch !== undefined && current?.etag !== command.input.IfMatch) {
        throw this.#preconditionFailure();
      }
      /** Successful write retires the prior token independently of payload bytes. */
      const etag = `"${++this.#revision}"`;
      this.#objects.set(key, Object.freeze({ bytes: Uint8Array.from(command.input.Body as Uint8Array), etag }));
      return Object.freeze({ ETag: etag });
    }
    if (command.constructor.name === 'GetObjectCommand') {
      /** Bucket-qualified key selects one current object. */
      const key = `${bucket}/${String(command.input.Key)}`;
      /** Current object remains source-owned until body byte transformation. */
      const current = this.#objects.get(key);
      if (current === undefined) {
        /** SDK-shaped absence lets production adapter classify ordinary missing keys. */
        const error = new Error('missing') as FakeS3ServiceError;
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return Object.freeze({
        ETag: current.etag,
        Body: Object.freeze({
          /**
           * Returns a fresh copy through the real SDK response-body method name.
           * @returns Fresh object payload bytes.
           */
          async transformToByteArray() {
            return Uint8Array.from(current.bytes);
          },
        }),
      });
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      /** Bucket-qualified prefix constrains the fake object scan. */
      const prefix = `${bucket}/${String(command.input.Prefix ?? '')}`;
      this.listPrefixes.push(prefix);
      /** Service page bound comes from the real SDK command input. */
      const maximum = Number(command.input.MaxKeys);
      /** Bounded service-shaped key entries omit the bucket prefix. */
      const keys = [...this.#objects.keys()]
        .filter(
          /**
           * Selects only objects within the requested S3 prefix.
           * @param key - Bucket-qualified fake object key.
           * @returns Whether the key begins with the requested prefix.
           */
          (key) => key.startsWith(prefix),
        )
        .slice(0, maximum)
        .map(
          /**
           * Projects the SDK's bucket-relative object-list entry.
           * @param key - Bucket-qualified fake object key.
           * @returns Frozen AWS SDK-shaped list entry.
           */
          (key) => Object.freeze({ Key: key.slice(bucket.length + 1) }),
        );
      return Object.freeze({ Contents: Object.freeze(keys) });
    }
    throw new Error(`Unexpected AWS SDK command: ${command.constructor.name}`);
  }

  /** Records SDK destruction without mutating persisted fixture objects. */
  destroy(): void {
    this.destroyCount += 1;
  }

  /**
   * Builds the AWS SDK failure shape used for ordinary CAS conflicts.
   * @returns PreconditionFailed service exception with HTTP 412 metadata.
   */
  #preconditionFailure(): Error {
    /** Production classification reads only this stable SDK evidence. */
    const error = new Error('precondition') as FakeS3ServiceError;
    error.name = 'PreconditionFailed';
    error.$metadata = { httpStatusCode: 412 };
    return error;
  }
}

/** Owned SDK fixture whose destruction proves retained close rejection semantics. */
class FailingDestroyS3Client extends FakeS3Client {
  /**
   * Rejects owned transport cleanup after recording the attempted destruction.
   * @throws {Error} The stable fixture cleanup failure.
   */
  override destroy(): void {
    super.destroy();
    throw new Error('fixture S3 destroy failed');
  }
}

/** Candidate target exercises the same public suite through direct immutable S3 revisions. */
const S3_CONFORMANCE_TARGET: CellHostConformanceTarget = Object.freeze({
  name: '@archer/core direct S3 CAS Cells',
  /**
   * Opens one fresh in-memory SDK service for an independent required case.
   * @returns S3-backed conformance fixture with deterministic controls.
   */
  async open() {
    /** Mutable trusted clock moves only when conformance requests lease expiry. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled conformance instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture protects every candidate host operation. */
    const authority = createCellAuthorityFixture(now);
    /** One semantics-faithful fake SDK service persists across host restart. */
    const client = new FakeS3Client();
    /** All candidate hosts are retained for unconditional cleanup. */
    const hosts: CellHost[] = [];
    /** Owner suffix advances deterministically for every replacement host. */
    let owner = 0x40;
    /**
     * Opens one distinct owner against the same fake S3 service.
     * @returns Newly opened direct S3 CAS host.
     */
    const openHost = async () => {
      /** Distinct UUIDv4 suffix becomes the host activation owner. */
      const suffix = (owner++).toString(16).padStart(2, '0');
      /** Production adapter uses real AWS commands against the shared fake service. */
      const host = await s3CasCells({
        ...cellHostOptions(authority, now, inertSchedule),
        /**
         * Generates the deterministic owner captured for this host construction.
         * @returns Distinct valid UUIDv4 text.
         */
        createId: () => `10000000-0000-4000-8000-0000000000${suffix}`,
        bucket: 'archer-conformance',
        prefix: 'cells-conformance',
        stateLimitBytes: 256 * 1024,
        maxHeadsPerScan: 100,
        transport: {
          type: 'client',
          client: { ownership: 'borrowed', value: client as unknown as S3Client },
        },
      });
      hosts.push(host);
      return host;
    };
    /** Initial candidate host used by the required case executor. */
    const host = await openHost();
    return Object.freeze({
      host,
      subject: CELL_SUBJECT,
      grants: authority.grants,
      /** Advances beyond the configured one-hundred-millisecond lease. */
      expireLease() {
        instant += 200;
      },
      openPeer: openHost,
      restart: openHost,
      /** Releases every host while preserving borrowed SDK ownership. */
      async dispose() {
        await Promise.all(
          hosts.map(
            /**
             * Releases one host while preserving borrowed fake SDK ownership.
             * @param candidate - Host opened during this isolated case.
             * @returns Retained host close settlement.
             */
            (candidate) => candidate.close(),
          ),
        );
        await authority.ledger.close();
      },
    });
  },
});

describe('S3 CAS Cells', () => {
  it('binds trusted-service permissions once and closes host plus policy together', async () => {
    /** Borrowed fake SDK proves service cleanup does not claim caller-owned transport. */
    const client = new FakeS3Client();
    /** Primary service path creates its own host-wide process policy. */
    const service = await s3Cells({
      hostId: CELL_HOST_ID,
      leaseDurationMilliseconds: 100,
      observationRetentionItems: 32,
      now: fixedClock,
      schedule: inertSchedule,
      bucket: 'archer-service',
      prefix: 'deliveries',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client',
        client: { ownership: 'borrowed', value: client as unknown as S3Client },
      },
    });
    /** Application code supplies its domain inputs without repeating Authority arguments. */
    const created = await service.create({
      cellId: CELL_ID,
      initialState: { count: 0 },
      protocol: createCounterProtocol(),
      idempotencyKey: CELL_CREATE_KEY,
    });
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected service-bound Cell to open');

    /** Bound dispatch proves the handle also avoids repeated subject and grant plumbing. */
    const dispatched = await service.dispatch(created.handle, {
      event: { type: 'increment', amount: 1 },
      idempotencyKey: CELL_COMMAND_KEY,
    });
    expect(dispatched.kind).toBe('acknowledged');

    /** One service close returns evidence for both resources and preserves the borrowed SDK. */
    const closed = await service.close();
    expect(closed).toMatchObject({
      kind: 'cell-service-closed',
      host: { kind: 'cell-host-closed' },
      authority: { kind: 'authority-broker-closed' },
    });
    expect(await service.closed).toEqual(closed);
    expect(client.destroyCount).toBe(0);
  });

  it('rejects retained host closure with the same owned transport failure as close', async () => {
    /** Real Authority fixture remains borrowed so only SDK cleanup can reject. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Explicitly owned client rejects its one destruction attempt. */
    const client = new FailingDestroyS3Client();
    /** Successfully opened host transfers the failing client lifecycle. */
    const host = await s3CasCells({
      ...cellHostOptions(authority, fixedClock),
      bucket: 'archer-close-failure',
      prefix: 'deliveries',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client',
        client: { ownership: 'owned', value: client as unknown as S3Client },
      },
    });

    /** Observes retained lifecycle before close so no terminal settlement can be missed. */
    const retainedSettlement = host.closed.then(
      /**
       * Rejects a false successful retained closure.
       * @returns Fixture failure that cannot equal the real close rejection.
       */
      () => new Error('expected retained host closure to reject'),
      /**
       * Returns the exact rejection identity observed by the retained lifecycle.
       * @param error - Owned transport cleanup rejection.
       * @returns Unchanged rejection identity.
       */
      (error: unknown) => error,
    );
    /** Captures the exact rejection identity returned by active closure. */
    const closeFailure = await host.close().then(
      /**
       * Rejects a false successful close before it can satisfy the assertion.
       * @returns Fixture failure that cannot equal the retained close rejection.
       */
      () => new Error('expected host close to reject'),
      /**
       * Returns the exact owned transport failure retained by the close Promise.
       * @param error - Owned transport cleanup rejection.
       * @returns Unchanged rejection identity.
       */
      (error: unknown) => error,
    );
    /** A settled microtask wins only if the retained `closed` Promise was left pending. */
    const retainedFailure = await Promise.race([retainedSettlement, Promise.resolve('pending')]);

    expect(closeFailure).toBeInstanceOf(Error);
    expect((closeFailure as Error).message).toBe('fixture S3 destroy failed');
    expect(retainedFailure).toBe(closeFailure);
    expect(client.destroyCount).toBe(1);

    await authority.ledger.close();
  });

  it('destroys an owned client when later host configuration is refused', async () => {
    /** Real Authority fixture keeps failure focused on the invalid storage namespace. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Owned fake client records whether failed construction releases its transport. */
    const client = new FakeS3Client();

    await expect(
      s3CasCells({
        ...cellHostOptions(authority, fixedClock),
        bucket: 'archer-invalid-configuration',
        prefix: '../cells',
        stateLimitBytes: 256 * 1024,
        maxHeadsPerScan: 10,
        transport: {
          type: 'client',
          client: { ownership: 'owned', value: client as unknown as S3Client },
        },
      }),
    ).rejects.toThrow('S3 Cell prefix must be non-empty and contain no traversal segments');
    expect(client.destroyCount).toBe(1);

    await authority.ledger.close();
  });

  it('probes, acknowledges through head CAS, restores revisions, and preserves borrowed client ownership', async () => {
    /** Real Authority fixture protects all host operations. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Semantics-faithful borrowed fake observes destruction and persists objects. */
    const client = new FakeS3Client();
    /** Counter protocol owns deterministic state transitions and codecs. */
    const protocol = createCounterProtocol();
    /** Shared adapter configuration reopens the same durable namespace. */
    const base = {
      ...cellHostOptions(authority, fixedClock),
      bucket: 'archer-test',
      prefix: 'cells-test',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 100,
      transport: {
        type: 'client' as const,
        client: { ownership: 'borrowed' as const, value: client as unknown as S3Client },
      },
    };
    /** Initial host starts only after passing the live conditional-object probe. */
    const host = await s3CasCells(base);

    expect(host.storageProbe.guarantees).toEqual({
      conditionalCreate: true,
      conditionalUpdate: true,
      retiredTokenRejected: true,
      immutableRead: true,
    });
    /** Generation-zero outcome transfers a hot handle after head creation. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected S3 Cell to open');
    expect(
      await created.handle.dispatch(
        { subject: CELL_SUBJECT, event: { type: 'increment', amount: 4 }, idempotencyKey: CELL_COMMAND_KEY },
        authority.grants.dispatch,
      ),
    ).toMatchObject({ kind: 'acknowledged', acknowledgement: { sequence: '1' } });
    await host.close();
    expect(client.destroyCount).toBe(0);

    /** Replacement host uses the same borrowed SDK service and object namespace. */
    const restarted = await s3CasCells(base);
    /** Compatible attach walks the reachable immutable revision chain. */
    const attached = await restarted.attach(
      { cellId: CELL_ID, subject: CELL_SUBJECT, protocol },
      authority.grants.attach,
    );
    expect(attached.kind).toBe('opened');
    if (attached.kind !== 'opened') throw new Error('Expected S3 Cell to restore');
    expect(attached.handle.getSnapshot().acknowledged.state).toEqual({ count: 4 });

    await restarted.close();
    expect(client.destroyCount).toBe(0);
    await authority.ledger.close();
  });

  it('refuses an oversized decision before S3 publication and preserves acknowledged state', async () => {
    /** Real Authority fixture verifies create, dispatch, and finite state read. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Semantics-faithful fake makes the capacity claim independent from a live account. */
    const client = new FakeS3Client();
    /** Counter state remains small while its first retained command receipt crosses this bound. */
    const protocol = createCounterProtocol();
    /** Direct host applies its declared mutable-record limit before immutable publication. */
    const host = await s3CasCells({
      ...cellHostOptions(authority, fixedClock),
      bucket: 'archer-capacity',
      prefix: 'cells',
      stateLimitBytes: 800,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client',
        client: { ownership: 'borrowed', value: client as unknown as S3Client },
      },
    });
    /** Generation-zero record fits the selected deployment bound. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    if (created.kind !== 'opened') throw new Error('Expected bounded generation zero to open');

    /** First decision adds receipt evidence that must be refused atomically when oversized. */
    const outcome = await created.handle.dispatch(
      { subject: CELL_SUBJECT, event: { type: 'increment', amount: 1 }, idempotencyKey: CELL_COMMAND_KEY },
      authority.grants.dispatch,
    );
    /** Canonical read proves the refused decision did not alter prior acknowledged state. */
    const state = await host.readState(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        protocolRevision: protocol.protocolRevision,
        stateCodec: protocol.codecs.state,
      },
      authority.grants.read,
    );

    expect(outcome).toEqual({ kind: 'refused', reason: 'capacity-exceeded' });
    expect(state).toMatchObject({ kind: 'found', sequence: '0', state: { count: 0 } });

    await host.close();
    await authority.ledger.close();
  });

  it('passes every public CellHost conformance case through direct S3 revisions', async () => {
    /** Complete report proves required/executed/skipped cardinality as well as status. */
    const report = await runCellHostConformance(S3_CONFORMANCE_TARGET);

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({ required: 8, executed: 8, skipped: 0 });
    expect(
      report.cases.every(
        /**
         * Requires each case result rather than trusting aggregate status alone.
         * @param result - One required conformance case result.
         * @returns Whether this exact case passed.
         */
        (result) => result.status === 'passed',
      ),
    ).toBe(true);
  });

  it('discovers an expired Cell whose durable wake is due without exposing its state', async () => {
    /** Mutable trusted clock crosses wake and lease boundaries explicitly. */
    let instant = Date.parse('2026-08-24T00:00:01.000Z');
    /**
     * Reads the explicitly controlled discovery instant.
     * @returns Current deterministic fixture time.
     */
    const now = () => new Date(instant);
    /** Real Authority fixture protects create and discovery independently. */
    const authority = createCellAuthorityFixture(now);
    /** Shared fake service persists the discoverable head across host replacement. */
    const client = new FakeS3Client();
    /** Counter protocol persists a wake shortly after generation zero. */
    const protocol = createCounterProtocol('2026-08-24T00:00:01.050Z');
    /** Shared adapter configuration uses inert timers so discovery causes recovery. */
    const base = {
      ...cellHostOptions(authority, now, inertSchedule),
      bucket: 'archer-discovery',
      prefix: 'deliveries',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client' as const,
        client: { ownership: 'borrowed' as const, value: client as unknown as S3Client },
      },
    };
    /** Original host persists the Cell and projected wake. */
    const host = await s3CasCells(base);
    /** Generation-zero head contains scan-safe wake metadata. */
    const created = await host.create(
      {
        cellId: CELL_ID,
        subject: CELL_SUBJECT,
        initialState: { count: 0 },
        protocol,
        idempotencyKey: CELL_CREATE_KEY,
      },
      authority.grants.create,
    );
    expect(created.kind).toBe('opened');
    await host.close();

    instant += 100;
    /** Replacement host scans after both ownership and wake become recoverable. */
    const replacement = await s3CasCells(base);
    /** Discovery result must contain identity only. */
    const discovered = await replacement.discoverRecoverable(
      { subject: CELL_SUBJECT, at: TimestampSchema.parse(now().toISOString()) },
      authority.grants.discover,
    );

    expect(discovered).toEqual({ kind: 'found', cellIds: [CELL_ID] });
    expect(client.listPrefixes.at(-1)).toBe('archer-discovery/deliveries/heads/');
    await replacement.close();
    await authority.ledger.close();
  });

  it('refuses recovery discovery after the host lifecycle closes', async () => {
    /** Real Authority fixture remains open so closure, not permission, causes refusal. */
    const authority = createCellAuthorityFixture(fixedClock);
    /** Borrowed fake service would still accept calls if lifecycle admission leaked. */
    const client = new FakeS3Client();
    /** Host closes before any discovery scan. */
    const host = await s3CasCells({
      ...cellHostOptions(authority, fixedClock),
      bucket: 'archer-closed-discovery',
      prefix: 'deliveries',
      stateLimitBytes: 256 * 1024,
      maxHeadsPerScan: 10,
      transport: {
        type: 'client',
        client: { ownership: 'borrowed', value: client as unknown as S3Client },
      },
    });

    await host.close();
    /** Closed-host outcome must return before touching borrowed S3 transport. */
    const discovered = await host.discoverRecoverable(
      { subject: CELL_SUBJECT, at: TimestampSchema.parse(fixedClock().toISOString()) },
      authority.grants.discover,
    );

    expect(discovered).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'cell_host_closed', message: 'CellHost is closed' },
    });
    await authority.ledger.close();
  });
});
