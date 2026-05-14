import { describe, expect, it } from 'vitest';
import { normalizeViewerSettings } from './viewer-settings';

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
});
