import { describe, expect, it } from 'vitest';
import {
  designDeliveryReconciliationStale,
  designDeliveryVerificationPending,
  resolveDesignDeliveryOutcome,
} from '../../src/runtime/design-delivery';
import type { AgentEvent } from '../../src/types';

describe('resolveDesignDeliveryOutcome', () => {
  it('treats a text answer without any file-write attempt as a report-only result', () => {
    // Image analysis / report-only audits legitimately end with prose and no
    // new project file (#5714, #5718). Only fail delivery when the agent
    // actually attempted to write files and nothing landed.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'The hero image uses low contrast; increase it for readability.',
        events: [
          { kind: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'hero.png' } },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('report_only');
    // BYOK API runs have no tool events at all; a substantive text answer is
    // still a report-only result, not a missing artifact.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'I finished the design.',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('report_only');
  });

  it('requires file delivery once the turn attempted to write project files', () => {
    for (const attempt of [
      { kind: 'tool_use' as const, id: 'w-1', name: 'Write', input: { file_path: 'index.html' } },
      { kind: 'tool_use' as const, id: 'e-1', name: 'Edit', input: { file_path: 'index.html' } },
      { kind: 'tool_use' as const, id: 'b-1', name: 'Bash', input: { command: 'rm stale.html' } },
    ]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'I finished the design.',
          events: [attempt],
          producedFileCount: 0,
          traceObjectFileCount: 0,
        }),
      ).toBe('no_result');
    }
  });

  it('does not accept an empty answer as a report-only result', () => {
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '   ',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('no_result');
  });

  it('accepts newly produced or successfully modified project files as delivery evidence', () => {
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [],
        producedFileCount: 1,
        traceObjectFileCount: 0,
      }),
    ).toBe('delivered');
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 1,
      }),
    ).toBe('delivered');
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        artifactCount: 1,
      }),
    ).toBe('delivered');
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        persistenceSucceeded: true,
      }),
    ).toBe('delivered');
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [
          {
            kind: 'live_artifact',
            action: 'created',
            projectId: 'project-1',
            artifactId: 'artifact-1',
            title: 'Dashboard',
          },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('delivered');
  });

  it('distinguishes a failed artifact save from a run that produced no result', () => {
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '<artifact type="text/html">broken</artifact>',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        persistenceFailed: true,
      }),
    ).toBe('delivery_failed');
  });

  it('keeps a failed artifact save a failure even without file-write tool calls', () => {
    // A BYOK <artifact> block that failed to persist is a delivery failure;
    // the report-only escape must never mask it.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Here is the landing page you asked for.',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        persistenceFailed: true,
      }),
    ).toBe('delivery_failed');
  });

  it('does not fail clarification turns or turns with explicitly unfinished work', () => {
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '<question-form id="brief">{"questions":[]}</question-form>',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('awaiting_input');
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [
          {
            kind: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { id: 'step-1', content: 'Build the page', status: 'in_progress' },
                { id: 'step-2', content: 'Verify the preview', status: 'pending' },
              ],
            },
          },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('awaiting_input');
  });

  it('does not latch a no-clarification turn to awaiting_input on a stray open tag', () => {
    // Production repro: an OD Next strategy turn that needed no clarification
    // narrated its decision into an open <question-form> tag. The tail is
    // prose, so no form was ever asked — the turn must be judged on its
    // deliverables, not parked as awaiting input.
    const content =
      '策略判断信息充足，将直接进入生产。\n\n<question-form> 无需提出';
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content,
        events: [],
        producedFileCount: 2,
        traceObjectFileCount: 0,
      }),
    ).toBe('delivered');
    // Same tag, same absence of a real ask: a zero-file report turn is
    // report_only, not awaiting_input.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content,
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('report_only');
    expect(
      designDeliveryVerificationPending({
        sessionMode: 'design',
        runStatus: 'succeeded',
        resultDeliveryState: undefined,
        content,
        events: [],
        producedFiles: undefined,
        traceObjectFiles: undefined,
      }),
    ).toBe(true);
  });

  it('still treats a mid-stream question-form body as awaiting input', () => {
    // A truncated but still-plausible JSON body is a real ask that simply has
    // not finished streaming — it must keep its awaiting_input classification.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Quick brief first.\n<question-form id="brief">{"questions":[',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('awaiting_input');
  });

  it('does not impose artifact delivery on Chat/Plan or already-failed runs', () => {
    for (const sessionMode of ['chat', 'plan'] as const) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode,
          runStatus: 'succeeded',
          content: 'Text-only response',
          events: [],
          producedFileCount: 0,
          traceObjectFileCount: 0,
        }),
      ).toBe('not_required');
    }
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'failed',
        content: '',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
      }),
    ).toBe('not_required');
  });

  it('accepts a file-system-confirmed in-project deletion as delivery evidence', () => {
    // A Design turn whose only file mutation is a Bash `rm` of stale project
    // files, followed by a substantive summary, is a completed turn: the
    // pre/post project-file snapshots confirm the removal. Deletions never
    // raise producedFileCount, so without this signal the turn fell through
    // to ARTIFACT_NOT_FOUND even though the run succeeded and the files were
    // gone.
    const deleteOnlyEvents: AgentEvent[] = [
      {
        kind: 'tool_use',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'rm -f scripts/sketch-i2i.py tests/texture/prompt-fox-refs.txt && ls scripts' },
      },
      { kind: 'tool_result', toolUseId: 'bash-1', content: 'gen_sketch.py', isError: false },
    ];
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the stale sketch script and the unused prompt reference list.',
        events: deleteOnlyEvents,
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['scripts/sketch-i2i.py', 'tests/texture/prompt-fox-refs.txt'],
      }),
    ).toBe('delivered');
    // Only the removals this run asked for count. A listing delta that the
    // run's own tool calls do not name is someone else's deletion as far as
    // this module can tell, so the extra name is ignored rather than credited.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the stale sketch script.',
        events: [
          { kind: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'rm -f scripts/sketch-i2i.py' } },
          { kind: 'tool_result', toolUseId: 'bash-2', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['scripts/sketch-i2i.py', 'unrelated-user-file.txt'],
      }),
    ).toBe('delivered');
    // A delete-named tool attributes through its path argument too.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed it.',
        events: [
          { kind: 'tool_use', id: 'd-1', name: 'delete_file', input: { path: 'assets/stale.txt' } },
          { kind: 'tool_result', toolUseId: 'd-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['assets/stale.txt'],
      }),
    ).toBe('delivered');
  });

  it('does not let a confirmed deletion rescue a turn whose file mutation errored', () => {
    // "Attempted but failed -> no_result -> Retry" must survive: a successful
    // cleanup next to a failed Edit is still a turn that did not land its work.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Cleaned up and updated the page.',
        events: [
          { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm stale.html' } },
          { kind: 'tool_result', toolUseId: 'bash-1', content: '', isError: false },
          { kind: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'index.html' } },
          { kind: 'tool_result', toolUseId: 'edit-1', content: 'String not found', isError: true },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('no_result');
    // The errored mutation can be the deletion itself (`rm a b` with `b`
    // missing removes `a` and still exits non-zero).
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the files.',
        events: [
          { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm stale.html missing.html' } },
          {
            kind: 'tool_result',
            toolUseId: 'bash-1',
            content: 'rm: missing.html: No such file or directory',
            isError: true,
          },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('no_result');
  });

  it('keeps an attributed deletion retryable when a mutation errored', () => {
    // Round three: blocking the upgrade to `delivered` was not enough. The
    // turn then fell to `report_only`, which has neither a failure card nor
    // Retry, so a partial deletion read as a successful text-only turn. When
    // the run asked to remove a file, the file is gone, AND a mutation
    // errored, the turn must stay retryable.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Cleaned up the backup files.',
        events: [
          { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm -f stale.txt other.bak' } },
          {
            kind: 'tool_result',
            toolUseId: 'bash-1',
            content: "rm: './other.bak': Permission denied",
            isError: true,
          },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('no_result');
    // Round five gated this branch on the same attribution as the delivered
    // branch. A failed command that named nothing cannot raise a failure card
    // over a removal this run may have had nothing to do with; that turn keeps
    // the outcome it had before this signal existed.
    for (const shellTool of ['Bash', 'shell', 'exec', 'terminal']) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Cleaned up.',
          events: [
            { kind: 'tool_use', id: 's-1', name: shellTool, input: { command: 'git clean -fd' } },
            { kind: 'tool_result', toolUseId: 's-1', content: 'error', isError: true },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
        }),
      ).toBe('report_only');
    }
  });

  it('still accepts a confirmed deletion when only a read errored', () => {
    // The wider guard must not swallow the fix itself: a failed Read alongside
    // a confirmed removal is not a mutation failure.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the stale file; the reference list was already gone.',
        events: [
          { kind: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'missing.txt' } },
          { kind: 'tool_result', toolUseId: 'read-1', content: 'not found', isError: true },
          { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm -f stale.txt' } },
          { kind: 'tool_result', toolUseId: 'bash-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('delivered');
  });

  it('keeps a confirmed deletion delivered when a read-only tool errored', () => {
    // Second review finding. Design-mode discovery uses WebFetch; a failed
    // lookup says nothing about whether the deletion landed, and must not
    // withdraw the delivery the file listing already confirmed.
    for (const toolName of ['WebFetch', 'WebSearch', 'Grep', 'Glob', 'TodoWrite', 'Read']) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Removed the stale file; the reference lookup failed but was not needed.',
          events: [
            { kind: 'tool_use', id: 'ro-1', name: toolName, input: {} },
            { kind: 'tool_result', toolUseId: 'ro-1', content: 'timeout', isError: true },
            { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm -f stale.txt' } },
            { kind: 'tool_result', toolUseId: 'bash-1', content: '', isError: false },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
        }),
      ).toBe('delivered');
    }
  });

  it('intersects nested project-relative paths without collapsing them', () => {
    // Sixth review round. The daemon listing names a nested file by its
    // project-relative path (`assets/stale.txt`), so collapsing a deletion
    // target to its basename made the intersection empty for every nested
    // file — which is most of them, including the two in the original report.
    for (const event of [
      { kind: 'tool_use' as const, id: 't-1', name: 'Bash', input: { command: 'rm assets/stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'Bash', input: { command: 'rm ./assets/stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'Bash', input: { command: 'rm /workspace/proj/assets/stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'delete_file', input: { path: 'assets/stale.txt' } },
    ]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Removed the stale asset.',
          events: [event, { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false }],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['assets/stale.txt'],
          projectRoot: '/workspace/proj',
        }),
      ).toBe('delivered');
    }
  });

  it('does not let a same-named file in another directory stand in', () => {
    // The reason the match is exact rather than by basename: removing
    // `other/stale.txt` is not evidence that `assets/stale.txt` was this
    // run's doing. Both turns issued a parseable `rm`, so they are mutation
    // attempts with nothing attributable to show, and stay retryable — the
    // same outcome as a deletion aimed outside the project.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the stale asset.',
        events: [
          { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'rm other/stale.txt' } },
          { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['assets/stale.txt'],
        projectRoot: '/workspace/proj',
      }),
    ).toBe('no_result');
    // An absolute path outside the project root cannot be placed inside it.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the scratch copy.',
        events: [
          { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'rm /tmp/scratch/assets/stale.txt' } },
          { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['assets/stale.txt'],
        projectRoot: '/workspace/proj',
      }),
    ).toBe('no_result');
  });

  it('does not credit an unqualified target for a nested removal', () => {
    // Seventh review round, and my previous test made the leap it warns
    // about: it was named for `cd assets && rm stale.txt` but the fixture had
    // no `cd`. Agent shell commands start at the project root, so a bare
    // `rm -f stale.txt` names the root-level file; if `assets/stale.txt`
    // vanished concurrently, crediting the run for it would be inventing a
    // deletion. Resolving the subdirectory case needs the parser to track the
    // effective working directory, which it does not.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Removed the stale file.',
        events: [
          { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'rm -f stale.txt' } },
          { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['assets/stale.txt'],
        projectRoot: '/workspace/proj',
      }),
    ).toBe('no_result');
  });

  it('does not treat rm named as an argument or printed text as a deletion', () => {
    // `grep rm stale.txt` deletes nothing. Scanning every shell word for the
    // token invented a target the command never had, which an unrelated
    // concurrent removal of that same file would then match.
    for (const command of [
      'grep rm stale.txt',
      'echo rm stale.txt',
      'cat notes-about-rm stale.txt',
      // Eighth round: `>` is a redirection belonging to `echo`, not a command
      // boundary. This writes into a file named `rm`; it removes nothing.
      'echo > rm stale.txt',
      'cat input.txt > rm stale.txt',
    ]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Looked through the project notes.',
          events: [
            { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command } },
            { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
          projectRoot: '/workspace/proj',
        }),
      ).toBe('report_only');
    }
    // Still credited when `rm` really is the command, including after a
    // shell separator.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Built and cleaned up.',
        events: [
          { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'npm run build && rm stale.txt' } },
          { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
        projectRoot: '/workspace/proj',
      }),
    ).toBe('delivered');
  });

  it('attributes a deletion under every runtime spelling of the shell tool', () => {
    // Ninth review round. The daemon normalises codex `command_execution` to
    // `Bash`, but OpenCode and the pi RPC runtime forward `part.tool`
    // unchanged, so the same shell arrives as lowercase `bash`. An exact-name
    // check left those runtimes' delete-only turns falling through to
    // `report_only` — the original bug, still unfixed for them.
    for (const toolName of ['Bash', 'bash', 'shell', 'exec', 'terminal', 'local_shell']) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Removed the stale file.',
          events: [
            { kind: 'tool_use', id: 't-1', name: toolName, input: { command: 'rm stale.txt' } },
            { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
          projectRoot: '/workspace/proj',
        }),
      ).toBe('delivered');
    }
  });

  it('does not credit a read-only turn for a file that vanished from outside it', () => {
    // Fourth review round. Two project-file listings prove a name disappeared,
    // never who removed it. A user deleting a file in another tab, a second
    // agent, or an editor writing to the same directory all produce the same
    // delta. A turn that only read files is not a candidate author and must
    // keep its report-only outcome instead of inheriting the deletion.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'The hero image uses low contrast; increase it for readability.',
        events: [
          { kind: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'hero.png' } },
          { kind: 'tool_result', toolUseId: 'read-1', content: 'ok', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('report_only');
    // Same for a turn with no tool events at all (BYOK), and for the
    // discovery tools that round three established as non-mutating.
    for (const events of [
      [],
      [
        { kind: 'tool_use' as const, id: 'w-1', name: 'WebFetch', input: { url: 'https://example.com' } },
        { kind: 'tool_result' as const, toolUseId: 'w-1', content: 'ok', isError: false },
      ],
    ]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Here is the audit you asked for.',
          events,
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
        }),
      ).toBe('report_only');
    }
  });

  it('credits only the deletions the run named', () => {
    // The attribution gate must not undo the fix: a parsed `rm` operand or a
    // delete-named tool's path argument still credits the run.
    for (const event of [
      { kind: 'tool_use' as const, id: 't-1', name: 'Bash', input: { command: 'rm -f stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'Bash', input: { command: 'unlink ./stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'delete_file', input: { path: 'stale.txt' } },
      { kind: 'tool_use' as const, id: 't-1', name: 'rm_file', input: { file_path: '/abs/proj/stale.txt' } },
    ]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Removed the stale file.',
          events: [event, { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false }],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
          projectRoot: '/abs/proj',
        }),
      ).toBe('delivered');
    }
    // A shell call that names no removal target attributes nothing, however
    // capable the shell is. This is the round-five requirement: the command
    // text is in the event, so `ls` is judged on what it asked to remove.
    // The documented cost is that a removal phrased so the parser cannot read
    // it (`find … -delete`, `git clean`) also attributes nothing, and its turn
    // keeps the outcome it had before this signal existed.
    for (const command of ['ls', "find . -name '*.bak' -delete", 'git clean -fd']) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Had a look around the project.',
          events: [
            { kind: 'tool_use', id: 't-1', name: 'Bash', input: { command } },
            { kind: 'tool_result', toolUseId: 't-1', content: '', isError: false },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames: ['stale.txt'],
        }),
      ).toBe('report_only');
    }
  });

  it('keeps an unconfirmed deletion attempt a missing deliverable', () => {
    // Only the project-file snapshot confirms a deletion. An `rm` whose target
    // never left the listing (or lived outside the project) is still an
    // attempted mutation with nothing to show for it.
    for (const confirmedRemovedFileNames of [[], undefined]) {
      expect(
        resolveDesignDeliveryOutcome({
          sessionMode: 'design',
          runStatus: 'succeeded',
          content: 'Removed /tmp/scratch/old.html.',
          events: [
            { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'rm /tmp/scratch/old.html' } },
            { kind: 'tool_result', toolUseId: 'bash-1', content: '', isError: false },
          ],
          producedFileCount: 0,
          traceObjectFileCount: 0,
          confirmedRemovedFileNames,
        }),
      ).toBe('no_result');
    }
  });

  it('does not let a confirmed deletion override a clarification turn', () => {
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '<question-form id="brief">{"questions":[]}</question-form>',
        events: [],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileNames: ['stale.txt'],
      }),
    ).toBe('awaiting_input');
  });

  it('holds completion feedback until Design-mode file verification settles', () => {
    expect(
      designDeliveryVerificationPending({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Done.',
        events: [],
      }),
    ).toBe(true);
    expect(
      designDeliveryVerificationPending({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Done.',
        events: [],
        producedFiles: [],
        traceObjectFiles: [],
      }),
    ).toBe(false);
    expect(
      designDeliveryVerificationPending({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '<question-form id="brief">{"questions":[]}</question-form>',
        events: [],
      }),
    ).toBe(false);
  });
});

