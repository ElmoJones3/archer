/**
 * @file Proves diagnostic conformance evidence exists only for one complete,
 * versioned pass against a named implementation and immutable configuration.
 */

import { describe, expect, it } from 'vitest';

import {
  CORE_DIAGNOSTICS_CONFORMANCE_TARGET,
  DIAGNOSTICS_CONFORMANCE_CASES,
  DiagnosticsConformanceReportSchema,
  requirePassingDiagnosticsConformance,
  runDiagnosticsConformance,
} from '../src/diagnostics/conformance.js';

describe('diagnostics conformance', () => {
  it('passes every required case against the first-party dispatcher', async () => {
    /** Executes the product-neutral suite through its replaceable factory port. */
    const report = await runDiagnosticsConformance({
      target: CORE_DIAGNOSTICS_CONFORMANCE_TARGET,
      implementation: { name: '@archer/core', version: '0.0.0', configuration: { dispatcher: 'bounded-per-sink' } },
      environment: { runtime: 'node-26', platform: 'test' },
      /**
       * Supplies deterministic evidence time for exact report assertions.
       * @returns The fixed conformance instant.
       */
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(report.cases.map((testCase) => testCase.id)).toEqual(
      DIAGNOSTICS_CONFORMANCE_CASES.map((testCase) => testCase.id),
    );
    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({
      required: DIAGNOSTICS_CONFORMANCE_CASES.length,
      executed: report.cases.length,
      skipped: 0,
    });
    expect(report.at).toBe('2026-08-22T00:00:00.000Z');
    expect(report.configurationDigest).toMatch(/^sha256:/u);
    expect(report.evidenceDigest).toMatch(/^sha256:/u);
    expect(DiagnosticsConformanceReportSchema.safeParse(report).success).toBe(true);
    expect(DiagnosticsConformanceReportSchema.safeParse({ ...report, schema: 2 }).success).toBe(false);
    expect(
      DiagnosticsConformanceReportSchema.safeParse({
        ...report,
        implementation: { ...report.implementation, version: '' },
      }).success,
    ).toBe(false);
    expect((await requirePassingDiagnosticsConformance(report)).ok).toBe(true);

    /** Simulates a forged passing summary with its required results removed. */
    const incomplete = { ...report, cases: [], status: 'passed' as const };
    expect(await requirePassingDiagnosticsConformance(incomplete)).toMatchObject({
      ok: false,
      error: { code: 'diagnostics_conformance_failed' },
    });

    /** Changes valid JSON configuration while retaining the original claimed digest. */
    const forgedConfiguration = {
      ...report,
      implementation: { ...report.implementation, configuration: { dispatcher: 'fabricated' } },
    };
    expect(await requirePassingDiagnosticsConformance(forgedConfiguration)).toMatchObject({
      ok: false,
      error: { code: 'diagnostics_conformance_failed' },
    });

    /** Changes digest-covered evidence while preserving a structurally complete passing report. */
    const forgedEvidence = { ...report, environment: { runtime: 'node-26', platform: 'fabricated' } };
    expect(await requirePassingDiagnosticsConformance(forgedEvidence)).toMatchObject({
      ok: false,
      error: { code: 'diagnostics_conformance_failed' },
    });
  });
});
