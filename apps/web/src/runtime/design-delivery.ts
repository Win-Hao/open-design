import type { ChatSessionMode } from '@open-design/contracts';
import { containsQuestionFormAsk } from '../artifacts/question-form';
import type { AgentEvent, ChatMessage } from '../types';
import { hasFileMutationToolUse, hasPossibleFileMutationFailure } from './file-ops';
import { unfinishedTodosFromEvents } from './todos';

export type DesignDeliveryOutcome =
  | 'not_required'
  | 'awaiting_input'
  | 'delivered'
  | 'report_only'
  | 'no_result'
  | 'delivery_failed';

export interface DesignDeliveryInput {
  sessionMode: ChatSessionMode | null | undefined;
  runStatus: ChatMessage['runStatus'];
  content: string;
  events: AgentEvent[] | undefined;
  producedFileCount: number;
  traceObjectFileCount: number;
  /**
   * Project files the turn-start snapshot listed that the post-turn refresh no
   * longer does. Both listings come from the daemon, so this is a
   * file-system-confirmed deletion count, never an inference from tool events.
   */
  confirmedRemovedFileCount?: number;
  /** Authoritative artifact count reported by the daemon at run finalization. */
  artifactCount?: number;
  persistenceSucceeded?: boolean;
  persistenceFailed?: boolean;
}

/**
 * Delivery failures retain the agent-process `succeeded` status, but they are
 * terminal user-facing failures and must follow the same retry path as a
 * failed process run.
 */
export function isRetryableAssistantTerminalFailure(
  message: Pick<ChatMessage, 'runStatus' | 'resultDeliveryState'>,
): boolean {
  return (
    message.runStatus === 'failed' ||
    message.resultDeliveryState === 'no_result' ||
    message.resultDeliveryState === 'delivery_failed'
  );
}

/**
 * A bare open-tag scan is not enough: a turn that needed no clarification can
 * narrate its decision straight into a `<question-form>` tag, and treating
 * that prose as an ask latches the turn to `awaiting_input` no matter what it
 * delivered. Share the form protocol's own body precondition instead of
 * growing a second regex here.
 */
function asksForUserInput(content: string): boolean {
  return containsQuestionFormAsk(content);
}

function isIntermediateDesignTurn(
  content: string,
  events: AgentEvent[] | undefined,
): boolean {
  return asksForUserInput(content) || unfinishedTodosFromEvents(events).length > 0;
}

function hasLiveArtifactDelivery(events: AgentEvent[] | undefined): boolean {
  return (events ?? []).some(
    (event) =>
      (event.kind === 'live_artifact' && event.action !== 'deleted') ||
      (event.kind === 'live_artifact_refresh' && event.phase === 'succeeded'),
  );
}

/**
 * A deletion is delivery evidence only once the project listing confirms it
 * AND nothing in the turn errored in a way that could have left the project
 * half-mutated. A successful cleanup next to a failed write is still a turn
 * that did not land its work, and must keep the "attempted but failed ->
 * no_result -> Retry" path.
 *
 * The failure guard has to be as parser-independent as the evidence it
 * guards. This branch admits a deletion performed by a command the event
 * parser cannot read, so clearing it with a parser-driven check would let a
 * partial failure through: a `find … -delete` that removes one file and then
 * errors would confirm a removal, show no recognised mutation, and report a
 * concealed partial failure as delivered.
 */
function hasConfirmedDeletionDelivery(input: DesignDeliveryInput): boolean {
  return (
    (input.confirmedRemovedFileCount ?? 0) > 0 &&
    !hasPossibleFileMutationFailure(input.events)
  );
}

/**
 * A successful agent process is not necessarily a delivered design.
 *
 * Design mode is artifact-first, but clarification and explicitly unfinished
 * turns are valid intermediate outcomes. Chat and Plan remain text-first and
 * must never be failed merely because they did not write a project file.
 *
 * A zero-file success is only a missing deliverable when the turn attempted
 * to mutate project files (or an artifact save failed). A turn that never
 * tried to write and answered with substantive text is a report-only result —
 * image analysis and report-only audits end exactly this way — and must not
 * be downgraded to ARTIFACT_NOT_FOUND. The known cost: an agent that merely
 * claims completion without ever calling a write tool now passes as text; the
 * text itself makes that visible to the user.
 *
 * Deletions are the one mutation that never leaves a produced file behind. A
 * turn whose only file work was removing project files has no artifact to
 * count, yet it is not report-only either, because the `rm` was a mutation
 * attempt. The pre/post project-file snapshots settle it: a file the
 * turn-start listing had and the post-turn refresh lacks is a confirmed
 * deletion and, absent any errored mutation, counts as delivery.
 */
