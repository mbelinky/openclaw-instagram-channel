import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  buildCanonicalSentMessageHookContext: vi.fn((params: any) => params),
  toPluginMessageSentEvent: vi.fn((canonical: any) => canonical),
  toPluginMessageContext: vi.fn((canonical: any) => canonical),
  fireAndForgetHook: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/plugin-runtime', () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock('openclaw/plugin-sdk/hook-runtime', () => ({
  buildCanonicalSentMessageHookContext: mocks.buildCanonicalSentMessageHookContext,
  toPluginMessageSentEvent: mocks.toPluginMessageSentEvent,
  toPluginMessageContext: mocks.toPluginMessageContext,
  fireAndForgetHook: mocks.fireAndForgetHook,
}));

import { emitInstagramMessageSentHook } from '../src/openclaw/sent-hook.js';

describe('Instagram message_sent hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a successful sent event with the canonical Instagram context', () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runMessageSent: vi.fn(),
    };
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);

    emitInstagramMessageSentHook({
      to: '123456789',
      content: 'Hello from OpenClaw',
      success: true,
      accountId: 'studio',
      messageId: 'mid.abc',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
      sentBy: 'human',
    });

    expect(hookRunner.hasHooks).toHaveBeenCalledWith('message_sent');
    expect(mocks.buildCanonicalSentMessageHookContext).toHaveBeenCalledWith({
      to: '123456789',
      content: 'Hello from OpenClaw',
      success: true,
      error: undefined,
      channelId: 'instagram',
      accountId: 'studio',
      conversationId: '123456789',
      messageId: 'mid.abc',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
      metadata: { sentBy: 'human' },
      isGroup: false,
    });
    expect(hookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    expect(hookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'instagram',
        to: '123456789',
        conversationId: '123456789',
        messageId: 'mid.abc',
        sessionKey: 'agent:example:instagram:studio:direct:123456789',
        success: true,
      }),
      expect.objectContaining({
        channelId: 'instagram',
        to: '123456789',
        conversationId: '123456789',
        sessionKey: 'agent:example:instagram:studio:direct:123456789',
      }),
    );
    expect(mocks.fireAndForgetHook).toHaveBeenCalledWith(
      expect.any(Promise),
      'instagram: message_sent plugin hook failed',
    );
  });

  it('emits a failed sent event with the error string', () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runMessageSent: vi.fn(),
    };
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);

    emitInstagramMessageSentHook({
      to: '123456789',
      content: 'Hello from OpenClaw',
      success: false,
      error: 'Error: Graph API rejected the send',
      accountId: 'studio',
      sessionKey: 'agent:example:instagram:studio:direct:123456789',
    });

    expect(mocks.buildCanonicalSentMessageHookContext).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        sessionKey: 'agent:example:instagram:studio:direct:123456789',
      }),
    );
    expect(hookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'instagram',
        to: '123456789',
        conversationId: '123456789',
        success: false,
        error: 'Error: Graph API rejected the send',
      }),
      expect.anything(),
    );
  });

  it('does nothing without a registered message_sent hook runner', () => {
    const hookRunner = {
      hasHooks: vi.fn(() => false),
      runMessageSent: vi.fn(),
    };
    mocks.getGlobalHookRunner.mockReturnValueOnce(hookRunner).mockReturnValueOnce(undefined);

    emitInstagramMessageSentHook({ to: '123', success: true, accountId: 'studio' });
    emitInstagramMessageSentHook({ to: '456', success: true, accountId: 'studio' });

    expect(hookRunner.runMessageSent).not.toHaveBeenCalled();
    expect(mocks.buildCanonicalSentMessageHookContext).not.toHaveBeenCalled();
    expect(mocks.fireAndForgetHook).not.toHaveBeenCalled();
  });

  it('never throws when the hook runner throws', () => {
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn(() => true),
      runMessageSent: vi.fn(() => {
        throw new Error('hook failure');
      }),
    });

    expect(() => emitInstagramMessageSentHook({
      to: '123456789',
      content: 'Hello from OpenClaw',
      success: true,
      accountId: 'studio',
      messageId: 'mid.abc',
    })).not.toThrow();
  });
});
