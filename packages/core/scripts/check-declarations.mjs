/**
 * @file Rejects dependency leakage and broken subpath targets in the built
 * `@archer/core` declaration surface.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Resolves paths relative to this package rather than the invoking shell. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Loads package metadata after pnpm has normalized its dependency fields. */
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));

/** Promisifies process execution so each import receives an isolated module cache. */
const execFileAsync = promisify(execFile);

/**
 * Resolves one export entry's declaration target.
 * @param {{ types: string }} entry - One conditional package export.
 * @returns {string} Absolute declaration target.
 */
function declarationPath(entry) {
  return resolve(packageRoot, entry.types);
}

/** Collects every declaration target published by the package export map. */
const declarations = Object.values(packageJson.exports).map(declarationPath);

/** Validates that every published declaration target exists after build. */
for (const declaration of declarations) await stat(declaration);

/**
 * Reads one declaration entry point for dependency-boundary checks.
 * @param {string} declaration - Absolute built declaration target.
 * @returns {Promise<Readonly<{ declaration: string, text: string }>>} Path and source text.
 */
async function readDeclaration(declaration) {
  return Object.freeze({ declaration, text: await readFile(declaration, 'utf8') });
}

/**
 * Finds every emitted declaration so a private implementation file cannot leak
 * a product type through a re-exported entry point.
 * @param {string} directory - Emitted directory searched recursively.
 * @returns {Promise<string[]>} Absolute declaration file paths.
 */
async function findDeclarations(directory) {
  /** Reads one directory level before recursing into child directories. */
  const entries = await readdir(directory, { withFileTypes: true });

  /** Accumulates declaration paths independently of filesystem traversal order. */
  const found = [];

  /** Examines every emitted entry exactly once. */
  for (const entry of entries) {
    /** Resolves this entry without depending on the invoking process directory. */
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findDeclarations(path)));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found.sort();
}

/** Reads every emitted declaration for transitive dependency-boundary checks. */
const declarationTexts = await Promise.all((await findDeclarations(resolve(packageRoot, 'dist'))).map(readDeclaration));

/** Prevents the internal reactive engine from becoming a public type dependency. */
for (const { declaration, text } of declarationTexts) {
  if (/\b(?:from|import\()\s*['"]rxjs(?:\/|['"])/u.test(text)) {
    throw new Error(`RxJS leaked into ${declaration}`);
  }
}

/** Prevents observability adapters from entering product-neutral core contracts. */
for (const { declaration, text } of declarationTexts) {
  if (/\b(?:from|import\()\s*['"](?:pino|tslog)(?:\/|['"])/u.test(text)) {
    throw new Error(`A logger product type leaked into ${declaration}`);
  }
}

/** Ensures React remains optional metadata for the isolated framework subpath. */
if (packageJson.peerDependenciesMeta?.react?.optional !== true) {
  throw new Error('React must remain an optional peer dependency');
}

/** Ensures the direct S3 transport remains optional metadata for its isolated subpath. */
if (packageJson.peerDependenciesMeta?.['@aws-sdk/client-s3']?.optional !== true) {
  throw new Error('The AWS SDK must remain an optional peer dependency');
}

/** Verifies every documented package entry in a fresh Node process. */
for (const subpath of Object.keys(packageJson.exports)) {
  /** Converts the package export key into its self-referenced import specifier. */
  const specifier = subpath === '.' ? '@archer/core' : `@archer/core${subpath.slice(1)}`;
  await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`],
    {
      cwd: packageRoot,
    },
  );
}
