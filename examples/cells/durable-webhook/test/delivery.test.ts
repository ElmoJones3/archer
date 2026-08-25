/** @file Proves outbound webhook attempts stop waiting and report a retryable timeout. */

import {
  CellEffectIdSchema,
  CellIdSchema,
  CellSequenceSchema,
  FenceEpochSchema,
  type AcknowledgedEffectAttempt,
} from '@archer/core/cells';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { webhookEffectAdapter } from '../src/delivery.js';
import type { WebhookEffect } from '../src/domain.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('customer webhook request', () => {
  it('turns the configured request deadline into a saved retry', async () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException('The request took too long', 'TimeoutError'));
    const fetchRequest = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw init.signal.reason;
      throw new Error('Expected the configured timeout signal');
    });
    vi.stubGlobal('fetch', () => {
      throw new Error('The adapter ignored its injected fetch boundary');
    });

    const adapter = webhookEffectAdapter({
      signingSecret: 'test-signing-secret',
      requestTimeoutMilliseconds: 15_000,
      fetch: fetchRequest as typeof fetch,
      createTimeoutSignal: (milliseconds) => {
        expect(milliseconds).toBe(15_000);
        return timeout.signal;
      },
      now: () => new Date('2026-08-24T12:00:00.000Z'),
    });
    const attempt: AcknowledgedEffectAttempt<WebhookEffect> = Object.freeze({
      cellId: CellIdSchema.parse('7a444444-4444-4444-8444-444444444444'),
      effectId: CellEffectIdSchema.parse(`sha256:${'a'.repeat(64)}`),
      causedBy: CellSequenceSchema.parse('1'),
      position: 0,
      effect: Object.freeze({
        type: 'post-json',
        id: CellIdSchema.parse('7a444444-4444-4444-8444-444444444444'),
        url: 'https://customer.example.test/webhooks',
        event: 'invoice.paid',
        data: Object.freeze({ invoiceId: 'invoice-42' }),
      }),
      attempt: 1,
      fence: FenceEpochSchema.parse('1'),
    });

    const operation = await adapter.start(attempt);

    await expect(operation.result).resolves.toMatchObject({
      kind: 'event',
      event: {
        type: 'attempt-finished',
        delivered: false,
        error: 'request timed out',
        retryAt: '2026-08-24T12:00:10.000Z',
      },
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
    await operation.close();
  });
});
