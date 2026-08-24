/** @file Proves project admission is safe by default and caller-selectable. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readProject } from '../src/project.js';

describe('code-editor project admission', () => {
  it('excludes secrets, dependencies, generated files, and caller-ignored paths before model access', async () => {
    /** One real host tree combines useful source with common disclosure hazards. */
    const root = await mkdtemp(join(tmpdir(), 'archer-code-editor-project-'));
    try {
      await mkdir(join(root, 'src', 'generated'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(join(root, 'vendor-package'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), 'export const ready = true;\n');
      await writeFile(join(root, 'src', 'generated', 'schema.ts'), 'export const generated = true;\n');
      await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
      await writeFile(join(root, '.env.local'), 'OPENAI_API_KEY=must-not-leave-host\n');
      await writeFile(join(root, '.git', 'config'), '[remote]\nurl=private\n');
      await writeFile(join(root, 'vendor-package', 'index.js'), 'module.exports = {};\n');
      /** A pnpm-style dependency link is skipped by name before general link refusal runs. */
      await symlink(join(root, 'vendor-package'), join(root, 'node_modules'), 'dir');

      /** Include narrows disclosure while ignore removes a generated subtree inside that selection. */
      const files = await readProject(root, { include: ['src/**'], ignore: ['src/generated/**'] });
      expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
