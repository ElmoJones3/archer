/** @file Proves BudgetPolicy validation, legal narrowing, and one-step allocation. */

import { describe, expect, it } from 'vitest';

import {
  allocateBudget,
  defineBudgetPolicy,
  narrowBudgetPolicy,
  type BudgetAllocation,
  type BudgetAllocationId,
} from '../src/entrypoints/budgets.js';
import { encodeBudgetPolicy } from '../src/transport/index.js';
import { budgetContext, budgetRevisionContext, modelFixture, timestamp, uuid } from './support.js';

describe('BudgetPolicy behavior', () => {
  it('requires at least one positive safe-integer ceiling and installs no unrelated default', () => {
    /** Exercises every numeric category JavaScript accepts but BudgetPolicy must refuse. */
    for (const input of [
      {},
      { outputTokens: 0 },
      { outputTokens: -1 },
      { outputTokens: 1.5 },
      { outputTokens: Number.NaN },
      { wallTimeMs: Number.POSITIVE_INFINITY },
      { outputTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => defineBudgetPolicy(input, budgetContext(10))).toThrow();
    }

    /** Proves output-only policy does not invent an unrelated wall-time ceiling. */
    const outputOnly = defineBudgetPolicy({ outputTokens: 800 }, budgetContext(12));
    /** Proves wall-time-only policy does not invent an unrelated output ceiling. */
    const wallOnly = defineBudgetPolicy({ wallTimeMs: 2_000 }, budgetContext(14));
    expect(outputOnly.ceilings).toEqual({ outputTokens: 800 });
    expect(wallOnly.ceilings).toEqual({ wallTimeMs: 2_000 });
    expect(encodeBudgetPolicy(outputOnly).limits).toEqual({ outputTokens: '800' });
  });

  it('accepts a real narrowing, inherits omissions, and refuses equality or widening without mutation', () => {
    /** Uses both dimensions so inheritance, narrowing, and widening share one exact parent. */
    const parent = defineBudgetPolicy(
      { name: 'Support limits', outputTokens: 2_000, wallTimeMs: 10_000 },
      budgetContext(20, 5),
    );
    /** Omits wall time to prove child narrowing inherits the parent dimension. */
    const narrowed = narrowBudgetPolicy(parent, { outputTokens: 1_000 }, budgetRevisionContext(22, 4));
    /** Requests no behavioral change to prove pure revision refuses decorative children. */
    const equal = narrowBudgetPolicy(parent, {}, budgetRevisionContext(24, 6));
    /** Widens only wall time so the refusal names the exact changed dimension. */
    const widened = narrowBudgetPolicy(parent, { wallTimeMs: 10_001 }, budgetRevisionContext(26, 6));
    /** Reuses the stable logical identity to prove a valid narrowing cannot create ambiguous lineage. */
    const collidingLogicalId = narrowBudgetPolicy(
      parent,
      { outputTokens: 900 },
      {
        revisionId: parent.id as never,
        observedAt: timestamp(6),
      },
    );

    expect(narrowed).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: parent.id,
        previousRevisionId: parent.revisionId,
        updatedAt: parent.updatedAt,
        ceilings: { outputTokens: 1_000, wallTimeMs: 10_000 },
      }),
    });
    expect(equal).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_budget_no_change' }) });
    expect(widened).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'budget_widening_refused',
        details: { dimension: 'wallTimeMs', current: 10_000, proposed: 10_001 },
      }),
    });
    expect(collidingLogicalId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'budget_limit_invalid' }),
    });
    expect(parent.ceilings).toEqual({ outputTokens: 2_000, wallTimeMs: 10_000 });
  });

  it('intersects policy, parent, application, request, and model bounds into exact evidence', () => {
    /** Supplies both reusable ceilings for full multi-source allocation intersection. */
    const policy = defineBudgetPolicy({ outputTokens: 4_000, wallTimeMs: 20_000 }, budgetContext(30));
    /** Adds a tighter Model output ceiling to prove the selected Model participates. */
    const model = modelFixture(32, 3_000);
    /** Creates delegated authority through production allocation rather than a structural fixture. */
    const parent = allocateBudget({
      allocationId: uuid(34) as BudgetAllocationId,
      policy,
      model,
      applicationLimits: { outputTokens: 2_500, wallTimeMs: 15_000 },
      startedAt: timestamp(),
    });
    if (!parent.ok) throw parent.error;
    /** Requests values within every bound so the exact minimum and deadline are observable. */
    const allocated = allocateBudget({
      allocationId: uuid(35) as BudgetAllocationId,
      policy,
      model,
      request: { outputTokens: 1_500 },
      parent: parent.value,
      applicationLimits: { outputTokens: 2_000, wallTimeMs: 8_000 },
      startedAt: timestamp(1),
    });

    expect(allocated).toEqual({
      ok: true,
      value: expect.objectContaining({
        outputTokens: 1_500,
        startedAt: timestamp(1),
        deadline: timestamp(9),
        parentId: parent.value.id,
      }),
    });
  });

  it('refuses requested widening in stable source order and reports exact source and dimension', () => {
    /** Makes policy the first violated bound in the documented refusal precedence. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000, wallTimeMs: 10_000 }, budgetContext(40));
    /** Adds tighter later sources to prove policy refusal still wins deterministically. */
    const model = modelFixture(42, 500);
    /** Demands one token beyond policy while leaving wall time legal. */
    const refusal = allocateBudget({
      allocationId: uuid(44) as BudgetAllocationId,
      policy,
      model,
      request: { outputTokens: 1_001 },
      applicationLimits: { outputTokens: 900 },
      startedAt: timestamp(),
    });

    expect(refusal).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'budget_request_widens_bound',
        details: { source: 'policy', dimension: 'outputTokens', requested: 1_001, bound: 1_000 },
      }),
    });
  });

  it('refuses an expired parent before deriving child evidence', () => {
    /** Uses a simple policy so parent-expiry refusal is isolated from other bounds. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000, wallTimeMs: 1_000 }, budgetContext(50));
    /** Matches the policy ceiling so the selected Model cannot cause widening. */
    const model = modelFixture(52, 1_000);
    /** Creates a real parent whose one-second deadline equals the child start time. */
    const parent = allocateBudget({
      allocationId: uuid(54) as BudgetAllocationId,
      policy,
      model,
      request: { outputTokens: 800 },
      startedAt: timestamp(),
    });
    if (!parent.ok) throw parent.error;

    expect(
      allocateBudget({
        allocationId: uuid(55) as BudgetAllocationId,
        policy,
        model,
        parent: parent.value,
        startedAt: timestamp(1),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'budget_parent_expired' }) });
  });

  it('refuses a child allocation that starts before its parent without mutating either input', () => {
    /** Uses output-only authority so causal time is the only disputed parent invariant. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000 }, budgetContext(56));
    /** Keeps Model capacity equal to policy so neither output source can cause refusal. */
    const model = modelFixture(58, 1_000);
    /** Earns a genuine parent at second two before proposing an earlier child start. */
    const parent = allocateBudget({
      allocationId: uuid(60) as BudgetAllocationId,
      policy,
      model,
      startedAt: timestamp(2),
    });
    if (!parent.ok) throw parent.error;
    /** Freezes the complete proposed child so refusal must preserve caller-owned input. */
    const input = Object.freeze({
      allocationId: uuid(61) as BudgetAllocationId,
      policy,
      model,
      parent: parent.value,
      startedAt: timestamp(1),
    });
    /** Snapshots both authorities before the causal refusal is evaluated. */
    const before = JSON.stringify({ input, parent: parent.value });

    /** Evaluates the impossible child start through ordinary allocation behavior. */
    const child = allocateBudget(input);

    expect(child).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_invalid_budget_allocation' }),
    });
    expect(JSON.stringify({ input, parent: parent.value })).toBe(before);
  });

  it('refuses an absolute deadline outside the supported timestamp range', () => {
    /** Uses a maximum safe duration so overflow is caused by deadline arithmetic, not input admission. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000, wallTimeMs: Number.MAX_SAFE_INTEGER }, budgetContext(70));
    /** Keeps the Model ceiling equal so deadline overflow remains the only refusal. */
    const model = modelFixture(72, 1_000);

    expect(
      allocateBudget({
        allocationId: uuid(74) as BudgetAllocationId,
        policy,
        model,
        startedAt: timestamp(),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'budget_deadline_overflow' }) });
  });

  it('refuses forged allocation identity and parent authority', () => {
    /** Creates exact policy and Model behavior so allocation provenance is the only disputed input. */
    const policy = defineBudgetPolicy({ outputTokens: 1_000, wallTimeMs: 5_000 }, budgetContext(62));
    /** Keeps Model capacity outside the refusal path. */
    const model = modelFixture(64, 1_000);
    /** Earns a real parent before copying its fields to erase runtime provenance. */
    const parent = allocateBudget({
      allocationId: uuid(66) as BudgetAllocationId,
      policy,
      model,
      startedAt: timestamp(),
    });
    if (!parent.ok) throw parent.error;
    /** Structural copying retains every field but must not retain delegated Budget authority. */
    const forgedParent = { ...parent.value } as BudgetAllocation;

    expect(
      allocateBudget({
        allocationId: 'not-a-uuid' as BudgetAllocationId,
        policy,
        model,
        startedAt: timestamp(1),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_invalid_budget_allocation' }) });
    expect(
      allocateBudget({
        allocationId: uuid(67) as BudgetAllocationId,
        policy,
        model,
        parent: forgedParent,
        startedAt: timestamp(1),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: 'resources_invalid_budget_allocation' }) });
  });
});
