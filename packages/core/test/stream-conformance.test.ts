/**
 * @file Proves the published stream conformance suite binds passing evidence to
 * one named implementation, configuration, suite version, and complete case set.
 */

import { describe, expect, it } from 'vitest';

import {
  CORE_STREAM_CONFORMANCE_TARGET,
  STREAM_CONFORMANCE_CASES,
  STREAM_CONFORMANCE_VERSION,
  StreamConformanceReportSchema,
  requirePassingStreamConformance,
  runStreamConformance,
} from '../src/stream/conformance.js';

describe('stream conformance', () => {
  it('passes every required case against the first-party RxJS-backed implementation', async () => {
    /** Runs the public suite through the same factory port third-party runtimes implement. */
    const report = await runStreamConformance({
      target: CORE_STREAM_CONFORMANCE_TARGET,
      implementation: { name: '@archer/core', version: '0.0.0', configuration: { runtime: 'rxjs-7.8' } },
      environment: { runtime: 'node-26', platform: 'test' },
      /**
       * Supplies deterministic evidence time for exact report assertions.
       * @returns The fixed conformance instant.
       */
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(report.suiteVersion).toBe(STREAM_CONFORMANCE_VERSION);
    expect(report.cases.map((testCase) => testCase.id)).toEqual(
      STREAM_CONFORMANCE_CASES.map((testCase) => testCase.id),
    );
    expect(report.cases.every((testCase) => testCase.status === 'passed')).toBe(true);
    expect(report.execution).toEqual({
      required: STREAM_CONFORMANCE_CASES.length,
      executed: report.cases.length,
      skipped: 0,
    });
    expect(report.at).toBe('2026-08-22T00:00:00.000Z');
    expect(report.configurationDigest).toMatch(/^sha256:/u);
    expect(report.evidenceDigest).toMatch(/^sha256:/u);
    expect(await requirePassingStreamConformance(report)).toMatchObject({ ok: true, value: { status: 'passed' } });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.implementation.configuration)).toBe(true);
    expect(StreamConformanceReportSchema.safeParse(report).success).toBe(true);
    expect(StreamConformanceReportSchema.safeParse({ ...report, schema: 2 }).success).toBe(false);
    expect(
      StreamConformanceReportSchema.safeParse({
        ...report,
        implementation: { ...report.implementation, name: '' },
      }).success,
    ).toBe(false);

    /** Simulates a forged passing summary with its required results removed. */
    const incomplete = { ...report, cases: [], status: 'passed' as const };
    expect(await requirePassingStreamConformance(incomplete)).toMatchObject({
      ok: false,
      error: { code: 'stream_conformance_failed' },
    });

    /** Changes valid JSON configuration while retaining the original claimed digest. */
    const forgedConfiguration = {
      ...report,
      implementation: { ...report.implementation, configuration: { runtime: 'fabricated' } },
    };
    expect(await requirePassingStreamConformance(forgedConfiguration)).toMatchObject({
      ok: false,
      error: { code: 'stream_conformance_failed' },
    });

    /** Changes digest-covered evidence while preserving a structurally complete passing report. */
    const forgedEvidence = { ...report, environment: { runtime: 'node-26', platform: 'fabricated' } };
    expect(await requirePassingStreamConformance(forgedEvidence)).toMatchObject({
      ok: false,
      error: { code: 'stream_conformance_failed' },
    });
  });
});
