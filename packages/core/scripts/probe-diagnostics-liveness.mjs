/**
 * @file Proves the production diagnostics deadline keeps a fresh Node process
 * alive until a hung sink produces terminal shutdown evidence.
 */

import { borrowed } from '../dist/ownership.js';
import { createDiagnosticRecord, createDiagnostics } from '../dist/diagnostics/index.js';

/** Never settles, forcing dispatcher closure through its production deadline. */
const never = new Promise(() => undefined);

/** Exposes one borrowed destination whose first write cannot finish. */
const sink = {
  /** The borrowed fixture itself never closes during this process probe. */
  closed: never,
  /**
   * Preserves the borrowed fixture's unsettled lifecycle.
   * @returns {Promise<never>} The never-settling sink close promise.
   */
  close: () => never,
  /**
   * Flushes immediately so only the active write exercises the deadline.
   * @returns {Promise<void>} Settled fixture flush.
   */
  flush: async () => undefined,
  /**
   * Holds the first accepted record beyond the shutdown deadline.
   * @returns {Promise<never>} The never-settling write promise.
   */
  write: () => never,
  /** Delegates language disposal to the retained close path. */
  async [Symbol.asyncDispose]() {
    await this.close();
  },
};

/** Owns one production-timer dispatcher with a short host-boundary deadline. */
const diagnostics = createDiagnostics({ shutdownTimeoutMs: 10 });
/** Retains the attachment evidence independently of parent closure. */
const attachment = diagnostics.attach(borrowed(sink));
diagnostics.emit(
  createDiagnosticRecord({
    name: 'probe.hung',
    severity: 'info',
    component: 'package-check',
    phase: 'point',
    correlation: {},
    attributes: {},
  }),
);
await Promise.resolve();
await diagnostics.close();

/** Terminal timeout evidence is the reason this process may report success. */
const evidence = await attachment.closed;
if (evidence.failure?.code !== 'diagnostic_sink_shutdown_timeout' || evidence.unconfirmedRecords !== 1) {
  throw new Error('The production shutdown deadline did not preserve terminal evidence');
}
