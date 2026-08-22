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
];
