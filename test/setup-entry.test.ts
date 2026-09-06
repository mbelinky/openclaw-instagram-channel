import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', () => ({
  defineSetupPluginEntry: (plugin: unknown) => ({ plugin }),
}));

import setup from '../src/openclaw/setup-entry.js';

afterEach(() => vi.unstubAllEnvs());

describe('read-only setup channel', () => {
  it('exposes the channel metadata and account adapter required by doctor', () => {
    vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-secret');
    vi.stubEnv('INSTAGRAM_VERIFY_TOKEN', 'test-verify');
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN_PRIMARY', 'test-token');
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN_OTHER', '');
    const cfg = { channels: { instagram: { enabled: true, defaultAccount: 'primary', accounts: {
      primary: { igUserId: '123', dmPolicy: 'allowlist', allowFrom: ['456'] },
      other: { igUserId: '789', dmPolicy: 'allowlist', allowFrom: ['456'] },
    } } } };
    const { plugin } = setup;
    expect(plugin.meta.id).toBe(plugin.id);
    expect(plugin.config.listAccountIds(cfg)).toEqual(['primary', 'other']);
    expect(plugin.config.defaultAccountId(cfg)).toBe('primary');
    const primary = plugin.config.resolveAccount(cfg, 'primary');
    expect(primary).toMatchObject({ accountId: 'primary', enabled: true, configured: true });
    expect(plugin.config.isConfigured(primary)).toBe(true);
    expect(plugin.config.resolveAccount(cfg, 'other')).toMatchObject({
      configured: false, hint: 'Set INSTAGRAM_ACCESS_TOKEN_OTHER',
    });
    expect(JSON.stringify(primary)).not.toContain('test-token');
    cfg.channels.instagram.enabled = false;
    expect(plugin.config.isEnabled(plugin.config.resolveAccount(cfg, 'primary'))).toBe(false);
  });
});
