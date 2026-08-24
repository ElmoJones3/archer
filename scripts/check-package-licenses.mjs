/**
 * @file Proves every future public Archer package declares Apache-2.0 and
 * carries the repository's exact license text in its packed artifact.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

/** Resolves repository files independently from the invoking shell directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs package-manager artifact construction without invoking a shell. */
const execFileAsync = promisify(execFile);

/** Exact package roots intended to become independently published artifacts. */
const packageRoots = Object.freeze(['packages/core', 'packages/files', 'packages/observability', 'packages/eslint']);

/** Owns the only temporary directory this check may remove. */
const artifactRoot = await mkdtemp(resolve(tmpdir(), 'archer-license-check-'));

/**
 * Reads one NUL-terminated UTF-8 field from a POSIX tar header.
 * @param {Uint8Array} header - Exact 512-byte tar header block.
 * @param {number} offset - Starting byte within the header.
 * @param {number} length - Maximum field width.
 * @returns {string} Decoded field with padding removed.
 */
function tarText(header, offset, length) {
  /** Isolates the fixed-width header field from adjacent tar metadata. */
  const field = header.subarray(offset, offset + length);
  /** NUL ends the meaningful field before space or zero padding. */
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
}

/**
 * Reads regular-file payloads from one gzip-compressed POSIX tar archive.
 * @param {Uint8Array} archive - Exact `.tgz` bytes produced by pnpm.
 * @returns {ReadonlyMap<string, Uint8Array>} Immutable-path lookup of archived file bytes.
 */
function readTarFiles(archive) {
  /** Decompresses once so header and payload offsets remain deterministic. */
  const tar = gunzipSync(archive);
  /** Retains only ordinary file entries needed by artifact assertions. */
  const files = new Map();
  /** Advances in complete 512-byte header and payload blocks. */
  let offset = 0;

  while (offset + 512 <= tar.length) {
    /** Reads one complete header without retaining a mutable view outside this loop. */
    const header = tar.subarray(offset, offset + 512);
    /** An all-zero header terminates the archive. */
    if (header.every((byte) => byte === 0)) break;

    /** POSIX prefix extends names that do not fit the primary field. */
    const prefix = tarText(header, 345, 155);
    /** Primary archive path is relative to the packed package root. */
    const name = tarText(header, 0, 100);
    /** Complete path preserves a possible POSIX prefix exactly once. */
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    /** Octal size controls both payload slicing and padded-block advancement. */
    const sizeText = tarText(header, 124, 12).trim();
    /** Empty tar sizes represent zero-byte entries. */
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for ${path}`);

    /** Payload begins immediately after the current header. */
    const dataStart = offset + 512;
    /** Type `0` or NUL denotes an ordinary file whose bytes can be asserted. */
    const type = header[156];
    if (type === 0 || type === 48) files.set(path, Buffer.from(tar.subarray(dataStart, dataStart + size)));
    /** Payload occupies complete tar blocks even when the file does not. */
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return files;
}

/**
 * Packs one package and resolves the exact artifact path reported by pnpm.
 * @param {string} packageRoot - Absolute package directory.
 * @returns {Promise<string>} Absolute `.tgz` artifact path.
 */
async function packPackage(packageRoot) {
  /** Produces the consumer artifact without a shell or registry access. */
  const packed = await execFileAsync('pnpm', ['pack', '--pack-destination', artifactRoot], {
    cwd: packageRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  /** Pnpm reports the artifact on its final non-empty stdout line. */
  const reported = packed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (reported === undefined) throw new Error(`pnpm pack did not report an artifact for ${packageRoot}`);
  return isAbsolute(reported) ? reported : resolve(artifactRoot, basename(reported));
}

try {
  /** Root license bytes are the canonical source every artifact must reproduce. */
  const canonicalLicense = await readFile(resolve(repositoryRoot, 'LICENSE'));
  /** Root metadata makes the repository-wide grant machine-readable. */
  const rootManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  if (rootManifest.license !== 'Apache-2.0') throw new Error('Root package must declare Apache-2.0');

  /** Checks every independently packable package against the same distribution terms. */
  for (const relativeRoot of packageRoots) {
    /** Resolves the package independently from process working directory. */
    const packageRoot = resolve(repositoryRoot, relativeRoot);
    /** Source metadata must agree before artifact construction begins. */
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    if (manifest.license !== 'Apache-2.0') {
      throw new Error(`${manifest.name ?? relativeRoot} must declare Apache-2.0`);
    }
    /** Package-local license prevents repository layout from becoming an artifact dependency. */
    const packageLicense = await readFile(resolve(packageRoot, 'LICENSE'));
    if (!packageLicense.equals(canonicalLicense)) {
      throw new Error(`${manifest.name ?? relativeRoot} license differs from the repository license`);
    }

    /** Consumer proof reads the exact packed bytes rather than trusting source inclusion rules. */
    const artifact = await readFile(await packPackage(packageRoot));
    /** Tar parsing keeps the assertion independent of a host tar executable. */
    const files = readTarFiles(artifact);
    /** License must survive as a top-level package artifact file. */
    const packedLicense = files.get('package/LICENSE');
    if (packedLicense === undefined || !packedLicense.equals(canonicalLicense)) {
      throw new Error(`${manifest.name ?? relativeRoot} artifact does not contain the canonical LICENSE`);
    }
    /** Packed metadata must preserve the same SPDX expression consumers inspect. */
    const packedManifest = files.get('package/package.json');
    if (packedManifest === undefined || JSON.parse(packedManifest.toString('utf8')).license !== 'Apache-2.0') {
      throw new Error(`${manifest.name ?? relativeRoot} artifact does not declare Apache-2.0`);
    }
  }
} finally {
  /** Removes only the uniquely created artifact directory after success or failure. */
  await rm(artifactRoot, { recursive: true, force: true });
}
