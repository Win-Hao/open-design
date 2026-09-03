import { describe, expect, it } from 'vitest';

import {
  countArtifactFileOps,
  countFileOps,
  deriveFileOps,
  attributeRemovedFiles,
  extractDeletionTargetPaths,
  hasFileMutationToolUse,
  hasPossibleFileMutationFailure,
} from '../../src/runtime/file-ops';
import type { AgentEvent } from '../../src/types';

type ToolUse = Extract<AgentEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>;

function use(name: string, input: unknown, id: string): ToolUse {
  return { kind: 'tool_use', id, name, input };
}

function ok(id: string, content = ''): ToolResult {
  return { kind: 'tool_result', toolUseId: id, content, isError: false };
}

function fail(id: string, content = 'boom'): ToolResult {
  return { kind: 'tool_result', toolUseId: id, content, isError: true };
}

describe('deriveFileOps', () => {
  it('returns an empty list for an empty event stream', () => {
    expect(deriveFileOps(undefined)).toEqual([]);
    expect(deriveFileOps([])).toEqual([]);
  });

  it('skips tool_use events that are not file CRUD families', () => {
    const events: AgentEvent[] = [
      use('Bash', { command: 'ls' }, 't1'),
      use('TodoWrite', { todos: [] }, 't2'),
      use('WebSearch', { query: 'foo' }, 't3'),
    ];
    expect(deriveFileOps(events)).toEqual([]);
  });

  it('aggregates Read/Write/Edit/Delete by full path with basename + ops list', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('Write', { file_path: '/repo/b.ts', content: 'hi' }, 't2'),
      ok('t2'),
      use('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, 't3'),
      ok('t3'),
      use('delete_file', { file_path: '/repo/c.ts' }, 't4'),
      ok('t4'),
    ];
    const rows = deriveFileOps(events);
    expect(rows).toHaveLength(3);
    const a = rows.find((row) => row.fullPath === '/repo/a.ts');
    expect(a).toMatchObject({
      path: 'a.ts',
      fullPath: '/repo/a.ts',
      ops: ['read', 'edit'],
      total: 2,
      status: 'done',
    });
    const b = rows.find((row) => row.fullPath === '/repo/b.ts');
    expect(b).toMatchObject({
      path: 'b.ts',
      ops: ['write'],
      total: 1,
      status: 'done',
    });
    const c = rows.find((row) => row.fullPath === '/repo/c.ts');
    expect(c).toMatchObject({
      path: 'c.ts',
      ops: ['delete'],
      total: 1,
      status: 'done',
    });
  });

  it('deduplicates repeated tool_use events that share an id', () => {
    const events: AgentEvent[] = [
      use('Write', { file_path: '/repo/index.html', content: '<main />' }, 't1'),
      use('Write', { file_path: '/repo/index.html', content: '<main />' }, 't1'),
      ok('t1'),
    ];
    const rows = deriveFileOps(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: 'index.html',
      ops: ['write'],
      total: 1,
    });
    expect(countFileOps(rows).write).toBe(1);
  });

  it('treats a missing tool_result as running and an isError result as error', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      use('Edit', { file_path: '/repo/b.ts' }, 't2'),
      fail('t2'),
    ];
    const rows = deriveFileOps(events);
    expect(rows.find((row) => row.path === 'a.ts')?.status).toBe('running');
    expect(rows.find((row) => row.path === 'b.ts')?.status).toBe('error');
  });

  it('worst status wins when one file gets multiple results', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('Edit', { file_path: '/repo/a.ts' }, 't2'),
      fail('t2'),
    ];
    const [row] = deriveFileOps(events);
    expect(row?.status).toBe('error');
  });

  it('accepts the legacy `path` argument and the snake_case tool aliases', () => {
    const events: AgentEvent[] = [
      use('read_file', { path: '/repo/a.ts' }, 't1'),
      ok('t1'),
      use('create_file', { path: '/repo/b.ts' }, 't2'),
      ok('t2'),
      use('str_replace_edit', { path: '/repo/a.ts' }, 't3'),
      ok('t3'),
      use('remove_file', { target_path: '/repo/c.ts' }, 't4'),
      ok('t4'),
    ];
    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(rows.find((row) => row.path === 'a.ts')?.ops).toEqual(['read', 'edit']);
    expect(rows.find((row) => row.path === 'c.ts')?.ops).toEqual(['delete']);
  });

  it('infers simple Bash rm/unlink targets as delete operations', () => {
    const events: AgentEvent[] = [
      use(
        'Bash',
        { command: 'rm -f ./stale.txt "old file.md" *.log && unlink loose.tmp; echo done' },
        't1',
      ),
      ok('t1'),
    ];

    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.fullPath).sort()).toEqual([
      './stale.txt',
      'loose.tmp',
      'old file.md',
    ]);
    expect(rows.map((row) => row.ops)).toEqual([['delete'], ['delete'], ['delete']]);
  });

  it('stops Bash rm target inference at pipes and redirections', () => {
    const events: AgentEvent[] = [
      use('Bash', { command: 'rm old.txt | cat deletion.log' }, 't1'),
      ok('t1'),
      use('Bash', { command: 'rm stale.txt > deletion.log 2> errors.log' }, 't2'),
      ok('t2'),
      use('Bash', { command: 'rm ./queued.tmp& echo done' }, 't3'),
      ok('t3'),
    ];

    const rows = deriveFileOps(events);
    expect(rows.map((row) => row.fullPath).sort()).toEqual([
      './queued.tmp',
      'old.txt',
      'stale.txt',
    ]);
  });

  it('drops events whose path is missing or "(unnamed)"', () => {
    const events: AgentEvent[] = [
      use('Write', { file_path: '' }, 't1'),
      use('Read', { file_path: '(unnamed)' }, 't2'),
      use('Edit', {}, 't3'),
    ];
    expect(deriveFileOps(events)).toEqual([]);
  });

  it('treats Windows-style paths and trailing slashes the same as POSIX', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: 'C:\\repo\\sub\\file.ts' }, 't1'),
      ok('t1'),
    ];
    const [row] = deriveFileOps(events);
    expect(row?.path).toBe('file.ts');
  });
});

