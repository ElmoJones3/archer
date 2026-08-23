/** @file Proves one wide diagnostic reaches both real first-party projections. */

import { describe, expect, it } from 'vitest';

import { diagnosticProjectionDemo } from '../src/demo.js';

describe('diagnostic projections example', () => {
  it('fans one accumulated record to Pino and OpenTelemetry with owned cleanup', async () => {
    expect(await diagnosticProjectionDemo()).toEqual({
      pinoName: 'model.attempt',
      telemetryName: 'model.attempt',
      hasAccumulatedUsage: true,
      telemetryClosed: true,
    });
  });
});
