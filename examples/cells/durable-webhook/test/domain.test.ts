/** @file Keeps webhook delivery rules safe while the runnable application evolves. */

import { TimestampSchema } from '@archer/core';
import { CellIdSchema } from '@archer/core/cells';
import { describe, expect, it } from 'vitest';

import { WEBHOOK_PROTOCOL, initialWebhookState } from '../src/domain.js';

const INITIAL = initialWebhookState(
  CellIdSchema.parse('7a333333-3333-4333-8333-333333333333'),
  'https://example.test/webhooks',
  'invoice.paid',
  { invoiceId: 'invoice-42' },
);
const RETRY_AT = TimestampSchema.parse('2026-08-24T00:00:02.000Z');
const WRONG_RETRY_AT = TimestampSchema.parse('2026-08-24T00:00:03.000Z');

describe('webhook delivery rules', () => {
  it('does not start the same delivery twice', () => {
    const started = WEBHOOK_PROTOCOL.program.reduce(INITIAL, { type: 'start' });

    expect(() => WEBHOOK_PROTOCOL.program.reduce(started.state, { type: 'start' })).toThrow(
      'Webhook delivery can start only from idle state',
    );
    expect(started.state).toMatchObject({ status: 'delivering', attempt: 1 });
  });

  it('stops immediately when the customer rejects a request permanently', () => {
    const started = WEBHOOK_PROTOCOL.program.reduce(INITIAL, { type: 'start' });

    const failed = WEBHOOK_PROTOCOL.program.reduce(started.state, {
      type: 'attempt-finished',
      delivered: false,
      status: 400,
      error: 'customer endpoint rejected request',
    });

    expect(started.state).toMatchObject({ status: 'delivering', attempt: 1 });
    expect(failed.state).toMatchObject({ status: 'failed', attempt: 1, lastStatus: 400 });
  });

  it('runs only the retry that matches the saved deadline', () => {
    const started = WEBHOOK_PROTOCOL.program.reduce(INITIAL, { type: 'start' });
    const waiting = WEBHOOK_PROTOCOL.program.reduce(started.state, {
      type: 'attempt-finished',
      delivered: false,
      error: 'network request failed',
      retryAt: RETRY_AT,
    });

    expect(() =>
      WEBHOOK_PROTOCOL.program.reduce(waiting.state, {
        type: 'retry-due',
        at: WRONG_RETRY_AT,
      }),
    ).toThrow('Webhook retry wake does not match saved delivery state');
    expect(waiting.state).toMatchObject({
      status: 'waiting',
      attempt: 1,
      nextAttemptAt: '2026-08-24T00:00:02.000Z',
    });
  });

  it('rejects saved waiting state with no retry time', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        id: '7a333333-3333-4333-8333-333333333333',
        url: 'https://example.test/webhooks',
        event: 'invoice.paid',
        data: { invoiceId: 'invoice-42' },
        status: 'waiting',
        attempt: 1,
        lastError: 'network request failed',
      }),
    );

    const restored = WEBHOOK_PROTOCOL.codecs.state.decode(bytes);

    expect(restored.ok).toBe(false);
    if (restored.ok) throw new Error('Expected invalid waiting state to be refused');
    expect(restored.error).toBeInstanceOf(Error);
  });
});
