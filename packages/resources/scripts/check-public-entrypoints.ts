/** @file Forces strict consumer checking across every emitted Resources entry point. */

/** Complete emitted module graph a clean TypeScript consumer must be able to resolve. */
export type PublicEntrypointModules = readonly [
  typeof import('../dist/index.js'),
  typeof import('../dist/entrypoints/prompts.js'),
  typeof import('../dist/entrypoints/skills.js'),
  typeof import('../dist/entrypoints/budgets.js'),
  typeof import('../dist/entrypoints/profiles.js'),
  typeof import('../dist/control/index.js'),
  typeof import('../dist/transport/index.js'),
  typeof import('../dist/hydration/index.js'),
];
