/**
 * @file Proves diagnostics remain observable, bounded, redacted values whose
 * sink latency and failure cannot control domain work or healthy destinations.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ProtocolFailureSchema,
  UuidV4Schema,
  borrowed,
  owned,
  type DiagnosticEventInput,
  type DiagnosticRecord,
  type DiagnosticSink,
} from '../src/index.js';
import {
  createDiagnosticEvent,
  createDiagnostics,
  DiagnosticRecordSchema,
  DiagnosticSpanRecordSchema,
  withDiagnosticSpan,
} from '../src/diagnostics/index.js';
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
  return createDiagnosticEvent(
    {
      name,
      severity: 'info',
      component: 'fixture',
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
    const diagnostic = createDiagnosticEvent(
      {
        name: 'operation.started',
        severity: 'debug',
        component: 'core.operation',
        correlation: {},
        attributes,
      },
      () => new Date('2026-08-22T01:02:03.004Z'),
    );

    attributes.attempt = 2;
    expect(diagnostic).toEqual({
      schema: 1,
      kind: 'event',
      name: 'operation.started',
      severity: 'debug',
      at: '2026-08-22T01:02:03.004Z',
      component: 'core.operation',
      correlation: {},
      attributes: { attempt: 1 },
    });
    expect(DiagnosticRecordSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.attributes)).toBe(true);
  });

  it('rejects caller-owned schema and observation time at the strict event-input boundary', () => {
    /** Simulates untyped input carrying fields excluded by DiagnosticEventInput. */
    const hostile = {
      name: 'operation.started',
      severity: 'info',
      component: 'fixture',
      correlation: {},
      attributes: {},
      schema: 2,
      at: '1999-01-01T00:00:00.000Z',
    } as unknown as DiagnosticEventInput;

    expect(() => createDiagnosticEvent(hostile, () => new Date('2026-08-22T01:02:03.004Z'))).toThrow(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: 'unrecognized_keys',
            keys: ['schema', 'at'],
          }),
        ],
      }),
    );
  });
});

