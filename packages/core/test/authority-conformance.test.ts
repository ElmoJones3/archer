/** @file Proves the public Authority conformance catalogue against the reference ledger. */

import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_CONFORMANCE_CASES,
  CORE_AUTHORITY_CONFORMANCE_TARGET,
  requirePassingAuthorityConformance,
  runAuthorityConformance,
} from '../src/authority/conformance.js';

/**
 * Supplies deterministic report time after executable cases finish.
 * @returns Stable conformance evidence instant.
 */
function fixedReportClock(): Date {
  return new Date('2026-08-23T20:00:00.000Z');
}

/** Minimal conformance result shape required by the passing projection. */
interface ConformanceCaseStatus {
  /** Terminal case status produced by the runner. */
  status: 'passed' | 'failed';
}

/**
 * Checks one result for the complete passing-report assertion.
 * @param result - Executed Authority conformance case result.
 * @returns Whether this required case passed.
 */
function casePassed(result: Readonly<ConformanceCaseStatus>): boolean {
  return result.status === 'passed';
}

/**
 * Projects one required case into stable failure identity.
 * @param testCase - Published Authority conformance case.
 * @returns Stable case identity retained by promotion failure.
 */
function caseId(testCase: (typeof AUTHORITY_CONFORMANCE_CASES)[number]) {
  return testCase.id;
}

describe('Authority conformance', () => {
  it('executes and promotes every required case against the in-memory reference ledger', async () => {
    /** Exact implementation identity is retained in the resulting evidence. */
    const report = await runAuthorityConformance({
      target: CORE_AUTHORITY_CONFORMANCE_TARGET,
      implementation: {
        name: '@archer/core memory Authority ledger',
        version: '0.0.0',
        configuration: { durability: 'ephemeral' },
      },
      environment: { runtime: 'node', storage: 'memory' },
      now: fixedReportClock,
    });

    expect(report.status).toBe('passed');
    expect(report.execution).toEqual({
      required: AUTHORITY_CONFORMANCE_CASES.length,
      executed: AUTHORITY_CONFORMANCE_CASES.length,
      skipped: 0,
    });
    expect(report.cases).toHaveLength(AUTHORITY_CONFORMANCE_CASES.length);
    expect(report.cases.every(casePassed)).toBe(true);

    /** Promotion converts a complete report into reusable passing evidence. */
    const passing = await requirePassingAuthorityConformance(report);
    expect(passing.ok).toBe(true);
  });

  it('refuses promotion after implementation configuration evidence is changed', async () => {
    /** Produces genuine passing evidence before modeling hostile stored-report mutation. */
    const report = await runAuthorityConformance({
      target: CORE_AUTHORITY_CONFORMANCE_TARGET,
      implementation: {
        name: '@archer/core memory Authority ledger',
        version: '0.0.0',
        configuration: { durability: 'ephemeral' },
      },
      environment: { runtime: 'node', storage: 'memory' },
      now: fixedReportClock,
    });
    /** Changes a guarantee-bearing field while preserving the report's claimed digest. */
    const tampered = {
      ...report,
      implementation: {
        ...report.implementation,
        configuration: { durability: 'durable' },
      },
    };

    /** Reverification must notice the configuration digest mismatch. */
    const promotion = await requirePassingAuthorityConformance(tampered);

    expect(promotion).toMatchObject({
      ok: false,
      error: {
        code: 'authority_conformance_failed',
        details: { failedCases: AUTHORITY_CONFORMANCE_CASES.map(caseId) },
      },
    });
  });
});
