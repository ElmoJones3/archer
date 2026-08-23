/** @file Runs the immutable-tree example and prints its stable JSON evidence. */

import { immutableTreeDemo } from './demo.js';

/** Complete evidence is emitted once so scripts can inspect it deterministically. */
const result = await immutableTreeDemo();
process.stdout.write(`${JSON.stringify(result)}\n`);
