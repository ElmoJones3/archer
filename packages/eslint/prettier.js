import { createRequire } from 'node:module';

const tailwindPlugin = createRequire(import.meta.url).resolve('prettier-plugin-tailwindcss');

/** @type {import('prettier').Config} */
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
