/** @file Runs both diagnostic projections and prints their shared evidence. */

import { diagnosticProjectionDemo } from './demo.js';

/** Emits one deterministic JSON value after every owned adapter has closed. */
const result = await diagnosticProjectionDemo();
process.stdout.write(`${JSON.stringify(result)}\n`);
