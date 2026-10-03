import { describe, expect, it } from 'vitest';
import { ANY_CUSTOM_PROFILE, normalizeViewerSettings } from './viewer-settings';

describe('normalizeViewerSettings', () => {
  it('defaults trace profiles when missing', () => {
    const s = normalizeViewerSettings({ autoLoad: true, autoUpdatePreset: 'm1' });
    expect(s.enabledTraceProfileIds).toEqual(['raw']);
    expect(s.activeTraceProfileId).toBe('raw');
  });

  it('always keeps raw enabled', () => {
    const s = normalizeViewerSettings({
      enabledTraceProfileIds: ['langgraph'],
      activeTraceProfileId: 'langgraph',
    });
    expect(s.enabledTraceProfileIds).toContain('raw');
  });

  it('falls back active profile when disabled', () => {
    const s = normalizeViewerSettings({
      enabledTraceProfileIds: ['raw'],
      activeTraceProfileId: 'langgraph',
    });
    expect(s.activeTraceProfileId).toBe('raw');
  });

  it('allows langgraph when listed', () => {
    const s = normalizeViewerSettings({
      enabledTraceProfileIds: ['raw', 'langgraph'],
      activeTraceProfileId: 'langgraph',
    });
    expect(s.enabledTraceProfileIds).toEqual(['raw', 'langgraph']);
    expect(s.activeTraceProfileId).toBe('langgraph');
  });

  it('keeps custom profiles only when they are known', () => {
    const known = new Set(['custom:p1']);
    const s = normalizeViewerSettings(
      {
        enabledTraceProfileIds: ['raw', 'custom:p1', 'custom:gone', 'bogus' as never],
        activeTraceProfileId: 'custom:p1',
      },
      (id) => known.has(id),
    );
    expect(s.enabledTraceProfileIds).toEqual(['raw', 'custom:p1']);
    expect(s.activeTraceProfileId).toBe('custom:p1');
  });

  it('falls back to raw when the active custom profile was deleted', () => {
    const s = normalizeViewerSettings({
      enabledTraceProfileIds: ['raw', 'custom:p1'],
      activeTraceProfileId: 'custom:p1',
    });
    expect(s.enabledTraceProfileIds).toEqual(['raw']);
    expect(s.activeTraceProfileId).toBe('raw');
  });

  it('ANY_CUSTOM_PROFILE keeps well-formed custom ids only', () => {
    expect(ANY_CUSTOM_PROFILE('custom:p1')).toBe(true);
    expect(ANY_CUSTOM_PROFILE('custom:')).toBe(false);
    expect(ANY_CUSTOM_PROFILE('p1')).toBe(false);
  });
});
