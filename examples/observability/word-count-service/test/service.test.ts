/** @file Proves a real HTTP request produces useful output and one wide record. */

import { createDiagnostics, type DiagnosticRecord } from '@archer/core/diagnostics';
import { describe, expect, it } from 'vitest';

import { startWordCountService } from '../src/service.js';

describe('word-count service application', () => {
  it('counts request text and emits accumulated request context', async () => {
    /** The real diagnostics hub owns the same bounded stream used by adapters. */
    const diagnostics = createDiagnostics();
    /** Observation attaches before the request so the terminal record cannot be missed. */
    const subscription = diagnostics.events.subscribe({ capacityItems: 8 });
    /** A zero port preserves real HTTP semantics without introducing a fixed-port race. */
    const service = await startWordCountService({ diagnostics, port: 0 });
    try {
      /** Fetch crosses the operating system HTTP boundary used by the runnable server. */
      const response = await fetch(new URL('/count', service.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Archer keeps useful work observable.' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ words: 5 });
    } finally {
      await service.close();
      await diagnostics.close();
    }

    /** Closing the source lets this bounded collector terminate without a timer. */
    const records: DiagnosticRecord[] = [];
    /** Every delivery must be an event because this test provisions capacity above the emitted count. */
    for await (const delivery of subscription) {
      if (delivery.kind === 'gap') throw new Error(`Unexpected diagnostic gap: ${delivery.lostItems}`);
      records.push(delivery.value);
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'span',
      name: 'http.request',
      settlement: { kind: 'completed', outcome: 'completed' },
      attributes: {
        http: { method: 'POST', route: '/count', statusCode: 200 },
        request: { bytes: 47 },
        result: { words: 5 },
      },
    });
  });
});
