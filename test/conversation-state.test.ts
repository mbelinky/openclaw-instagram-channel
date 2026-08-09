import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_SEND_TTL_MS,
  HUMAN_TAKEOVER_WINDOW_MS,
  openInstagramConversationStateStore,
} from '../src/instagram/conversation-state.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-conversation-state-'));
  tempDirs.push(value);
  return value;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Instagram conversation state', () => {
  it('claims each comment once in memory and across store reopen', () => {
    const dir = tempDir();
    const store = openInstagramConversationStateStore(dir);

    expect(store.claimComment('studio', 'raw-private-comment-id')).toBe(true);
    expect(store.claimComment('studio', 'raw-private-comment-id')).toBe(false);
    expect(store.claimComment('studio', 'comment-2')).toBe(true);
    expect(store.claimComment('other', 'raw-private-comment-id')).toBe(true);
    expect(fs.readdirSync(dir).join(' ')).not.toContain('raw-private-comment-id');

    const reopened = openInstagramConversationStateStore(dir);
    expect(reopened.claimComment('studio', 'raw-private-comment-id')).toBe(false);
  });

  it('claims each reaction message once in memory and across store reopen', () => {
    const dir = tempDir();
    const store = openInstagramConversationStateStore(dir);

    expect(store.claimReaction('studio', 'mid.shared')).toBe(true);
    expect(store.claimReaction('studio', 'mid.shared')).toBe(false);
    expect(store.claimReaction('studio', 'mid.other')).toBe(true);
    expect(store.claimReaction('other', 'mid.shared')).toBe(true);
    expect(fs.readdirSync(dir).join(' ')).not.toContain('mid.shared');

    const reopened = openInstagramConversationStateStore(dir);
    expect(reopened.claimReaction('studio', 'mid.shared')).toBe(false);
  });

  it('persists human takeover across store reopen and expires after 24 hours', () => {
    let now = 1_000;
    const dir = tempDir();
    openInstagramConversationStateStore(dir, { now: () => now })
      .recordHumanMessage('studio', 'peer-1', 'mid.human');

    const reopened = openInstagramConversationStateStore(dir, { now: () => now });
    expect(reopened.isHumanTakeoverActive('studio', 'peer-1')).toBe(true);
    expect(fs.readdirSync(dir).join(' ')).not.toContain('peer-1');

    now += HUMAN_TAKEOVER_WINDOW_MS + 1;
    expect(reopened.isHumanTakeoverActive('studio', 'peer-1')).toBe(false);
  });

  it('retains known automated receipts across duplicate webhook deliveries', () => {
    const store = openInstagramConversationStateStore(tempDir());
    store.recordAutomatedMessage('studio', 'mid.bot');

    expect(store.isAutomatedMessage('studio', 'mid.bot')).toBe(true);
    expect(store.isAutomatedMessage('studio', 'mid.bot')).toBe(true);
    expect(store.isHumanTakeoverActive('studio', 'peer-1')).toBe(false);
  });

  it('persists and expires content-correlated ambiguous-send state without exposing text', () => {
    let now = 1_000;
    const dir = tempDir();
    const store = openInstagramConversationStateStore(dir, { now: () => now });
    store.recordAmbiguousAutomatedText('studio', 'peer-1', 'private reply text');

    const reopened = openInstagramConversationStateStore(dir, { now: () => now });
    expect(fs.readdirSync(dir).join(' ')).not.toContain('private reply text');
    expect(reopened.isAmbiguousAutomatedText('studio', 'peer-1', 'different text')).toBe(false);
    expect(reopened.isAmbiguousAutomatedText('studio', 'peer-1', 'private reply text')).toBe(true);
    expect(reopened.isAmbiguousAutomatedText('studio', 'peer-1', 'private reply text')).toBe(true);

    now += AMBIGUOUS_SEND_TTL_MS + 1;
    expect(reopened.isAmbiguousAutomatedText('studio', 'peer-1', 'private reply text')).toBe(false);
  });

  it('deduplicates human webhooks and anchors takeover to the event time', () => {
    let now = 10 * HUMAN_TAKEOVER_WINDOW_MS;
    const store = openInstagramConversationStateStore(tempDir(), { now: () => now });
    const eventTime = now - 2 * 60 * 60 * 1000;

    expect(store.recordHumanMessage('studio', 'peer-1', 'mid.human', eventTime)).toBe(true);
    expect(store.recordHumanMessage('studio', 'peer-1', 'mid.human', eventTime)).toBe(false);

    now += HUMAN_TAKEOVER_WINDOW_MS - 2 * 60 * 60 * 1000 + 1;
    expect(store.isHumanTakeoverActive('studio', 'peer-1')).toBe(false);
  });

  it('does not extend takeover when a duplicate webhook has no timestamp', () => {
    let now = 1_000;
    const store = openInstagramConversationStateStore(tempDir(), { now: () => now });

    expect(store.recordHumanMessage('studio', 'peer-1', 'mid.human')).toBe(true);
    now += 12 * 60 * 60 * 1000;
    expect(store.recordHumanMessage('studio', 'peer-1', 'mid.human')).toBe(false);
    now += 12 * 60 * 60 * 1000 + 1;
    expect(store.isHumanTakeoverActive('studio', 'peer-1')).toBe(false);
  });
});
