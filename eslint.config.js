/**
 * @file Applies Archer's shared lint contract to the repository.
 */

import archer from '@archer/eslint';

export default [
  {
    ignores: [
      '.private/**',
      '.turbo/**',
      'coverage/**',
      'dist/**',
      'packages/cell-runtime/**',
      'packages/sandbox-runtime/**',
    ],
  },
  ...archer,
  {
    files: ['packages/**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    ignores: ['packages/observability/src/pino.{js,ts}', 'packages/observability/src/pino/**'],
    rules: {
      // Product packages produce Archer diagnostics; only the official adapter may depend on Pino.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pino',
              message: 'Import Pino only inside @archer/observability/pino; produce DiagnosticRecords elsewhere.',
            },
          ],
          patterns: [
            {
              group: ['pino/*'],
              message: 'Import Pino subpaths only inside @archer/observability/pino.',
            },
          ],
        },
      ],
    },
  },
];
