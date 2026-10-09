import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunNode } from '../types';
import {
  createLangGraphPlumbingGroup,
  FILTER_GROUPS_STORAGE_KEY,
  type FilterGroup,
  loadFilterGroups,
  nodeMatchesHide,
} from './filter-groups';
import { applyRunTreeDisplayFilter } from './run-tree-display-filter';

function node(name: string, children: RunNode[] = [], status = 'success'): RunNode {
  return {
    runId: name,
    name,
    type: 'chain',
    status,
    startTime: '2026-05-09T12:00:00.000Z',
    children,
  };
}

const ctx = (name: string, status = 'success') => ({
  runId: name,
  name,
  type: 'chain',
  status,
  depth: 1,
});

describe('LangGraph plumbing group', () => {
  const groups = [createLangGraphPlumbingGroup()];

  it('hides wiring spans but keeps graph nodes', () => {
    expect(nodeMatchesHide(groups, ctx('ChannelWrite<branch:to:planner_1>'))).toBe(true);
    expect(nodeMatchesHide(groups, ctx('Branch<intake,research,fast_path>'))).toBe(true);
    expect(nodeMatchesHide(groups, ctx('__start__'))).toBe(true);
    expect(nodeMatchesHide(groups, ctx('planner_1'))).toBe(false);
  });

  it('never hides error runs', () => {
    expect(nodeMatchesHide(groups, ctx('ChannelWrite<...>', 'error'))).toBe(false);
  });

  it('promotes real nodes and keeps failing plumbing in the display tree', () => {
    const root = node('LangGraph', [
      node('__start__', [node('ChannelWrite<...>')]),
      node('planner_1', [node('ChannelWrite<branch:to:researcher_1>', [], 'error')]),
    ]);
    const result = applyRunTreeDisplayFilter(root, groups);
    expect(result.root?.children.map((child) => child.name)).toEqual(['planner_1']);
    expect(result.root?.children[0].children.map((child) => child.name)).toEqual([
      'ChannelWrite<branch:to:researcher_1>',
    ]);
  });
});

describe('loadFilterGroups', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(value: string | null) {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (key === FILTER_GROUPS_STORAGE_KEY ? value : null),
      },
    });
  }

  it('starts first-time users with plumbing hidden', () => {
    stubStorage(null);
    expect(loadFilterGroups()).toEqual([createLangGraphPlumbingGroup()]);
  });

  it('respects saved groups, including an empty list', () => {
    stubStorage('[]');
    expect(loadFilterGroups()).toEqual([]);
    const saved: FilterGroup[] = [
      {
        id: 'g1',
        name: 'Tools',
        conditions: [{ kind: 'spanType', value: 'tool' }],
        hideEnabled: true,
        collapseEnabled: false,
      },
    ];
    stubStorage(JSON.stringify(saved));
    expect(loadFilterGroups()).toEqual(saved);
  });

  it('falls back to no groups on corrupt storage', () => {
    stubStorage('{not json');
    expect(loadFilterGroups()).toEqual([]);
  });
});
