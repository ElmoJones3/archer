/**
 * @file Owns the Prettier choices shared by linting and direct formatting.
 */

import { createRequire } from 'node:module';

/**
 * Resolves Tailwind's formatter from this package so consumers do not need to
 * install or resolve the plugin themselves.
 */
const tailwindPlugin = createRequire(import.meta.url).resolve('prettier-plugin-tailwindcss');

/**
 * Keeps ESLint's Prettier rule and the repository formatter on one exact set of
 * options; changing this value changes both enforcement paths.
 * @type {import('prettier').Config}
 */
const prettierOptions = {
  singleQuote: true,
  trailingComma: 'all',
  tabWidth: 2,
  semi: true,
  printWidth: 120,
  useTabs: false,
  bracketSpacing: true,
  arrowParens: 'always',
  bracketSameLine: false,
  jsxSingleQuote: false,
  endOfLine: 'lf',
  plugins: [tailwindPlugin],
  tailwindFunctions: ['clsx', 'cva', 'cn'],
};

export default prettierOptions;
