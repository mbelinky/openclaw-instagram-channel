import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { accessTokenEnvVar, listInstagramAccountIds, resolveInstagramAccountConfig } from './config.js';

export default defineSetupPluginEntry({
  id: 'instagram',
  channel: {
    id: 'instagram',
    inspectAccount: ({ cfg }: { cfg: any }) => {
      const channel = cfg?.channels?.instagram;
      const enabled = channel?.enabled === true;
      const ids = listInstagramAccountIds(cfg);
      const missingAccount = ids.find((id) => !resolveInstagramAccountConfig(cfg, id)?.igUserId);
      const missingToken = ids.find((id) => !process.env[accessTokenEnvVar(id)]);
      const missingAllowlist = ids.find((id) => {
        const account = resolveInstagramAccountConfig(cfg, id);
        return account?.dmPolicy === 'allowlist' && !(account.allowFrom || []).length;
      });
      const hasSharedSecrets = Boolean(process.env.INSTAGRAM_APP_SECRET && process.env.INSTAGRAM_VERIFY_TOKEN);
      const configured = Boolean(
        enabled && hasSharedSecrets && ids.length > 0 && !missingAccount && !missingToken && !missingAllowlist,
      );
      const hint = !hasSharedSecrets
        ? 'Set INSTAGRAM_APP_SECRET and INSTAGRAM_VERIFY_TOKEN'
        : ids.length === 0
          ? 'Set channels.instagram.accounts.<accountId>.igUserId'
          : missingAccount
            ? `Set channels.instagram.accounts.${missingAccount}.igUserId`
            : missingToken
              ? `Set ${accessTokenEnvVar(missingToken)}`
              : missingAllowlist
                ? `Set channels.instagram.accounts.${missingAllowlist}.allowFrom or change dmPolicy to open`
                : undefined;
      return { enabled, configured, hint };
    },
  },
});