describe('designDeliveryReconciliationStale', () => {
  const now = 1_000_000;

  it('treats a run that finished long ago as stale (no more auto-replay)', () => {
    expect(
      designDeliveryReconciliationStale(
        {
          sessionMode: 'design',
          runStatus: 'succeeded',
          endedAt: now - 24 * 60 * 60 * 1000,
        },
        now,
      ),
    ).toBe(true);
  });

  it('keeps a freshly completed run reconcilable', () => {
    expect(
      designDeliveryReconciliationStale(
        {
          sessionMode: 'design',
          runStatus: 'succeeded',
          endedAt: now - 30_000,
        },
        now,
      ),
    ).toBe(false);
  });

  it('does not mark a row with no timestamp at all as stale', () => {
    expect(
      designDeliveryReconciliationStale(
        { sessionMode: 'design', runStatus: 'succeeded' },
        now,
      ),
    ).toBe(false);
  });

  it('treats a legacy row without endedAt as stale when its start time is old', () => {
    // #6505 rows persisted before `endedAt` existed carry only `startedAt`;
    // the age bound falls back to it so reloads stop auto-replaying.
    expect(
      designDeliveryReconciliationStale(
        { sessionMode: 'design', runStatus: 'succeeded', startedAt: now - 24 * 60 * 60 * 1000 },
        now,
      ),
    ).toBe(true);
  });

  it('ignores already-resolved deliveries and non-design/non-succeeded rows', () => {
    expect(
      designDeliveryReconciliationStale(
        { sessionMode: 'design', runStatus: 'succeeded', resultDeliveryState: 'delivered', endedAt: 1 },
        now,
      ),
    ).toBe(false);
    expect(
      designDeliveryReconciliationStale(
        { sessionMode: 'chat', runStatus: 'succeeded', endedAt: 1 },
        now,
      ),
    ).toBe(false);
    expect(
      designDeliveryReconciliationStale(
        { sessionMode: 'design', runStatus: 'failed', endedAt: 1 },
        now,
      ),
    ).toBe(false);
  });
});
