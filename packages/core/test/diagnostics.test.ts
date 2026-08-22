/**
 * @file Proves diagnostics remain observable, bounded, redacted values whose
 * sink latency and failure cannot control domain work or healthy destinations.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ProtocolFailureSchema,
  borrowed,
  owned,
  type DiagnosticRecord,
  type DiagnosticRecordInput,
  type DiagnosticSink,
} from '../src/index.js';
import { createDiagnosticRecord, createDiagnostics, DiagnosticRecordSchema } from '../src/diagnostics/index.js';
import { deferred } from './temporal-fixtures.js';

/** Immutable sink close evidence used by diagnostics ownership tests. */
type SinkClose = Readonly<{
  /** Identifies normal fixture sink closure. */
  kind: 'closed';
}>;

/**
 * Creates a retained diagnostic sink around test-controlled operations.
 * @param write - Receives each serialized batch accepted by the fixture.
 * @param flush - Flush behavior invoked during attachment close.
 * @returns A retained sink with observable lifecycle calls.
 */
function fixtureSink(
  write: (records: readonly DiagnosticRecord[]) => Promise<void>,
  flush: () => Promise<void> = async () => undefined,
): DiagnosticSink {
  /** Shares one immutable lifecycle result across both close paths. */
  const evidence: SinkClose = Object.freeze({ kind: 'closed' });

  /** Exposes already-settled sink lifecycle for this focused fixture. */
  const closed = Promise.resolve(evidence);

  /** Records whether diagnostics owns and closes this sink. */
  const close = vi.fn(() => closed);

  /** Records flush ordering while preserving caller-selected behavior. */
  const flushSpy = vi.fn(flush);

  return {
    closed,
    close,
    flush: flushSpy,
    write,
    /** Delegates fixture disposal to the same observable close spy. */
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}

/**
 * Creates one valid point diagnostic with a distinctive name.
 * @param name - Stable record name used by delivery assertions.
 * @returns A deterministic normalized point diagnostic.
 */
function record(name: string): DiagnosticRecord {
  return createDiagnosticRecord(
    {
      name,
      severity: 'info',
      component: 'fixture',
      phase: 'point',
      correlation: {},
      attributes: {},
    },
    () => new Date('2026-08-22T00:00:00.000Z'),
  );
}

describe('DiagnosticRecord', () => {
  it('normalizes one versioned product-neutral record into immutable data', () => {
    /** Carries mutable caller input to prove schema-owned copying. */
    const attributes = { attempt: 1 };

    /** Builds one normalized record at an injected deterministic instant. */
    const diagnostic = createDiagnosticRecord(
      {
        name: 'operation.started',
        severity: 'debug',
        component: 'core.operation',
        phase: 'start',
        correlation: {},
        attributes,
      },
      () => new Date('2026-08-22T01:02:03.004Z'),
    );

    attributes.attempt = 2;
    expect(diagnostic).toEqual({
      schema: 1,
      name: 'operation.started',
      severity: 'debug',
      at: '2026-08-22T01:02:03.004Z',
      component: 'core.operation',
      phase: 'start',
      correlation: {},
      attributes: { attempt: 1 },
    });
    expect(DiagnosticRecordSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.attributes)).toBe(true);
  });

  it('keeps schema and observation time under constructor ownership at runtime', () => {
    /** Simulates untyped input carrying fields excluded by DiagnosticRecordInput. */
    const hostile = {
      name: 'operation.started',
      severity: 'info',
      component: 'fixture',
      phase: 'point',
      correlation: {},
      attributes: {},
      schema: 2,
      at: '1999-01-01T00:00:00.000Z',
    } as unknown as DiagnosticRecordInput;

    /** Constructs the record at the only trusted injected instant. */
    const diagnostic = createDiagnosticRecord(hostile, () => new Date('2026-08-22T01:02:03.004Z'));

    expect(diagnostic.schema).toBe(1);
    expect(diagnostic.at).toBe('2026-08-22T01:02:03.004Z');
  });
});