describe('countFileOps', () => {
  it('totals tool_use counts by op family across all entries', () => {
    const events: AgentEvent[] = [
      use('Read', { file_path: '/a.ts' }, 't1'),
      ok('t1'),
      use('Read', { file_path: '/a.ts' }, 't2'),
      ok('t2'),
      use('Write', { file_path: '/b.ts' }, 't3'),
      ok('t3'),
      use('Edit', { file_path: '/a.ts' }, 't4'),
      ok('t4'),
      use('Delete', { path: '/gone.ts' }, 't5'),
      ok('t5'),
    ];
    const rows = deriveFileOps(events);
    const counts = countFileOps(rows);
    expect(counts.read).toBe(2);
    expect(counts.write).toBe(1);
    expect(counts.edit).toBe(1);
    expect(counts.delete).toBe(1);
  });

  it('returns zeros when there are no entries', () => {
    expect(countFileOps([])).toEqual({ read: 0, write: 0, edit: 0, delete: 0 });
  });
});

describe('countArtifactFileOps', () => {
  it('counts each unique file once by its primary artifact op, not per write operation', () => {
    const events: AgentEvent[] = [
      // a.ts written three times + read once → one write.
      use('Write', { file_path: '/a.ts' }, 't1'),
      ok('t1'),
      use('Write', { file_path: '/a.ts' }, 't2'),
      ok('t2'),
      use('Write', { file_path: '/a.ts' }, 't3'),
      ok('t3'),
      use('Read', { file_path: '/a.ts' }, 't4'),
      ok('t4'),
      // b.ts written THEN edited (the #5909 repro path: create + edit the same
      // file) → one edit (edit beats write).
      use('Write', { file_path: '/b.ts' }, 't5'),
      ok('t5'),
      use('Edit', { file_path: '/b.ts' }, 't6'),
      ok('t6'),
      // c.ts edited three times → still one edit.
      use('Edit', { file_path: '/c.ts' }, 't7'),
      ok('t7'),
      use('Edit', { file_path: '/c.ts' }, 't8'),
      ok('t8'),
      use('Edit', { file_path: '/c.ts' }, 't9'),
      ok('t9'),
      // d.ts only read → not an artifact file, not counted.
      use('Read', { file_path: '/d.ts' }, 't10'),
      ok('t10'),
    ];
    const rows = deriveFileOps(events);
    expect(countArtifactFileOps(rows)).toEqual({ write: 1, edit: 2 });
    // The op-level counter is unchanged: a.ts (3) + b.ts (1) writes.
    expect(countFileOps(rows).write).toBe(4);
    expect(countFileOps(rows).edit).toBe(4);
  });
});

