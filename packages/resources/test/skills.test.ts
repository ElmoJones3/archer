/** @file Proves real Agent Skill import, disclosure, containment, and reimport behavior. */

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { memoryFileStore } from '@archer/files';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fileStoreSkillContentReader,
  importSkillDirectory,
  loadSkillInstructions,
  loadSkillSupport,
  reimportSkillDirectory,
  skillSummary,
} from '../src/entrypoints/skills.js';
import { createSkillDirectory, skillContext, skillRevisionContext } from './support.js';

/** Fixture cleanup callbacks registered by each host-bound test. */
const cleanups: (() => Promise<void>)[] = [];

/** Removes only temporary roots created by the current test. */
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Skill behavior', () => {
  it('imports a real directory and progressively discloses summary, instructions, and support', async () => {
    /** Creates a production-shaped Agent Skills directory with one referenced support file. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Owns the immutable snapshot destination independently from the host directory. */
    const files = memoryFileStore();
    /** Imports through real filesystem acquisition so manifest and reference behavior are exercised. */
    const imported = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(100) },
    );
    if (!imported.ok) throw imported.error;

    expect(skillSummary(imported.value)).toEqual({
      ref: expect.objectContaining({ id: imported.value.id, revisionId: imported.value.revisionId }),
      name: 'order-support',
      description: 'Helps a support rep answer order questions.',
    });
    expect(loadSkillInstructions(imported.value)).toEqual({
      ok: true,
      value: expect.objectContaining({ content: expect.stringContaining('Check the order status reference') }),
    });
    /** Loads one explicitly requested support file through the exact immutable Skill tree. */
    const support = await loadSkillSupport(
      imported.value,
      'references/order-status.md',
      fileStoreSkillContentReader(files),
    );
    expect(support).toEqual({
      ok: true,
      value: expect.objectContaining({ path: 'references/order-status.md' }),
    });
    if (support.ok) expect(new TextDecoder().decode(support.value.content)).toContain('latest carrier scan');
  });

  it('binds the complete immutable snapshot after the host directory disappears', async () => {
    /** Creates source content that will be deleted after successful import. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Retains the complete Skill snapshot beyond the physical directory lifecycle. */
    const files = memoryFileStore();
    /** Imports behavior before removing every host file and directory. */
    const imported = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(110) },
    );
    if (!imported.ok) throw imported.error;
    await rm(fixture.directory, { recursive: true, force: true });

    /** Reads after deletion to prove disclosure depends on immutable content, not a hidden path. */
    const loaded = await loadSkillSupport(
      imported.value,
      'references/order-status.md',
      fileStoreSkillContentReader(files),
    );
    expect(loaded.ok).toBe(true);
    expect(imported.value.paths).toEqual(['SKILL.md', 'references/order-status.md']);
  });

  it('refuses missing, malformed, invalid UTF-8, and mismatched root manifests', async () => {
    /** Creates one root reused across several malformed manifest scenarios. */
    const fixture = await createSkillDirectory('order-support');
    cleanups.push(fixture.cleanup);
    /** Shares only the immutable destination; each failed import must publish no behavior. */
    const files = memoryFileStore();
    /** Retains the parent directory so root replacements stay within test-owned cleanup. */
    const root = dirname(fixture.directory);

    await rm(join(fixture.directory, 'SKILL.md'));
    /** Removes SKILL.md to prove the required root entry is not optional. */
    const missing = await importSkillDirectory({ directory: fixture.directory }, { files, context: skillContext(120) });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'skill_manifest_missing' }) });

    await writeFile(join(fixture.directory, 'SKILL.md'), 'no front matter', 'utf8');
    /** Writes invalid YAML/front matter so parsing failure is distinct from source absence. */
    const malformed = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(122) },
    );
    expect(malformed).toEqual({ ok: false, error: expect.objectContaining({ code: 'skill_frontmatter_invalid' }) });

    await writeFile(join(fixture.directory, 'SKILL.md'), Uint8Array.from([0xff, 0xfe]));
    /** Writes malformed UTF-8 bytes so replacement decoding cannot hide corruption. */
    const invalidUtf8 = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(124) },
    );
    expect(invalidUtf8).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'skill_manifest_invalid_utf8' }),
    });

    await writeFile(
      join(fixture.directory, 'SKILL.md'),
      '---\nname: another-name\ndescription: Valid description.\n---\n\nInstructions.\n',
      'utf8',
    );
    /** Uses a manifest name that disagrees with the directory identity. */
    const mismatched = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(126) },
    );
    expect(mismatched).toEqual({ ok: false, error: expect.objectContaining({ code: 'skill_name_invalid' }) });
    expect(root).toBeTruthy();
  });

  it('refuses links, root escapes, and missing referenced files before publication', async () => {
    /** Creates a real symlink inside the Skill tree to prove link refusal is recursive. */
    const linked = await createSkillDirectory('linked-support');
    cleanups.push(linked.cleanup);
    await symlink(join(linked.directory, 'references', 'order-status.md'), join(linked.directory, 'linked.md'));
    /** Attempts import of linked content before any immutable publication can occur. */
    const links = await importSkillDirectory(
      { directory: linked.directory },
      { files: memoryFileStore(), context: skillContext(130) },
    );
    expect(links).toEqual({ ok: false, error: expect.objectContaining({ code: 'skill_link_refused' }) });

    /** References a parent path to prove contained references cannot escape the Skill root. */
    const escaping = await createSkillDirectory('escaping-support', 'Read [outside](../outside.md).');
    cleanups.push(escaping.cleanup);
    /** Attempts import of the escaping document through the same production parser. */
    const escaped = await importSkillDirectory(
      { directory: escaping.directory },
      { files: memoryFileStore(), context: skillContext(132) },
    );
    expect(escaped).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'skill_reference_escapes_root' }),
    });

    /** References a nonexistent contained file so dangling links fail at acquisition. */
    const dangling = await createSkillDirectory('dangling-support', 'Read [missing](references/missing.md).');
    cleanups.push(dangling.cleanup);
    /** Attempts import with the missing reference before constructing behavior. */
    const missing = await importSkillDirectory(
      { directory: dangling.directory },
      { files: memoryFileStore(), context: skillContext(134) },
    );
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'skill_reference_missing' }) });

    /** Names a bare Markdown support file in code spans, as Agent Skills commonly do in prose. */
    const bareBacktick = await createSkillDirectory('backtick-support', 'Read `guide.md` before answering.');
    cleanups.push(bareBacktick.cleanup);
    /** Omits guide.md so the inline reference must fail before the Skill earns behavior. */
    const missingBacktick = await importSkillDirectory(
      { directory: bareBacktick.directory },
      { files: memoryFileStore(), context: skillContext(136) },
    );
    expect(missingBacktick).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'skill_reference_missing' }),
    });
  });

  it('resolves present bare-backtick and nested Markdown references inside the Skill root', async () => {
    /** Uses one bare root file plus one reference relative to supporting Markdown. */
    const fixture = await createSkillDirectory('relative-support', 'Read `guide.md` before answering.');
    cleanups.push(fixture.cleanup);
    await writeFile(join(fixture.directory, 'guide.md'), '# Guide\nUse the support policy.\n', 'utf8');
    await writeFile(
      join(fixture.directory, 'references', 'order-status.md'),
      '# Order status\nRead [details](details.md).\n',
      'utf8',
    );
    await writeFile(join(fixture.directory, 'references', 'details.md'), '# Details\nUse the latest scan.\n', 'utf8');

    /** Imports through production traversal so both reference forms must resolve to captured files. */
    const imported = await importSkillDirectory(
      { directory: fixture.directory },
      { files: memoryFileStore(), context: skillContext(138) },
    );
    expect(imported).toEqual({
      ok: true,
      value: expect.objectContaining({
        paths: expect.arrayContaining(['guide.md', 'references/details.md']),
      }),
    });
  });

  it('reimports changed content as an exact causal child and refuses no-change revisions', async () => {
    /** Creates a stable parent whose unchanged and changed reimports share exact ancestry. */
    const fixture = await createSkillDirectory();
    cleanups.push(fixture.cleanup);
    /** Retains parent and child snapshots in one immutable store for revision comparison. */
    const files = memoryFileStore();
    /** Imports the initial exact Skill revision before modifying any source. */
    const parent = await importSkillDirectory(
      { directory: fixture.directory },
      { files, context: skillContext(140, 5) },
    );
    if (!parent.ok) throw parent.error;
    /** Reimports unchanged bytes to prove a child revision requires behavior change. */
    const unchanged = await reimportSkillDirectory(
      parent.value,
      { directory: fixture.directory },
      { files, context: skillRevisionContext(142, 6) },
    );
    expect(unchanged).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_skill_transition_refused' }),
    });

    await writeFile(
      join(fixture.directory, 'references', 'order-status.md'),
      '# Order status\nConfirm the latest carrier scan and delivery estimate.\n',
      'utf8',
    );
    /** Reuses the stable logical identity to prove reimport cannot create ambiguous child lineage. */
    const collidingLogicalId = await reimportSkillDirectory(
      parent.value,
      { directory: fixture.directory },
      {
        files,
        context: { revisionId: parent.value.id as never, observedAt: skillRevisionContext(144, 4).observedAt },
      },
    );
    /** Reimports modified instructions to prove legal child ancestry and new content identity. */
    const child = await reimportSkillDirectory(
      parent.value,
      { directory: fixture.directory },
      { files, context: skillRevisionContext(144, 4) },
    );
    expect(collidingLogicalId).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'resources_skill_transition_refused' }),
    });
    expect(child).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: parent.value.id,
        previousRevisionId: parent.value.revisionId,
        revision: 2,
        updatedAt: parent.value.updatedAt,
      }),
    });
  });

  it('rejects non-regular referenced entries', async () => {
    /** References a real directory to prove references must identify regular files. */
    const fixture = await createSkillDirectory('directory-ref', 'Read [nested](references/nested).');
    cleanups.push(fixture.cleanup);
    await mkdir(join(fixture.directory, 'references', 'nested'));
    /** Attempts import after creating the directory so refusal is not a missing-path false positive. */
    const imported = await importSkillDirectory(
      { directory: fixture.directory },
      { files: memoryFileStore(), context: skillContext(150) },
    );
    expect(imported).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'skill_reference_not_regular' }),
    });
  });
});
