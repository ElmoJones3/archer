/**
 * @file Packs `@archer/core`, installs that artifact into an empty pnpm
 * project, and proves declarations, imports, side effects, and optional peers
 * from the consumer side of the package boundary.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Resolves package files independently of the invoking shell directory. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs external package and compiler boundaries through Promise control flow. */
const execFileAsync = promisify(execFile);

/** Owns a uniquely scoped fixture that this script may safely remove. */
const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'archer-core-package-'));

/**
 * Runs one child process with bounded captured output.
 * @param {string} command - Executable resolved through the current package script PATH.
 * @param {string[]} args - Exact non-shell argument vector.
 * @param {string} cwd - Directory that owns module and package-manager resolution.
 * @returns {Promise<Readonly<{ stdout: string, stderr: string }>>} Captured process output.
 */
async function run(command, args, cwd) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

try {
  /** Reuses the workspace pnpm store while keeping the consumer project empty. */
  const store = (await run('pnpm', ['store', 'path'], packageRoot)).stdout.trim();
  if (store.length === 0) throw new Error('pnpm did not report its workspace store path');
  /** Produces the exact tarball consumers receive rather than reading workspace source. */
  const packed = await run('pnpm', ['pack', '--pack-destination', fixtureRoot], packageRoot);
  /** Reads the final non-empty output line as pnpm's absolute tarball path. */
  const tarball = packed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (tarball === undefined) throw new Error('pnpm pack did not report an artifact path');

  /** Defines an otherwise empty project that depends only on the packed core artifact. */
  await writeFile(
    resolve(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'archer-core-package-check',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { '@archer/core': `file:${tarball}` },
      },
      null,
      2,
    )}\n`,
  );
  /** Installs through the repository's declared package manager from the real tarball boundary. */
  await run('pnpm', ['install', '--ignore-scripts', '--store-dir', store], fixtureRoot);

  /** Compiles the documented low-level construction shape from packed declarations. */
  await writeFile(
    resolve(fixtureRoot, 'consumer.ts'),
    `import { Result } from '@archer/core';
import type { AuthorityBroker, ProtectedAction } from '@archer/core/authority';
import type { CellHost } from '@archer/core/cells';
import { transientEventSource } from '@archer/core/stream';

type Progress = Readonly<{ step: number }>;
type ReadScope = Readonly<{ kind: 'read'; target: string }>;
type ReadAction = ProtectedAction<'read', ReadScope>;

declare const authority: AuthorityBroker<ReadAction>;
declare const cells: CellHost;

const source = transientEventSource<Progress>()({
  source: 'package-check',
  epoch: 'epoch-1',
  eventEncoding: {
    revision: 'progress/1',
    normalize: (event) => Object.freeze({ ...event }),
    measure: (event) => event.step,
  },
});

const result = Result.ok(source);
void result;
void authority;
void cells;
`,
  );
  /** Uses an ES2022 consumer to prove disposable declaration references are self-contained. */
  await writeFile(
    resolve(fixtureRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await run(resolve(packageRoot, 'node_modules/.bin/tsc'), ['-p', resolve(fixtureRoot, 'tsconfig.json')], fixtureRoot);

  /** Imports every non-React entry point from the installed artifact in one clean process. */
  const nonReactImports = [
    '@archer/core',
    '@archer/core/authority',
    '@archer/core/authority/conformance',
    '@archer/core/cells',
    '@archer/core/cells/conformance',
    '@archer/core/cells/embedded-sqlite',
    '@archer/core/diagnostics',
    '@archer/core/diagnostics/conformance',
    '@archer/core/ownership',
    '@archer/core/program',
    '@archer/core/protocol',
    '@archer/core/stream',
    '@archer/core/stream/conformance',
    '@archer/core/stream/testing',
  ];
  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `for (const specifier of ${JSON.stringify(nonReactImports)}) await import(specifier);`,
    ],
    fixtureRoot,
  );

  /** Rejects root-import activation of timers or queued runtime work. */
  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `globalThis.setTimeout = () => { throw new Error('root import scheduled a timeout'); };
globalThis.setInterval = () => { throw new Error('root import scheduled an interval'); };
globalThis.queueMicrotask = () => { throw new Error('root import scheduled a microtask'); };
await import('@archer/core');`,
    ],
    fixtureRoot,
  );

  /** Reads the installed manifest to ensure optional adapter peers stayed explicit. */
  const installedManifest = JSON.parse(
    await readFile(resolve(fixtureRoot, 'node_modules/@archer/core/package.json'), 'utf8'),
  );
  if (installedManifest.license !== 'Apache-2.0') {
    throw new Error('Packed core did not preserve the Apache-2.0 SPDX declaration');
  }
  /** Compares installed license bytes with the package source of truth. */
  const [sourceLicense, installedLicense] = await Promise.all([
    readFile(resolve(packageRoot, 'LICENSE')),
    readFile(resolve(fixtureRoot, 'node_modules/@archer/core/LICENSE')),
  ]);
  if (!sourceLicense.equals(installedLicense)) {
    throw new Error('Packed core did not preserve its exact Apache-2.0 license text');
  }
  if (installedManifest.peerDependenciesMeta?.react?.optional !== true) {
    throw new Error('Packed core did not preserve React as an optional peer');
  }
  if (installedManifest.peerDependenciesMeta?.['@aws-sdk/client-s3']?.optional !== true) {
    throw new Error('Packed core did not preserve the AWS SDK as an optional peer');
  }
  /** The optional framework subpath must fail clearly when its peer is absent. */
  let missingReact = false;
  try {
    await run(process.execPath, ['--input-type=module', '--eval', "await import('@archer/core/react');"], fixtureRoot);
  } catch (error) {
    /** Preserves only the fact that Node named the missing optional dependency. */
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    missingReact = output.includes('react');
  }
  if (!missingReact) throw new Error('React subpath did not identify its absent optional peer');

  /** The optional S3 adapter must fail clearly when its SDK peer is absent. */
  let missingAwsSdk = false;
  try {
    await run(
      process.execPath,
      ['--input-type=module', '--eval', "await import('@archer/core/cells/s3');"],
      fixtureRoot,
    );
  } catch (error) {
    /** Preserves only the fact that Node named the missing optional dependency. */
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    missingAwsSdk = output.includes('@aws-sdk/client-s3');
  }
  if (!missingAwsSdk) throw new Error('S3 Cell subpath did not identify its absent optional AWS SDK peer');

  /** Proves product-neutral subpaths remain usable without either optional adapter peer. */
  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import('@archer/core/stream');
await import('@archer/core/cells');
if ([...process.moduleLoadList].some((entry) => entry.includes('react'))) {
  throw new Error('Stream import initialized the React adapter');
}`,
    ],
    fixtureRoot,
  );
} finally {
  /** Removes only the uniquely created package-check fixture. */
  await rm(fixtureRoot, { recursive: true, force: true });
}