describe('Diagnostics', () => {
  it('does not await a slow sink and preserves independent serialized delivery', async () => {
    /** Holds the slow sink's first write open while another sink advances. */
    const releaseSlow = deferred<void>();

    /** Records every batch accepted by the slow destination. */
    const slowWrites: string[][] = [];

    /** Prevents more than one in-flight write to the slow sink. */
    let slowInFlight = 0;

    /** Proves serialized write calls through an explicit concurrency maximum. */
    let slowMaximum = 0;

    /** Delays only the first batch emitted by the diagnostics dispatcher. */
    const slow = fixtureSink(async (records) => {
      slowInFlight += 1;
      slowMaximum = Math.max(slowMaximum, slowInFlight);
      slowWrites.push(records.map((item) => item.name));
      if (slowWrites.length === 1) await releaseSlow.promise;
      slowInFlight -= 1;
    });

    /** Records healthy delivery independently of slow sink progress. */
    const fastWrites: string[][] = [];
    /** Owns the healthy borrowed destination fixture. */
    const fast = fixtureSink(async (records) => {
      fastWrites.push(records.map((item) => item.name));
    });

    /** Owns both borrowed sinks without acquiring their lifecycle. */
    const diagnostics = createDiagnostics();
    expect('publish' in diagnostics.events).toBe(false);
    expect('close' in diagnostics.events).toBe(false);
    /** Retains the slow destination attachment for deterministic drain. */
    const slowAttachment = diagnostics.attach(borrowed(slow));
    /** Retains the fast destination attachment for deterministic drain. */
    const fastAttachment = diagnostics.attach(borrowed(fast));

    diagnostics.emit(record('one'));
    diagnostics.emit(record('two'));
    await Promise.resolve();
    await Promise.resolve();

    expect(fastWrites.flat()).toEqual(['one', 'two']);
    expect(slowWrites).toEqual([['one']]);
    expect(slowMaximum).toBe(1);

    releaseSlow.resolve();
    await slowAttachment.close();
    await fastAttachment.close();

    expect(slowWrites.flat()).toEqual(['one', 'two']);
    expect(slow.close).not.toHaveBeenCalled();
    expect(fast.close).not.toHaveBeenCalled();
    await diagnostics.close();
  });

  it('detaches a failing sink without retrying or suppressing a healthy sink', async () => {
    /** Rejects every write so retry count remains directly observable. */
    const failingWrite = vi.fn(async () => {
      throw new Error('transport credential leaked here');
    });

    /** Owns the sink so diagnostics must flush and close it after failure. */
    const failing = fixtureSink(failingWrite);

    /** Records delivery unaffected by the failed attachment. */
    const healthyRecords: DiagnosticRecord[] = [];
    /** Owns the healthy borrowed destination fixture. */
    const healthy = fixtureSink(async (records) => {
      healthyRecords.push(...records);
    });

    /** Attaches destinations with the default detach-on-write-failure policy. */
    const diagnostics = createDiagnostics();
    /** Retains the owned failing destination attachment. */
    const failedAttachment = diagnostics.attach(owned(failing));
    /** Retains the borrowed healthy destination attachment. */
    const healthyAttachment = diagnostics.attach(borrowed(healthy));

    diagnostics.emit(record('original'));
    diagnostics.emit(record('queued-one'));
    diagnostics.emit(record('queued-two'));
    expect(await failedAttachment.closed).toMatchObject({
      kind: 'sink-failed',
      acceptedRecords: 3,
      droppedRecords: 3,
      failure: { code: 'diagnostic_sink_write_failed', message: 'A diagnostic sink rejected a write' },
    });
    await Promise.resolve();

    expect(failingWrite).toHaveBeenCalledOnce();
    expect(failing.flush).toHaveBeenCalledOnce();
    expect(failing.close).toHaveBeenCalledOnce();
    expect(healthyRecords.map((item) => item.name)).toEqual([
      'original',
      'queued-one',
      'queued-two',
      'diagnostics.sink_write_failed',
    ]);
    expect(JSON.stringify(healthyRecords)).not.toContain('credential');

    await healthyAttachment.close();
    await diagnostics.close();
  });

  it('turns subscriber-local overflow into one exact diagnostic gap record', async () => {
    /** Holds the first sink write so later records exercise its one-item bound. */
    const releaseFirst = deferred<void>();

    /** Records all batches including the synthesized gap record. */
    const writes: DiagnosticRecord[] = [];
    /** Owns the deliberately blocked destination fixture. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
      if (writes.length === 1) await releaseFirst.promise;
    });

    /** Selects one queued record in addition to the in-flight write. */
    const diagnostics = createDiagnostics();
    /** Retains the one-item sink queue whose gap evidence is asserted. */
    const attachment = diagnostics.attach(borrowed(sink), { delivery: { capacityItems: 1, capacityBytes: 4096 } });

    diagnostics.emit(record('one'));
    await Promise.resolve();
    diagnostics.emit(record('two'));
    diagnostics.emit(record('three'));
    releaseFirst.resolve();
    await attachment.close();

    expect(writes.map((item) => item.name)).toEqual(['one', 'two', 'diagnostics.gap']);
    expect(writes[2]?.attributes).toMatchObject({
      lostItems: 1,
      lostByComponent: { fixture: { info: 1 } },
    });
    await diagnostics.close();
  });

  it('bounds diagnostic gap component cardinality with an explicit other bucket', async () => {
    /** Holds the first destination write while later component names overflow. */
    const releaseFirst = deferred<void>();

    /** Retains synthesized gap evidence delivered by the destination. */
    const writes: DiagnosticRecord[] = [];
    /** Owns the blocked destination used to combine multiple losses. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
      if (writes.length === 1) await releaseFirst.promise;
    });

    /** Limits every synthesized gap to one named component bucket. */
    const diagnostics = createDiagnostics({ gapComponentLimit: 1 });
    /** Retains the one-item queue until its combined gap is delivered. */
    const attachment = diagnostics.attach(borrowed(sink), {
      delivery: { capacityItems: 1, capacityBytes: 4096 },
    });
    diagnostics.emit(record('in-flight'));
    await Promise.resolve();
    diagnostics.emit(record('queued'));
    diagnostics.emit(
      createDiagnosticRecord({
        name: 'lost-a',
        severity: 'warn',
        component: 'component-a',
        phase: 'point',
        correlation: {},
        attributes: {},
      }),
    );
    diagnostics.emit(
      createDiagnosticRecord({
        name: 'lost-b',
        severity: 'error',
        component: 'component-b',
        phase: 'point',
        correlation: {},
        attributes: {},
      }),
    );
    releaseFirst.resolve();
    await attachment.close();

    /** Locates the exact combined loss record independently of write batching. */
    const gap = writes.find((item) => item.name === 'diagnostics.gap');
    expect(gap?.attributes).toMatchObject({
      lostItems: 2,
      lostByComponent: {
        'component-a': { warn: 1 },
        otherComponents: { error: 1 },
      },
    });
    await diagnostics.close();
  });

  it('reserves sink gap delivery when one record alone exceeds the byte bound', async () => {
    /** Records the synthesized gap while rejecting the oversized source record. */
    const writes: DiagnosticRecord[] = [];
    /** Owns the destination that records reserved gap delivery. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
    });

    /** Selects a byte bound smaller than any normalized diagnostic record. */
    const diagnostics = createDiagnostics();
    /** Retains the byte-constrained queue for close and delivery assertions. */
    const attachment = diagnostics.attach(borrowed(sink), { delivery: { capacityItems: 1, capacityBytes: 1 } });
    diagnostics.emit(record('oversized'));
    await Promise.resolve();
    await Promise.resolve();

    expect(writes.map((item) => item.name)).toEqual(['diagnostics.gap']);
    expect(writes[0]?.attributes).toMatchObject({ lostItems: 1 });

    await attachment.close();
    await diagnostics.close();
  });

  it('continues after a rejected write only when the attachment selects continue', async () => {
    /** Rejects the first batch and accepts the second without implicit retry. */
    const write = vi.fn(async (records: readonly DiagnosticRecord[]) => {
      if (records[0]?.name === 'one') throw new Error('private sink detail');
    });
    /** Owns the destination using the deliberately rejecting writer. */
    const sink = fixtureSink(write);

    /** Records the operational failure projection delivered to another sink. */
    const observed: DiagnosticRecord[] = [];
    /** Owns a healthy destination that can verify the selected continuation outcome. */
    const observer = fixtureSink(async (records) => {
      observed.push(...records);
    });

    /** Selects explicit continuation for this best-effort destination. */
    const diagnostics = createDiagnostics();
    /** Retains the continuing attachment through both source records. */
    const attachment = diagnostics.attach(borrowed(sink), { onWriteFailure: 'continue' });
    /** Retains the observer until the failure record has drained. */
    const observerAttachment = diagnostics.attach(borrowed(observer));
    diagnostics.emit(record('one'));
    diagnostics.emit(record('two'));
    await attachment.close();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([records]) => records[0]?.name)).toEqual(['one', 'two']);
    expect(await attachment.closed).toMatchObject({ kind: 'sink-failed' });
    await observerAttachment.close();
    expect(observed.find((item) => item.name === 'diagnostics.sink_write_failed')?.outcome).toBe('continued');
    await diagnostics.close();
  });

  it('copies filter selections so caller mutation cannot rewrite sink admission', async () => {
    /** Remains caller-owned and mutable after attachment construction. */
    const names = ['one'];

    /** Records only values admitted by the attachment's copied filter. */
    const writes: DiagnosticRecord[] = [];
    /** Accepts every record that reaches the borrowed sink. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
    });

    /** Captures the filter while it admits only the first record name. */
    const diagnostics = createDiagnostics();
    /** Keeps the copied filter active until both candidate records are emitted. */
    const attachment = diagnostics.attach(borrowed(sink), { filter: { names } });
    names.push('two');
    diagnostics.emit(record('one'));
    diagnostics.emit(record('two'));
    await attachment.close();

    expect(writes.map((item) => item.name)).toEqual(['one']);
    await diagnostics.close();
  });

  it('preserves fulfilled owned-sink close failure evidence', async () => {
    /** Supplies bounded failure evidence through the sink's tagged close result. */
    const failure = ProtocolFailureSchema.parse({
      kind: 'protocol-failure',
      code: 'fixture_close_failed',
      message: 'The fixture sink did not close',
      retryable: false,
    });

    /** Retains the sink's one explicit failed close result. */
    const sinkClose = Object.freeze({ kind: 'failed' as const, failure });

    /** Owns a sink that fulfills rather than rejects with teardown failure. */
    const sink: DiagnosticSink = {
      closed: Promise.resolve(sinkClose),
      /**
       * Returns the typed teardown failure without throwing it.
       * @returns The fixture's already-known failed close evidence.
       */
      close: async () => sinkClose,
      /**
       * Accepts the empty fixture queue.
       * @returns Settlement of the no-op fixture flush.
       */
      flush: async () => undefined,
      /**
       * Accepts any diagnostic source record.
       * @returns Settlement of the no-op fixture write.
       */
      write: async () => undefined,
      /** Delegates disposal to the same typed close result. */
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    };

    /** Owns and therefore closes the failing destination. */
    const diagnostics = createDiagnostics();
    /** Retains attachment evidence independently of hub closure. */
    const attachment = diagnostics.attach(owned(sink));

    expect(await attachment.close()).toMatchObject({
      kind: 'sink-failed',
      failure: { code: 'fixture_close_failed' },
    });
    await diagnostics.close();
  });

  it('expires a hung sink against the shared deterministic shutdown deadline', async () => {
    /** Never settles the active destination write. */
    const write = deferred<void>();

    /** Lets the test advance shutdown without wall-clock time. */
    const timeout = deferred<void>();

    /** Owns the destination whose active write outlives dispatcher shutdown. */
    const sink = fixtureSink(async () => write.promise);

    /** Injects the only shutdown deadline observed by this hub. */
    const diagnostics = createDiagnostics({
      shutdownTimeoutMs: 25,
      /**
       * Returns a manually settled timeout for deterministic expiration.
       * @param milliseconds - Configured timeout verified by the fixture.
       * @returns The pending shutdown deadline.
       */
      waitForShutdownTimeout(milliseconds) {
        expect(milliseconds).toBe(25);
        return timeout.promise;
      },
    });

    /** Retains timeout evidence after the hub releases its attachment. */
    const attachment = diagnostics.attach(borrowed(sink));
    diagnostics.emit(record('hung'));
    await Promise.resolve();

    /** Starts shared shutdown while the sink write remains in flight. */
    const closing = diagnostics.close();
    timeout.resolve();

    await expect(closing).resolves.toEqual({ kind: 'closed', attachments: 1 });
    expect(await attachment.closed).toMatchObject({
      kind: 'sink-failed',
      failure: { code: 'diagnostic_sink_shutdown_timeout' },
      unconfirmedRecords: 1,
    });
  });

  it('expires a hung sink flush against the deterministic shutdown deadline', async () => {
    /** Never settles destination flush. */
    const flush = deferred<void>();

    /** Lets the test advance shutdown without wall-clock time. */
    const timeout = deferred<void>();

    /** Owns a borrowed destination whose flush cannot block its parent forever. */
    const sink = fixtureSink(
      async () => undefined,
      () => flush.promise,
    );

    /** Injects one deadline shared by drain and flush finalization. */
    const diagnostics = createDiagnostics({
      shutdownTimeoutMs: 25,
      /**
       * Returns a manually settled timeout for deterministic expiration.
       * @returns The pending shutdown deadline.
       */
      waitForShutdownTimeout: () => timeout.promise,
    });
    /** Retains attachment failure evidence after its flush expires. */
    const attachment = diagnostics.attach(borrowed(sink));

    /** Starts finalization before advancing its deterministic deadline. */
    const closing = attachment.close();
    await Promise.resolve();
    timeout.resolve();

    expect(await closing).toMatchObject({
      kind: 'sink-failed',
      failure: { code: 'diagnostic_sink_shutdown_timeout' },
    });
    await diagnostics.close();
  });

  it('expires a hung owned sink close against the deterministic shutdown deadline', async () => {
    /** Never settles the owned destination's retained close operation. */
    const sinkClose = deferred<SinkClose>();

    /** Lets the test advance shutdown without wall-clock time. */
    const timeout = deferred<void>();

    /** Owns a destination whose teardown deliberately never settles. */
    const sink: DiagnosticSink = {
      closed: sinkClose.promise,
      /**
       * Returns the never-settling retained close operation.
       * @returns The manually controlled destination close promise.
       */
      close: () => sinkClose.promise,
      /**
       * Flushes immediately so the test isolates owned close.
       * @returns Settlement of the no-op flush.
       */
      flush: async () => undefined,
      /**
       * Accepts fixture records immediately.
       * @returns Settlement of the no-op write.
       */
      write: async () => undefined,
      /** Delegates disposal to the same retained close operation. */
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    };

    /** Injects one deadline shared through owned destination teardown. */
    const diagnostics = createDiagnostics({
      shutdownTimeoutMs: 25,
      /**
       * Returns a manually settled timeout for deterministic expiration.
       * @returns The pending shutdown deadline.
       */
      waitForShutdownTimeout: () => timeout.promise,
    });
    /** Retains attachment failure evidence after owned close expires. */
    const attachment = diagnostics.attach(owned(sink));

    /** Starts finalization before advancing its deterministic deadline. */
    const closing = attachment.close();
    await Promise.resolve();
    timeout.resolve();

    expect(await closing).toMatchObject({
      kind: 'sink-failed',
      failure: { code: 'diagnostic_sink_shutdown_timeout' },
    });
    await diagnostics.close();
  });
});
