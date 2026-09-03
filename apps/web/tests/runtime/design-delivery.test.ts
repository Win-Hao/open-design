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
        confirmedRemovedFileCount: 2,
      }),
    ).toBe('delivered');
    // The confirmation comes from the file listing, not from the tool event:
    // an agent that removes files through a command the Bash inference does
    // not recognise still delivered once the listing shows the file gone.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: '',
        events: [
          { kind: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: "find . -name '*.bak' -delete" } },
          { kind: 'tool_result', toolUseId: 'bash-2', content: '', isError: false },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileCount: 1,
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
        confirmedRemovedFileCount: 1,
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
        confirmedRemovedFileCount: 1,
      }),
    ).toBe('no_result');
  });

  it('does not upgrade a turn to delivered when an unrecognised shell deletion errored', () => {
    // Review finding on the first cut of this change. The delivered branch
    // accepts a removal the event parser cannot attribute, so clearing it with
    // a parser-driven failure check was asymmetric: a `find … -delete` that
    // removes one file and then errors confirmed a removal, showed no
    // recognised mutation, and was reported as delivered.
    //
    // The turn settles on `report_only`, which is what `upstream/main` already
    // returns for this input: `hasFileMutationToolUse` cannot read a deletion
    // out of `find … -delete` either, so the turn was never eligible for
    // `no_result`. Reaching `no_result` here would mean widening the
    // report-only escape for every Design turn with a failed shell command,
    // which is a separate change with its own blast radius. What this PR owes
    // is that its new branch does not *upgrade* the turn to `delivered`.
    expect(
      resolveDesignDeliveryOutcome({
        sessionMode: 'design',
        runStatus: 'succeeded',
        content: 'Cleaned up the backup files.',
        events: [
          { kind: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: "find . -name '*.bak' -delete" } },
          {
            kind: 'tool_result',
            toolUseId: 'bash-1',
            content: "find: './locked': Permission denied",
            isError: true,
          },
        ],
        producedFileCount: 0,
        traceObjectFileCount: 0,
        confirmedRemovedFileCount: 1,
      }),
    ).not.toBe('delivered');
    // Same shape for the other spellings of the shell tool.
    for (const shellTool of ['shell', 'exec', 'terminal']) {
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
          confirmedRemovedFileCount: 1,
        }),
      ).not.toBe('delivered');
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
        confirmedRemovedFileCount: 1,
      }),
    ).toBe('delivered');
  });

  it('keeps an unconfirmed deletion attempt a missing deliverable', () => {
    // Only the project-file snapshot confirms a deletion. An `rm` whose target
    // never left the listing (or lived outside the project) is still an
    // attempted mutation with nothing to show for it.
    for (const confirmedRemovedFileCount of [0, undefined]) {
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
          confirmedRemovedFileCount,
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
        confirmedRemovedFileCount: 1,
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