describe('hasFileMutationToolUse', () => {
  it('is true for write/edit/delete tools and simple Bash rm/unlink, whatever the result', () => {
    expect(hasFileMutationToolUse([use('Write', { file_path: 'index.html' }, 't1')])).toBe(true);
    expect(hasFileMutationToolUse([use('Edit', { file_path: 'index.html' }, 't1'), fail('t1')])).toBe(true);
    expect(hasFileMutationToolUse([use('delete_file', { path: 'old.txt' }, 't1')])).toBe(true);
    expect(hasFileMutationToolUse([use('Bash', { command: 'rm -f old.txt' }, 't1'), ok('t1')])).toBe(true);
    expect(hasFileMutationToolUse([use('Bash', { command: 'unlink old.txt' }, 't1')])).toBe(true);
  });

  it('is false for reads, non-deleting Bash, and empty streams', () => {
    expect(hasFileMutationToolUse(undefined)).toBe(false);
    expect(hasFileMutationToolUse([])).toBe(false);
    expect(hasFileMutationToolUse([use('Read', { file_path: 'index.html' }, 't1'), ok('t1')])).toBe(false);
    expect(hasFileMutationToolUse([use('Bash', { command: 'ls -la' }, 't1'), ok('t1')])).toBe(false);
  });
});

