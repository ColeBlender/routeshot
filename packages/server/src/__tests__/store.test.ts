import { describe, expect, it } from 'vitest';

import { MemoryStore, type StoredCompare } from '../store.js';
import { makePng } from './fixtures.js';

function compare(id: string, overrides: Partial<StoredCompare> = {}): StoredCompare {
  return {
    id,
    baselineId: 'run-a',
    candidateId: 'run-b',
    threshold: 0,
    report: {
      baseline: { id: 'run-a', label: 'baseline' },
      candidate: { id: 'run-b', label: 'candidate' },
      threshold: 0,
      routes: [],
      summary: { total: 0, unchanged: 0, changed: 0, added: 0, removed: 0, unverified: 0 },
      verdicts: undefined,
    },
    createdAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  it('keeps the first compare of a triple and hands it back to the second writer', async () => {
    const store = new MemoryStore();

    expect((await store.saveCompareAsync(compare('cmp-first'))).id).toBe('cmp-first');
    expect((await store.saveCompareAsync(compare('cmp-second'))).id).toBe('cmp-first');

    // The loser was never stored, so its id has to stay unreachable.
    expect(await store.getCompareAsync('cmp-second')).toBeUndefined();
    expect((await store.findCompareAsync('run-a', 'run-b', 0))?.id).toBe('cmp-first');
    // A different threshold is a different cache key and gets its own row.
    expect((await store.saveCompareAsync(compare('cmp-other', { threshold: 0.5 }))).id).toBe(
      'cmp-other'
    );
  });

  it('deletes only the files of the owner it is given', async () => {
    const store = new MemoryStore();
    const png = makePng(2, 2, [0, 0, 0]);
    await store.putFilesAsync('cmp-a', [{ name: 'index.png', bytes: png }]);
    await store.putFilesAsync('cmp-b', [{ name: 'index.png', bytes: png }]);

    await store.deleteFilesAsync('cmp-a');

    expect(await store.getFileAsync('cmp-a', 'index.png')).toBeUndefined();
    expect(await store.getFileAsync('cmp-b', 'index.png')).toEqual(png);
  });
});
