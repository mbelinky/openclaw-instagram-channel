import { describe, expect, it } from 'vitest';
import { buildInstagramDirectDmIdentity } from '../src/instagram/identity.js';

describe('Instagram direct-DM identity', () => {
  it('matches the Twilio direct-DM account, sender, recipient, and thread projection', () => {
    expect(buildInstagramDirectDmIdentity({
      accountId: 'studio',
      senderId: '123456789',
      recipientIgUserId: '17841400000000000',
      messageId: 'mid.abc',
    })).toEqual({
      accountId: 'studio',
      senderId: '123456789',
      threadId: '123456789',
      peer: { kind: 'direct', id: '123456789' },
      senderAddress: '123456789',
      recipientAddress: '17841400000000000',
      originatingTo: '123456789',
      messageId: 'mid.abc',
    });
  });
});
