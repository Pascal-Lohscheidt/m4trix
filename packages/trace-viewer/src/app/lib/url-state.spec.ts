import { describe, expect, it } from 'vitest';
import { parseViewerUrlState, serializeViewerUrlState } from './url-state';

describe('parseViewerUrlState', () => {
  it('reads trace, run and view', () => {
    expect(parseViewerUrlState('?trace=t1&run=r1&view=tree')).toEqual({
      traceId: 't1',
      runId: 'r1',
      view: 'tree',
    });
  });

  it('defaults to the waterfall with nothing selected', () => {
    expect(parseViewerUrlState('')).toEqual({ traceId: null, runId: null, view: 'waterfall' });
  });

  it('ignores a run without a trace and unknown views', () => {
    expect(parseViewerUrlState('?run=r1&view=flame')).toEqual({
      traceId: null,
      runId: null,
      view: 'waterfall',
    });
  });
});

describe('serializeViewerUrlState', () => {
  it('writes selection and omits the default view', () => {
    expect(serializeViewerUrlState({ traceId: 't1', runId: 'r1', view: 'waterfall' })).toBe(
      '?trace=t1&run=r1',
    );
    expect(serializeViewerUrlState({ traceId: 't1', runId: null, view: 'tree' })).toBe(
      '?trace=t1&view=tree',
    );
  });

  it('keeps unrelated params and clears stale viewer keys', () => {
    expect(
      serializeViewerUrlState(
        { traceId: null, runId: 'r1', view: 'waterfall' },
        '?debug=1&trace=old&run=old&view=tree',
      ),
    ).toBe('?debug=1');
  });

  it('writes viewer keys in a fixed order', () => {
    expect(
      serializeViewerUrlState({ traceId: 't2', runId: 'r2', view: 'tree' }, '?trace=t1&view=tree'),
    ).toBe('?trace=t2&run=r2&view=tree');
  });

  it('round-trips through parse', () => {
    const state = { traceId: 'a b/c', runId: 'r&1', view: 'tree' as const };
    expect(parseViewerUrlState(serializeViewerUrlState(state))).toEqual(state);
  });
});
