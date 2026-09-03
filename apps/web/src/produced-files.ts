import type { ProjectFile } from './types';

// Implicit attribution is based on project-file timing or pre/post file-list
// diffs. User-created sketches can change during a run, but that does not make
// them assistant output files unless a run records them explicitly.
export function isImplicitProducedFileCandidate(
  file: Pick<ProjectFile, 'name' | 'path'>,
): boolean {
  const lowerPath = (file.path ?? file.name).toLowerCase();
  return !lowerPath.endsWith('.sketch.json');
}

export function filterImplicitProducedFiles(files: readonly ProjectFile[]): ProjectFile[] {
  return files.filter(isImplicitProducedFileCandidate);
}

/**
 * Names the turn-start project listing had that the post-turn refresh no
 * longer has: the reverse of the produced-file diff, keyed by the same
 * `ProjectFile.name` the pre-turn snapshot persists. Both listings come from
 * the daemon, so a vanished name is a deletion the file system confirmed, not
 * one inferred from tool events. Sketch files are exempt for the same reason
 * they are exempt from produced-file attribution. Returns `undefined` without
 * a baseline, matching `computeProducedFiles`.
 */
export function computeRemovedFileNames(
  beforeNames: ReadonlySet<string> | readonly string[] | undefined,
  next: readonly ProjectFile[],
): string[] | undefined {
  if (!beforeNames) return undefined;
  const nextNames = new Set(next.map((file) => file.name));
  const removed: string[] = [];
  for (const name of new Set<string>(beforeNames)) {
    if (nextNames.has(name)) continue;
    if (!isImplicitProducedFileCandidate({ name })) continue;
    removed.push(name);
  }
  return removed;
}
