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
    files: ['examples/**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    rules: {
      // Runnable examples keep documentation on public and application-defining
      // boundaries without burying the program under comments on obvious locals.
      'jsdoc/require-description': [
        'error',
        {
          contexts: [
            'ExportNamedDeclaration > ClassDeclaration',
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > TSInterfaceDeclaration',
            'ExportNamedDeclaration > TSTypeAliasDeclaration',
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
          ],
        },
      ],
      'jsdoc/require-jsdoc': [
        'error',
        {
          contexts: [
            'ExportNamedDeclaration > ClassDeclaration',
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > TSInterfaceDeclaration',
            'ExportNamedDeclaration > TSTypeAliasDeclaration',
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
          ],
          require: {
            ArrowFunctionExpression: false,
            ClassDeclaration: false,
            ClassExpression: false,
            FunctionDeclaration: false,
            FunctionExpression: false,
            MethodDefinition: false,
          },
        },
      ],
      // TypeScript owns parameter and return shapes in examples. Their prose
      // should explain application consequences, not repeat the signature.
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
    },
  },
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
