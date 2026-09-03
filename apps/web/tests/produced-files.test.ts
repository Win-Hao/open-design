import { describe, expect, it } from 'vitest';
import {
  computeRemovedFileNames,
  filterImplicitProducedFiles,
} from '../src/produced-files';
import type { ProjectFile } from '../src/types';

function file(name: string, path = name): ProjectFile {
  return { name, path, size: 1, mtime: 0, kind: 'text', mime: 'text/plain' } as ProjectFile;
}

describe('computeRemovedFileNames', () => {
  it('returns undefined without a turn baseline', () => {
    expect(computeRemovedFileNames(undefined, [file('index.html')])).toBeUndefined();
  });

  it('lists baseline names that the refreshed listing no longer contains', () => {
    const before = new Set(['index.html', 'stale.txt', 'notes.md']);
    const after = [file('index.html'), file('notes.md'), file('new.html')];
    expect(computeRemovedFileNames(before, after)).toEqual(['stale.txt']);
  });

  it('returns an empty list when nothing left the listing', () => {
    const before = ['index.html'];
    expect(computeRemovedFileNames(before, [file('index.html'), file('extra.md')])).toEqual([]);
  });

  it('accepts an array baseline and reports each removed name once', () => {
    expect(
      computeRemovedFileNames(['stale.txt', 'stale.txt', 'index.html'], [file('index.html')]),
    ).toEqual(['stale.txt']);
  });

  it('excludes user sketch files, mirroring produced-file attribution', () => {
    // A `.sketch.json` that vanished during the run is user canvas state, not
    // agent output — the same exemption `filterImplicitProducedFiles` applies
    // to newly appeared files.
    const before = new Set(['hero.sketch.json', 'stale.txt']);
    expect(computeRemovedFileNames(before, [])).toEqual(['stale.txt']);
    expect(filterImplicitProducedFiles([file('hero.sketch.json'), file('stale.txt')])).toEqual([
      file('stale.txt'),
    ]);
  });
});
