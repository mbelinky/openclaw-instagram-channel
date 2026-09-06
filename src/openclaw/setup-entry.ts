import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import {
  accessTokenEnvVar,
  listInstagramAccountIds,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from './config.js';

function inspectAccount(cfg: any, requestedAccountId?: string) {
  const accountId = requestedAccountId || resolveDefaultInstagramAccountId(cfg);
  const account = resolveInstagramAccountConfig(cfg, accountId);
  const enabled = cfg?.channels?.instagram?.enabled === true && Boolean(account) && account?.enabled !== false;
  const tokenEnvVar = accessTokenEnvVar(accountId);
  const hasSharedSecrets = Boolean(process.env.INSTAGRAM_APP_SECRET && process.env.INSTAGRAM_VERIFY_TOKEN);
  const hint = !hasSharedSecrets
    ? 'Set INSTAGRAM_APP_SECRET and INSTAGRAM_VERIFY_TOKEN'
    : !account?.igUserId
      ? `Set channels.instagram.accounts.${accountId}.igUserId`
      : !process.env[tokenEnvVar]
        ? `Set ${tokenEnvVar}`
        : account.dmPolicy === 'allowlist' && !(account.allowFrom || []).length
          ? `Set channels.instagram.accounts.${accountId}.allowFrom or change dmPolicy to open`
          : undefined;
  return {
    accountId,
    name: account?.name || `Instagram (${accountId})`,
    enabled,
    configured: enabled && !hint,
    ...(hint ? { hint } : {}),
  };
}

export default defineSetupPluginEntry({
  id: 'instagram',
  meta: {
    id: 'instagram',
    label: 'Instagram DMs',
    selectionLabel: 'Instagram DMs (Instagram Login API)',
    docsPath: '/channels/instagram',
    blurb: 'Instagram professional-account direct messages.',
  },
  capabilities: { chatTypes: ['direct'] },
  config: {
    listAccountIds: listInstagramAccountIds,
    defaultAccountId: resolveDefaultInstagramAccountId,
    resolveAccount: inspectAccount,
    inspectAccount,
    isEnabled: (account: ReturnType<typeof inspectAccount>) => account.enabled,
    isConfigured: (account: ReturnType<typeof inspectAccount>) => account.configured,
  },
});
