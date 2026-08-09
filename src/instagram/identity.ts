export interface InstagramDirectDmIdentity {
  accountId: string;
  senderId: string;
  threadId: string;
  peer: { kind: 'direct'; id: string };
  senderAddress: string;
  recipientAddress: string;
  originatingTo: string;
  messageId: string;
}

/** Mirrors the direct-DM identity projection used by the Twilio WhatsApp channel. */
export function buildInstagramDirectDmIdentity(params: {
  accountId: string;
  senderId: string;
  recipientIgUserId: string;
  messageId: string;
}): InstagramDirectDmIdentity {
  return {
    accountId: params.accountId,
    senderId: params.senderId,
    threadId: params.senderId,
    peer: { kind: 'direct', id: params.senderId },
    senderAddress: params.senderId,
    recipientAddress: params.recipientIgUserId,
    originatingTo: params.senderId,
    messageId: params.messageId,
  };
}

