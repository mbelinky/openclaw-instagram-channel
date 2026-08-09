export interface InstagramKeywordPrivateReplyCampaign {
  triggers: Record<string, string[]>;
  replies: Record<string, string>;
}

const PRIORITY_LOCALES = ['es', 'en', 'ca'] as const;

export type InstagramKeywordPrivateReplyMatch = {
  locale: string;
  reply: string;
};

function normalizeForKeywordMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeTrigger(normalizedText: string, trigger: string): boolean {
  const normalizedTrigger = normalizeForKeywordMatch(trigger).trim();
  if (!normalizedTrigger) return false;
  return new RegExp(`\\b${escapeRegExp(normalizedTrigger)}\\b`).test(normalizedText);
}

function prioritizedLocales(campaigns: InstagramKeywordPrivateReplyCampaign[]): string[] {
  const configured = [...new Set(campaigns.flatMap((campaign) => Object.keys(campaign.triggers)))];
  return [
    ...PRIORITY_LOCALES.filter((locale) => configured.includes(locale)),
    ...configured.filter((locale) => !PRIORITY_LOCALES.includes(locale as typeof PRIORITY_LOCALES[number])).sort(),
  ];
}

export function matchInstagramKeywordPrivateReply(
  campaigns: InstagramKeywordPrivateReplyCampaign[],
  text: string,
): InstagramKeywordPrivateReplyMatch | undefined {
  const normalizedText = normalizeForKeywordMatch(text);
  for (const locale of prioritizedLocales(campaigns)) {
    for (const campaign of campaigns) {
      if (campaign.triggers[locale]?.some((trigger) => containsWholeTrigger(normalizedText, trigger))) {
        return { locale, reply: campaign.replies[locale] };
      }
    }
  }
  return undefined;
}