describe('hasPossibleFileMutationFailure', () => {
  it('is false without events or when nothing errored', () => {
    expect(hasPossibleFileMutationFailure(undefined)).toBe(false);
    expect(hasPossibleFileMutationFailure([])).toBe(false);
    expect(
      hasPossibleFileMutationFailure([
        use('Write', { file_path: 'index.html' }, 't1'),
        ok('t1'),
        use('Bash', { command: 'rm stale.txt' }, 't2'),
        ok('t2'),
      ]),
    ).toBe(false);
  });

  it('flags an errored write/edit/delete tool call or Bash rm/unlink', () => {
    expect(hasPossibleFileMutationFailure([use('Write', { file_path: 'a.html' }, 't1'), fail('t1')])).toBe(true);
    expect(hasPossibleFileMutationFailure([use('Edit', { file_path: 'a.html' }, 't1'), fail('t1')])).toBe(true);
    expect(hasPossibleFileMutationFailure([use('delete_file', { path: 'old.txt' }, 't1'), fail('t1')])).toBe(true);
    expect(hasPossibleFileMutationFailure([use('Bash', { command: 'rm old.txt' }, 't1'), fail('t1')])).toBe(true);
    // One failure among otherwise successful mutations is still a failure.
    expect(
      hasPossibleFileMutationFailure([
        use('Bash', { command: 'rm stale.txt' }, 't1'),
        ok('t1'),
        use('Edit', { file_path: 'index.html' }, 't2'),
        fail('t2'),
      ]),
    ).toBe(true);
  });

  it('flags an errored shell command that deletes without naming rm', () => {
    // The whole point of the wider guard: a shell removes files through forms
    // `extractSimpleBashDeletes` cannot read, and runtimes spell the shell
    // tool several ways. An error from any of them may be a partial deletion.
    for (const command of [
      "find . -name '*.bak' -delete",
      'git clean -fd',
      "find . -name '*.tmp' | xargs rm",
      './scripts/cleanup.sh',
    ]) {
      expect(hasPossibleFileMutationFailure([use('Bash', { command }, 't1'), fail('t1')])).toBe(true);
    }
    for (const shellTool of ['shell', 'exec', 'terminal', 'run_command']) {
      expect(
        hasPossibleFileMutationFailure([use(shellTool, { command: 'rm -rf build' }, 't1'), fail('t1')]),
      ).toBe(true);
    }
  });

  it('does not flag an errored read-only or reporting tool', () => {
    // Second review finding. A catch-all on "anything that is not a read"
    // swept up the discovery tools Design mode actually uses, so a failed
    // WebFetch next to a successful `rm` restored the ARTIFACT_NOT_FOUND card
    // this change exists to remove. Only shell calls and tools that name a
    // write/edit/delete can plausibly have mutated files.
    for (const toolName of [
      'Read',
      'read_file',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'mcp__notion__search',
    ]) {
      expect(hasPossibleFileMutationFailure([use(toolName, {}, 't1'), fail('t1')])).toBe(false);
    }
  });

  it('matches shell tool names case-insensitively', () => {
    // The daemon normalises codex `command_execution` to `Bash`; other
    // runtimes forward their own spelling.
    for (const toolName of ['bash', 'BASH', 'Shell', 'SHELL', 'Terminal', 'local_shell']) {
      expect(
        hasPossibleFileMutationFailure([use(toolName, { command: 'cleanup' }, 't1'), fail('t1')]),
      ).toBe(true);
    }
  });

  it('treats a call without a tool_result as not failed', () => {
    expect(hasPossibleFileMutationFailure([use('Write', { file_path: 'a.html' }, 't1')])).toBe(false);
    expect(hasPossibleFileMutationFailure([use('Bash', { command: 'rm a.txt' }, 't1'), fail('t2')])).toBe(false);
  });
});

describe('extractDeletionTargetPaths', () => {
  const ROOT = '/workspace/proj';

  it('keeps the project-relative path a Bash rm/unlink named', () => {
    expect([
      ...extractDeletionTargetPaths([
        use('Bash', { command: 'rm -f scripts/sketch-i2i.py tests/texture/prompt-fox-refs.txt' }, 't1'),
        ok('t1'),
      ], ROOT),
    ]).toEqual(['scripts/sketch-i2i.py', 'tests/texture/prompt-fox-refs.txt']);
    expect([...extractDeletionTargetPaths([use('Bash', { command: 'unlink ./a/b/loose.tmp' }, 't1')], ROOT)])
      .toEqual(['a/b/loose.tmp']);
  });

  it('keeps the path argument of a delete-named tool', () => {
    for (const [name, input] of [
      ['delete_file', { path: 'assets/stale.txt' }],
      ['rm_file', { file_path: `${ROOT}/assets/stale.txt` }],
      ['unlink_file', { target_path: './assets/stale.txt' }],
    ] as const) {
      expect([...extractDeletionTargetPaths([use(name, input, 't1'), ok('t1')], ROOT)])
        .toEqual(['assets/stale.txt']);
    }
  });

  it('drops an absolute path that is not under the project root', () => {
    expect(extractDeletionTargetPaths([use('Bash', { command: 'rm /tmp/scratch/old.html' }, 't1')], ROOT).size)
      .toBe(0);
    // A `..` escape resolving outside the root, and a climb above its anchor.
    expect(extractDeletionTargetPaths([use('Bash', { command: `rm ${ROOT}/../other/x.txt` }, 't1')], ROOT).size)
      .toBe(0);
    // No root means an absolute path cannot be placed at all.
    expect(extractDeletionTargetPaths([use('Bash', { command: 'rm /anywhere/x.txt' }, 't1')], null).size)
      .toBe(0);
  });

  it('resolves `..` segments that stay inside the project', () => {
    expect([...extractDeletionTargetPaths([use('Bash', { command: 'rm assets/../stale.txt' }, 't1')], ROOT)])
      .toEqual(['stale.txt']);
  });

  it('names nothing for reads, writes, edits, or a shell call with no removal', () => {
    // A shell call is judged on what it asked to remove, not on being a shell.
    expect(extractDeletionTargetPaths(undefined, ROOT).size).toBe(0);
    expect(extractDeletionTargetPaths([], ROOT).size).toBe(0);
    for (const ev of [
      use('Bash', { command: 'ls -la' }, 't1'),
      use('Bash', { command: "find . -name '*.bak' -delete" }, 't1'),
      use('Bash', { command: 'git clean -fd' }, 't1'),
      use('Read', { file_path: 'hero.png' }, 't1'),
      use('Write', { file_path: 'index.html' }, 't1'),
      use('Edit', { file_path: 'index.html' }, 't1'),
      use('WebFetch', {}, 't1'),
    ]) {
      expect(extractDeletionTargetPaths([ev, ok('t1')], ROOT).size).toBe(0);
    }
  });

  it('does not require the call to have succeeded', () => {
    // The listing delta already establishes that something went missing; this
    // only supplies who asked for it.
    expect([...extractDeletionTargetPaths([use('Bash', { command: 'rm stale.txt' }, 't1'), fail('t1')], ROOT)])
      .toEqual(['stale.txt']);
  });
});