describe('Diagnostics', () => {
  it('accumulates one explicit span and emits only its terminal wide record', async () => {
    /** Supplies deterministic wall instants for span start and settlement. */
    const wallInstants = [new Date('2026-08-22T01:00:00.000Z'), new Date('2026-08-22T01:00:00.250Z')];
    /** Returns the next controlled wall instant without reading host time. */
    const now = vi.fn(() => wallInstants.shift() ?? new Date('2026-08-22T01:00:00.250Z'));
    /** Supplies deterministic monotonic readings independent of wall-clock adjustment. */
    const monotonicReadings = [100, 137.5];
    /** Returns the next controlled monotonic reading. */
    const monotonicNow = vi.fn(() => monotonicReadings.shift() ?? 137.5);
    /** Gives the span one stable source-owned UUIDv4. */
    const spanId = '00000000-0000-4000-8000-000000000010';

    /** Records every normalized value a future Pino sink would receive. */
    const writes: DiagnosticRecord[] = [];
    /** Accepts terminal records without adding destination behavior to the proof. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
    });

    /** Supplies future span options through the current public factory boundary. */
    const diagnostics = createDiagnostics({
      now,
      monotonicNow,
      /**
       * Returns this test's stable process-local span identity.
       * @returns The deterministic UUIDv4 fixture.
       */
      createSpanId: () => spanId,
    });
    /** Retains the recording destination until duplicate settlement has been refused. */
    const attachment = diagnostics.attach(borrowed(sink));

    /** Begins one concrete model attempt with context known at admission. */
    const span = diagnostics.beginSpan({
      name: 'model.step',
      component: 'models.ai-sdk',
      correlation: { attemptId: UuidV4Schema.parse('00000000-0000-4000-8000-000000000011') },
      attributes: { model: { provider: 'openai' } },
    });

    /** Remains caller-owned so the span must not retain its later mutation. */
    const request = { toolCount: 2 };
    expect(span.enrich('request', request)).toEqual({ ok: true, value: undefined });
    request.toolCount = 99;
    await Promise.resolve();
    expect(writes).toEqual([]);

    /** Settles the span once and therefore emits its one wide record. */
    const completion = span.complete({ outcome: 'completed' });
    expect(completion).toMatchObject({ ok: true, value: { kind: 'span' } });
    /** Refuses a second terminal transition rather than emitting another record. */
    expect(span.complete({ outcome: 'duplicated' })).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_already_settled' },
    });

    await attachment.close();
    expect(writes).toEqual([
      {
        schema: 1,
        kind: 'span',
        name: 'model.step',
        severity: 'info',
        at: '2026-08-22T01:00:00.250Z',
        component: 'models.ai-sdk',
        spanId,
        startedAt: '2026-08-22T01:00:00.000Z',
        durationMs: 37.5,
        settlement: { kind: 'completed', outcome: 'completed' },
        enrichment: { acceptedUpdates: 1, rejectedUpdates: 0, rejectedBytes: '0' },
        correlation: { attemptId: '00000000-0000-4000-8000-000000000011' },
        attributes: {
          model: { provider: 'openai' },
          request: { toolCount: 2 },
        },
      },
    ]);
    await diagnostics.close();
  });

  it('refuses over-budget enrichment without changing admitted span context', async () => {
    /** Gives this focused span one deterministic identity and zero duration. */
    const diagnostics = createDiagnostics({
      /**
       * Returns one stable wall instant for start and settlement.
       * @returns The deterministic fixture instant.
       */
      now: () => new Date('2026-08-22T02:00:00.000Z'),
      /**
       * Returns one stable monotonic reading for a zero-duration span.
       * @returns The deterministic monotonic millisecond value.
       */
      monotonicNow: () => 10,
      /**
       * Returns this test's stable span identity.
       * @returns The deterministic UUIDv4 fixture.
       */
      createSpanId: () => '00000000-0000-4000-8000-000000000020',
      spanLimits: { maxNamespaces: 1, maxAttributeBytes: 1024 },
    });
    /** Starts at the namespace limit with one valid source-owned context object. */
    const span = diagnostics.beginSpan({
      name: 'tool.invoke',
      component: 'agent.tools',
      correlation: {},
      attributes: { tool: { name: 'read_file' } },
    });

    /** Proposes a valid second namespace so only the configured limit can refuse it. */
    const refused = span.enrich('request', { pathCount: 2 });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'diagnostic_span_enrichment_rejected',
        details: { namespace: 'request', reason: 'namespace_limit' },
      },
    });
    expect(span.state).toBe('open');

    /** Replaces the existing namespace without expanding cardinality. */
    expect(span.enrich('tool', { name: 'read_file', cache: 'miss' })).toEqual({ ok: true, value: undefined });
    /** Earns the only terminal record after both update decisions. */
    const completed = span.complete({ outcome: 'completed' });
    expect(completed).toMatchObject({
      ok: true,
      value: {
        attributes: { tool: { name: 'read_file', cache: 'miss' } },
        enrichment: { acceptedUpdates: 1, rejectedUpdates: 1 },
      },
    });
    if (!completed.ok) throw completed.error;
    expect(BigInt(completed.value.enrichment.rejectedBytes)).toBeGreaterThan(0n);
    expect(DiagnosticSpanRecordSchema.parse(completed.value)).toEqual(completed.value);

    /** Refuses post-settlement enrichment without rewriting terminal evidence. */
    expect(span.enrich('tool', { name: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_already_settled' },
    });
    expect(completed.value.enrichment).toMatchObject({ acceptedUpdates: 1, rejectedUpdates: 1 });
    await diagnostics.close();
  });

  it('refuses over-budget initial context without preventing observed work', async () => {
    /** Retains a valid span even when its optional starting context exceeds policy. */
    const diagnostics = createDiagnostics({
      /**
       * Returns one stable wall instant for start and settlement.
       * @returns The deterministic fixture instant.
       */
      now: () => new Date('2026-08-22T02:30:00.000Z'),
      /**
       * Returns one stable monotonic reading for a zero-duration span.
       * @returns The deterministic monotonic millisecond value.
       */
      monotonicNow: () => 15,
      /**
       * Returns this test's stable span identity.
       * @returns The deterministic UUIDv4 fixture.
       */
      createSpanId: () => '00000000-0000-4000-8000-000000000025',
      spanLimits: { maxNamespaces: 1, maxAttributeBytes: 128 },
    });

    /** Supplies two valid namespaces so policy, rather than schema shape, refuses admission. */
    const span = diagnostics.beginSpan({
      name: 'model.step',
      component: 'models.ai-sdk',
      correlation: {},
      attributes: {
        model: { provider: 'openai' },
        request: { toolCount: 2 },
      },
    });
    /** Settles ordinary work after the best-effort initial diagnostic context was refused. */
    const completed = span.complete({ outcome: 'completed' });

    expect(completed).toMatchObject({
      ok: true,
      value: {
        attributes: {},
        enrichment: { acceptedUpdates: 0, rejectedUpdates: 1 },
      },
    });
    if (!completed.ok) throw completed.error;
    expect(BigInt(completed.value.enrichment.rejectedBytes)).toBeGreaterThan(0n);
    await diagnostics.close();
  });

  it('returns a focused Result when runtime settlement input is invalid', async () => {
    /** Supplies distinct source-owned identities for each malformed command branch. */
    const spanIds = [
      '00000000-0000-4000-8000-000000000027',
      '00000000-0000-4000-8000-000000000028',
      '00000000-0000-4000-8000-000000000029',
    ];
    /** Owns deterministic spans whose states must survive malformed command data. */
    const diagnostics = createDiagnostics({
      /**
       * Returns one stable wall instant for start and settlement.
       * @returns The deterministic fixture instant.
       */
      now: () => new Date('2026-08-22T02:45:00.000Z'),
      /**
       * Returns one stable monotonic reading for a zero-duration span.
       * @returns The deterministic monotonic millisecond value.
       */
      monotonicNow: () => 17,
      /**
       * Returns distinct stable identities for each validation branch.
       * @returns The next deterministic UUIDv4 fixture.
       */
      createSpanId: () => spanIds.shift() ?? '00000000-0000-4000-8000-00000000002a',
    });
    /** Begins valid work before an untyped transport supplies malformed settlement. */
    const completionSpan = diagnostics.beginSpan({
      name: 'fixture.validate.complete',
      component: 'fixture',
      correlation: {},
    });
    /** Simulates runtime input that bypassed TypeScript but not the behavior boundary. */
    const malformedCompletion = { outcome: '' } as Parameters<typeof completionSpan.complete>[0];

    expect(completionSpan.complete(malformedCompletion)).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_settlement_rejected' },
    });
    expect(completionSpan.state).toBe('open');
    expect(completionSpan.complete({ outcome: 'completed' })).toMatchObject({ ok: true });

    /** Begins independent work so malformed failure cannot inherit prior settlement. */
    const failureSpan = diagnostics.beginSpan({
      name: 'fixture.validate.fail',
      component: 'fixture',
      correlation: {},
    });
    /** Omits the required public failure shape at an untyped runtime boundary. */
    const malformedFailure = { outcome: 'failed', error: {} } as Parameters<typeof failureSpan.fail>[0];
    expect(failureSpan.fail(malformedFailure)).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_settlement_rejected' },
    });
    expect(failureSpan.state).toBe('open');

    /** Begins independent work so malformed abandonment has its own preserved state. */
    const abandonmentSpan = diagnostics.beginSpan({
      name: 'fixture.validate.abandon',
      component: 'fixture',
      correlation: {},
    });
    /** Supplies an empty reason that the runtime schema must refuse. */
    const malformedAbandonment = { reason: '' } as Parameters<typeof abandonmentSpan.abandon>[0];
    expect(abandonmentSpan.abandon(malformedAbandonment)).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_settlement_rejected' },
    });
    expect(abandonmentSpan.state).toBe('open');
    await diagnostics.close();
  });

  it('abandons every open span before orderly hub shutdown drains its sinks', async () => {
    /** Records the abandonment wide event delivered during hub shutdown. */
    const writes: DiagnosticRecord[] = [];
    /** Accepts the shutdown record without adding destination timing. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
    });
    /** Uses one fixed clock because start and abandonment share this test instant. */
    const diagnostics = createDiagnostics({
      /**
       * Returns one stable wall instant for start and abandonment.
       * @returns The deterministic fixture instant.
       */
      now: () => new Date('2026-08-22T03:00:00.000Z'),
      /**
       * Returns one stable monotonic reading for a zero-duration span.
       * @returns The deterministic monotonic millisecond value.
       */
      monotonicNow: () => 20,
      /**
       * Returns this test's stable span identity.
       * @returns The deterministic UUIDv4 fixture.
       */
      createSpanId: () => '00000000-0000-4000-8000-000000000030',
    });
    diagnostics.attach(borrowed(sink));
    /** Leaves one real production span open for parent-owned shutdown behavior. */
    const span = diagnostics.beginSpan({
      name: 'sandbox.execute',
      component: 'sandbox.runtime',
      correlation: {},
      attributes: { sandbox: { backend: 'docker' } },
    });

    expect(await diagnostics.close()).toEqual({ kind: 'closed', attachments: 1, abandonedSpans: 1 });
    expect(span.state).toBe('abandoned');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: 'span',
      settlement: { kind: 'abandoned', reason: 'diagnostics_shutdown' },
      attributes: { sandbox: { backend: 'docker' } },
    });
    expect(span.complete({ outcome: 'late' })).toMatchObject({
      ok: false,
      error: { code: 'diagnostic_span_already_settled' },
    });
    expect(() =>
      diagnostics.beginSpan({
        name: 'late',
        component: 'fixture',
        correlation: {},
      }),
    ).toThrow(expect.objectContaining({ code: 'diagnostic_span_hub_closed' }));
  });

  it('observes managed work without replacing its value or thrown Error', async () => {
    /** Supplies distinct deterministic identities to the successful and failed spans. */
    const spanIds = ['00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000041'];
    /** Records both automatically settled terminal span records. */
    const writes: DiagnosticRecord[] = [];
    /** Accepts managed-helper output without affecting callback settlement. */
    const sink = fixtureSink(async (records) => {
      writes.push(...records);
    });
    /** Owns deterministic host inputs for both helper invocations. */
    const diagnostics = createDiagnostics({
      /**
       * Returns one stable wall instant for every helper transition.
       * @returns The deterministic fixture instant.
       */
      now: () => new Date('2026-08-22T04:00:00.000Z'),
      /**
       * Returns one stable monotonic reading for zero-duration helper spans.
       * @returns The deterministic monotonic millisecond value.
       */
      monotonicNow: () => 30,
      /**
       * Returns distinct deterministic identities for both helper spans.
       * @returns The next UUIDv4 fixture.
       */
      createSpanId: () => spanIds.shift() ?? '00000000-0000-4000-8000-000000000042',
    });
    /** Retains the destination until both automatic terminal records drain. */
    const attachment = diagnostics.attach(borrowed(sink));

    /** Returns one application value whose identity the observer must preserve. */
    const value = Object.freeze({ answer: 42 });
    /** Exercises automatic success while adding context through the explicit span. */
    const observed = await withDiagnosticSpan(
      diagnostics,
      { name: 'fixture.success', component: 'fixture', correlation: {} },
      (span) => {
        span.enrich('result', { kind: 'answer' });
        return value;
      },
    );
    expect(observed).toBe(value);

    /** Carries private detail that must stay out of the diagnostic record. */
    const exactError = new Error('private callback detail');
    /** Exercises automatic failure and exact Error identity preservation. */
    await expect(
      withDiagnosticSpan(
        diagnostics,
        { name: 'fixture.failure', component: 'fixture', correlation: {} },
        () => {
          throw exactError;
        },
        { code: 'fixture_failed', message: 'Fixture work failed' },
      ),
    ).rejects.toBe(exactError);

    await attachment.close();
    expect(writes.map((item) => (item.kind === 'span' ? item.settlement.kind : item.kind))).toEqual([
      'completed',
      'failed',
    ]);
    expect(writes[1]).toMatchObject({
      kind: 'span',
      settlement: {
        kind: 'failed',
        outcome: 'failed',
        error: { code: 'fixture_failed', message: 'Fixture work failed' },
      },
    });
    expect(JSON.stringify(writes)).not.toContain('private callback detail');
    await diagnostics.close();
  });

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
      createDiagnosticEvent({
        name: 'lost-a',
        severity: 'warn',
        component: 'component-a',
        correlation: {},
        attributes: {},
      }),
    );
    diagnostics.emit(
      createDiagnosticEvent({
        name: 'lost-b',
        severity: 'error',
        component: 'component-b',
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
    /** Narrows the failure observation to its standalone event class. */
    const failure = observed.find((item) => item.name === 'diagnostics.sink_write_failed');
    expect(failure?.kind === 'event' ? failure.outcome : undefined).toBe('continued');
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

    await expect(closing).resolves.toEqual({ kind: 'closed', attachments: 1, abandonedSpans: 0 });
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