export function resolveDesignDeliveryOutcome(
  input: DesignDeliveryInput,
): DesignDeliveryOutcome {
  if (input.sessionMode !== 'design' || input.runStatus !== 'succeeded') {
    return 'not_required';
  }
  if (isIntermediateDesignTurn(input.content, input.events)) {
    return 'awaiting_input';
  }
  if (
    input.producedFileCount > 0 ||
    input.traceObjectFileCount > 0 ||
    (input.artifactCount ?? 0) > 0 ||
    input.persistenceSucceeded ||
    hasLiveArtifactDelivery(input.events) ||
    hasConfirmedDeletionDelivery(input)
  ) {
    return 'delivered';
  }
  if (input.persistenceFailed) return 'delivery_failed';
  // A confirmed deletion that arrived alongside a failed mutation is a
  // partial failure, and it must reach the user as one. The report-only
  // fallback below cannot be trusted to do that: it asks whether the turn
  // *looks* like it tried to mutate, and a shell deletion the parser cannot
  // read (`find … -delete`) does not, so the turn would settle on
  // `report_only` — no failure card, no Retry — while the snapshot proves
  // files went missing and a mutation errored.
  //
  // Scoped to turns carrying this module's own confirmed-deletion signal, so
  // the report-only escape is unchanged for every turn without one.
  if (
    (input.confirmedRemovedFileCount ?? 0) > 0 &&
    hasPossibleFileMutationFailure(input.events)
  ) {
    return 'no_result';
  }
  if (!hasFileMutationToolUse(input.events) && input.content.trim().length > 0) {
    return 'report_only';
  }
  return 'no_result';
}

/**
 * The run-status event can arrive before the final project-file refresh. Keep
 * completion feedback quiet during that gap so users never hear "success"
 * immediately before the same turn is downgraded to a delivery failure.
 */
export function designDeliveryVerificationPending(
  message: Pick<
    ChatMessage,
    | 'sessionMode'
    | 'runStatus'
    | 'resultDeliveryState'
    | 'content'
    | 'events'
    | 'producedFiles'
    | 'traceObjectFiles'
  >,
): boolean {
  if (message.sessionMode !== 'design' || message.runStatus !== 'succeeded') return false;
  if (message.resultDeliveryState) return false;
  if (isIntermediateDesignTurn(message.content, message.events)) return false;
  return message.producedFiles === undefined || message.traceObjectFiles === undefined;
}

/**
 * A succeeded Design message that still lacks delivery metadata long after its
 * run finished is a historical row whose delivery never materialized (e.g. a
 * row persisted by an older build before the final project-file refresh, or an
 * interrupted persistence path). Auto-replaying such a row on every reload is
 * the #6505 loop — the metadata will never appear, so each reload re-enters the
 * reattach path and the chat stays visually loading.
 *
 * Reconcile only within a short window after the run's terminal time (enough
 * for the run-status event to race ahead of the project-file refresh the
 * `designDeliveryVerificationPending` gap exists to absorb); past that window
 * the row is treated as a terminal outcome instead of being replayed.
 */
export function designDeliveryReconciliationStale(
  message: Pick<
    ChatMessage,
    | 'sessionMode'
    | 'runStatus'
    | 'resultDeliveryState'
    | 'endedAt'
    | 'startedAt'
    | 'createdAt'
  >,
  now: number = Date.now(),
): boolean {
  if (message.sessionMode !== 'design' || message.runStatus !== 'succeeded') return false;
  if (message.resultDeliveryState) return false;
  // The #6505 legacy shape can lack `endedAt` entirely (rows persisted before
  // `endedAt` existed), so bound the reconciliation age from any persisted
  // terminal timestamp — `endedAt` first, then the run/message start time. A
  // row with no timestamp at all defers to the existing verification logic.
  const terminalAt = message.endedAt ?? message.startedAt ?? message.createdAt;
  if (terminalAt == null) return false;
  return now - terminalAt > DESIGN_DELIVERY_RECONCILIATION_WINDOW_MS;
}

/** How long after a run's terminal time a Design-mode delivery may be reconciled. */
export const DESIGN_DELIVERY_RECONCILIATION_WINDOW_MS = 5 * 60 * 1000;