describe('attributeRemovedFiles', () => {
  const ROOT = '/workspace/proj';
  const rm = (command: string) => [use('Bash', { command }, 't1'), ok('t1')];

  it('intersects the listing delta with what the run asked to remove', () => {
    expect(attributeRemovedFiles(['assets/stale.txt'], rm('rm assets/stale.txt'), ROOT))
      .toEqual(['assets/stale.txt']);
    // Only the named one; the other removal is someone else's.
    expect(
      attributeRemovedFiles(['assets/stale.txt', 'user-notes.md'], rm('rm assets/stale.txt'), ROOT),
    ).toEqual(['assets/stale.txt']);
  });

  it('does not match a same-named file in another directory', () => {
    expect(attributeRemovedFiles(['assets/stale.txt'], rm('rm other/stale.txt'), ROOT)).toEqual([]);
  });

  it('does not match an unqualified target against a nested entry', () => {
    // Agent shell commands start at the project root, so `rm stale.txt` names
    // the root-level file. Crediting it for a nested removal would need cwd
    // tracking the parser does not have.
    expect(attributeRemovedFiles(['assets/stale.txt'], rm('rm stale.txt'), ROOT)).toEqual([]);
    expect(attributeRemovedFiles(['stale.txt'], rm('rm stale.txt'), ROOT)).toEqual(['stale.txt']);
  });

  it('is empty without removals or without deletion targets', () => {
    expect(attributeRemovedFiles([], rm('rm stale.txt'), ROOT)).toEqual([]);
    expect(attributeRemovedFiles(['stale.txt'], rm('ls'), ROOT)).toEqual([]);
    expect(attributeRemovedFiles(['stale.txt'], undefined, ROOT)).toEqual([]);
  });
});

describe('extractSimpleBashDeletes command position (via deriveFileOps)', () => {
  it('ignores rm/unlink used as an argument or printed text', () => {
    for (const command of ['grep rm stale.txt', 'echo rm stale.txt', 'echo unlink loose.tmp']) {
      expect(deriveFileOps([use('Bash', { command }, 't1'), ok('t1')])).toEqual([]);
    }
  });

  it('still reads rm/unlink in command position, including after a separator', () => {
    expect(
      deriveFileOps([use('Bash', { command: 'npm run build && rm stale.txt' }, 't1'), ok('t1')])
        .map((e) => e.fullPath),
    ).toEqual(['stale.txt']);
    expect(
      deriveFileOps([use('Bash', { command: 'rm a.txt; unlink b.tmp' }, 't1'), ok('t1')])
        .map((e) => e.fullPath),
    ).toEqual(['a.txt', 'b.tmp']);
  });
});
