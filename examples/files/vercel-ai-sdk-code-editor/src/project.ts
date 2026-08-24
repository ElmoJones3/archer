/** @file Imports a caller-selected host project into portable logical file inputs. */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, matchesGlob, resolve } from 'node:path';

import { FileMode, type TreeFileSource } from '@archer/files';

/** Caller policy that can narrow the safe default set made available to a model. */
export type ProjectImportPolicy = Readonly<{
  /** Optional glob allowlist; omission admits every file not excluded by safety policy. */
  include?: readonly string[];
  /** Additional glob exclusions applied before host metadata or content is read. */
  ignore?: readonly string[];
}>;

/** Common dependency, VCS, cache, build, and deployment directories never admitted by default. */
const EXCLUDED_DIRECTORIES = new Set([
  '.aws',
  '.direnv',
  '.git',
  '.gnupg',
  '.next',
  '.output',
  '.ssh',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

/** Exact secret-bearing configuration names never admitted by default. */
const EXCLUDED_FILES = new Set(['.npmrc', '.pypirc', 'credentials', 'credentials.json', 'id_ed25519', 'id_rsa']);

/**
 * Recognizes filenames whose conventional purpose is secret retention.
 * @param name - Final host entry name without parent directories.
 * @returns Whether default policy refuses the file before reading its bytes.
 */
function isSecretFileName(name: string): boolean {
  /** Case folding prevents host filesystem rules from weakening the same application policy. */
  const normalized = name.toLowerCase();
  return (
    normalized === '.env' ||
    normalized.startsWith('.env.') ||
    EXCLUDED_FILES.has(normalized) ||
    normalized.endsWith('.key') ||
    normalized.endsWith('.keystore') ||
    normalized.endsWith('.p12') ||
    normalized.endsWith('.pem') ||
    normalized.endsWith('.pfx') ||
    normalized.endsWith('.tfstate') ||
    normalized.endsWith('.tfstate.backup')
  );
}

/**
 * Matches one logical path against caller-authored Node glob patterns.
 * @param path - Forward-slash path relative to the selected project root.
 * @param patterns - Caller include or ignore patterns.
 * @param asDirectory - Whether descendant matching should also be considered.
 * @returns Whether any pattern selects this path or its directory descendants.
 */
function matchesAny(path: string, patterns: readonly string[], asDirectory = false): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern) || (asDirectory && matchesGlob(`${path}/_`, pattern)));
}

/**
 * Reads a regular-file project without granting the model host filesystem access.
 * @param root - Host project directory selected by the application caller.
 * @param policy - Optional caller allowlist and additional exclusions layered over safe defaults.
 * @returns Portable file inputs ready for immutable publication.
 */
export async function readProject(root: string, policy: ProjectImportPolicy = {}): Promise<readonly TreeFileSource[]> {
  /** One absolute root prevents later working-directory changes from redirecting traversal. */
  const physicalRoot = resolve(root);
  /** Caller arrays are copied so later mutation cannot change an in-flight disclosure boundary. */
  const include = Object.freeze([...(policy.include ?? [])]);
  /** Additional ignores can only remove files; they never override the safe defaults. */
  const ignore = Object.freeze([...(policy.ignore ?? [])]);
  /**
   * Recursively retains relative segments until they become logical paths.
   * @param segments - Host path segments already admitted beneath the selected root.
   * @returns Portable file inputs collected from this directory and its descendants.
   */
  async function visit(segments: readonly string[] = []): Promise<readonly TreeFileSource[]> {
    /** Stable order improves model context and operator expectations. */
    const entries = (await readdir(join(physicalRoot, ...segments), { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    /** Files remain application-owned byte values until Archer publishes them. */
    const files: TreeFileSource[] = [];
    /** Every entry is classified without following links into ambient host content. */
    for (const entry of entries) {
      /** Relative segments cannot escape the root returned by `readdir`. */
      const childSegments = [...segments, entry.name];
      /** Forward-slash syntax gives glob policy the same meaning on every supported host. */
      const logicalPath = childSegments.join('/');
      /** Named unsafe directories are skipped before even a pnpm-style symlink is inspected. */
      if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || matchesAny(logicalPath, ignore, true)) continue;
      /** Host path stays private to this import boundary. */
      const child = join(physicalRoot, ...childSegments);
      /** Links are rejected so a project cannot import ambient host content accidentally. */
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink())
        throw new Error(`Project import rejects symbolic links: ${childSegments.join('/')}`);
      if (metadata.isDirectory()) {
        files.push(...(await visit(childSegments)));
        continue;
      }
      if (!metadata.isFile()) throw new Error(`Project import accepts regular files only: ${childSegments.join('/')}`);
      /** Secret names remain excluded even when a caller include glob would otherwise select them. */
      if (isSecretFileName(entry.name)) continue;
      /** A non-empty include list narrows the admitted model-visible file set. */
      if (include.length > 0 && !matchesAny(logicalPath, include)) continue;
      files.push(
        Object.freeze({
          path: logicalPath,
          content: await readFile(child),
          mode: (metadata.mode & 0o111) === 0 ? FileMode.readable : FileMode.executable,
        }),
      );
    }
    return Object.freeze(files);
  }
  return await visit();
}
