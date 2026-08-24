/**
 * @file Runs a Markdown search-index build as one observable application job.
 *
 * Node owns directory traversal and output replacement. `@archer/core` owns the
 * living state, bounded progress, diagnostic, abort, result, and close contracts.
 */

import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import { createUuidV4, type UuidV4 } from '@archer/core';

import { createReactiveJobRun, type JobStep, type ReactiveJobRun } from './job.js';

/** One indexed Markdown document consumed by a small search UI or static site. */
export type IndexedDocument = Readonly<{
  /** Uses forward-slash relative syntax so output does not depend on the host OS. */
  path: string;
  /** Uses the first level-one heading, then falls back to the relative filename. */
  title: string;
  /** Preserves heading order for navigation and simple term matching. */
  headings: readonly string[];
}>;

/** Complete application output written only after every source document parses. */
export type DocumentationIndex = Readonly<{
  /** Canonical document order makes rebuilds byte-for-byte stable. */
  documents: readonly IndexedDocument[];
}>;

/** Input for one immediately active documentation-indexing job. */
export type DocumentationIndexRunOptions = Readonly<{
  /** Directory recursively searched for Markdown documents. */
  sourceDirectory: string;
  /** JSON file replaced only after a complete index is ready. */
  outputFile: string;
  /** Optional deterministic run identity used by automated tests. */
  runId?: UuidV4;
}>;

/**
 * Converts one source path into portable relative application syntax.
 * @param sourceDirectory - Absolute traversal root.
 * @param file - Absolute Markdown file beneath that root.
 * @returns Forward-slash path used by the generated index.
 */
function logicalPath(sourceDirectory: string, file: string): string {
  return relative(sourceDirectory, file).split(sep).join('/');
}

/**
 * Finds Markdown files while rejecting links that could escape the selected root.
 * @param sourceDirectory - Absolute caller-selected documentation root.
 * @param currentDirectory - Absolute directory currently being traversed.
 * @returns Absolute Markdown paths in deterministic host-name order.
 */
async function findMarkdownFiles(
  sourceDirectory: string,
  currentDirectory = sourceDirectory,
): Promise<readonly string[]> {
  /** Sorted entries make error and progress order stable for users. */
  const entries = (await readdir(currentDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  /** Files accumulate in depth-first path order. */
  const files: string[] = [];
  /** Every host entry is classified before a Markdown path enters the index. */
  for (const entry of entries) {
    /** Each physical path derives only from entries returned beneath the chosen root. */
    const path = join(currentDirectory, entry.name);
    /** `lstat` prevents directory links from smuggling content into the index. */
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Documentation indexing rejects symbolic links: ${logicalPath(sourceDirectory, path)}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await findMarkdownFiles(sourceDirectory, path)));
      continue;
    }
    if (metadata.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(path);
  }
  return Object.freeze(files);
}

/**
 * Extracts search and navigation data without mutating source text.
 * @param path - Portable relative source identity.
 * @param markdown - Complete UTF-8 Markdown source.
 * @returns One stable index entry in source heading order.
 */
function indexMarkdown(path: string, markdown: string): IndexedDocument {
  /** Multiline matching recognizes ATX headings without pretending to parse all Markdown. */
  const matches = [...markdown.matchAll(/^(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/gm)];
  /** Plain heading text is enough for this search-index application. */
  const headings = Object.freeze(matches.map((match) => match[2] ?? '').filter((heading) => heading.length > 0));
  /** The first level-one heading is the human title when one exists. */
  const title = matches.find((match) => match[1] === '#')?.[2] ?? path.split('/').at(-1) ?? path;
  return Object.freeze({ path, title, headings });
}

/**
 * Replaces an index through a same-directory temporary file.
 * @param outputFile - Absolute application output selected by the caller.
 * @param index - Complete immutable index ready for serialization.
 * @param runId - Operation identity used only to avoid temporary-file collisions.
 */
async function writeIndex(outputFile: string, index: DocumentationIndex, runId: UuidV4): Promise<void> {
  /** Same-directory placement lets `rename` publish one complete file atomically. */
  const temporaryFile = `${outputFile}.${runId}.tmp`;
  await mkdir(dirname(outputFile), { recursive: true });
  try {
    await writeFile(temporaryFile, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryFile, outputFile);
  } finally {
    /** Exact temporary-path cleanup is harmless after a successful rename. */
    await rm(temporaryFile, { force: true });
  }
}

/**
 * Starts a living job that writes one documentation search index.
 * @param options - Source root, output file, and optional deterministic identity.
 * @returns Immediately active run with public state, progress, diagnostics, and lifecycle.
 */
export function createDocumentationIndexRun(options: DocumentationIndexRunOptions): ReactiveJobRun {
  /** Resolving at construction prevents later working-directory changes from splitting the run. */
  const sourceDirectory = resolve(options.sourceDirectory);
  /** Output remains separate from source policy even when the caller places it below the source. */
  const outputFile = resolve(options.outputFile);
  /** One identity correlates the living run and its collision-resistant staging file. */
  const runId = options.runId ?? createUuidV4();
  /** The effect performs real filesystem work while the generic Program owns transition order. */
  const buildIndex: JobStep = Object.freeze({
    name: 'build-documentation-index',
    /**
     * Traverses, parses, reports, and publishes one complete index.
     * @param context - Run-owned abort and bounded progress capabilities.
     */
    async execute(context) {
      /** Discovery completes before progress totals are published. */
      const files = await findMarkdownFiles(sourceDirectory);
      /** Parsed documents remain private until the complete output can be replaced. */
      const documents: IndexedDocument[] = [];
      /** Each admitted Markdown file contributes one document and one live progress update. */
      for (const [position, file] of files.entries()) {
        if (context.signal.aborted) throw context.signal.reason;
        /** Portable identity and UTF-8 text enter the pure projection together. */
        const path = logicalPath(sourceDirectory, file);
        documents.push(indexMarkdown(path, await readFile(file, 'utf8')));
        context.report({
          message: `indexed ${path}`,
          completedUnits: position + 1,
          totalUnits: Math.max(files.length, 1),
        });
      }
      /** Empty documentation roots still produce a valid empty index and one useful progress update. */
      if (files.length === 0) {
        context.report({ message: 'indexed empty documentation directory', completedUnits: 1, totalUnits: 1 });
      }
      /** Canonical traversal order is frozen before serialization and publication. */
      const index: DocumentationIndex = Object.freeze({ documents: Object.freeze(documents) });
      await writeIndex(outputFile, index, runId);
    },
  });

  /** Passing a supplied identity keeps tests deterministic without changing production behavior. */
  return createReactiveJobRun({ steps: [buildIndex], runId });
}
