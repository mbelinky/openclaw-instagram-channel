export type InstagramEngagementLocale = 'es' | 'en' | 'ca';

export function normalizeInstagramEngagementLocale(
  locale?: string,
): InstagramEngagementLocale {
  const base = locale?.trim().toLowerCase().split(/[-_]/u)[0];
  return base === 'en' || base === 'ca' ? base : 'es';
}

const PRIVATE_REPLY_POINTERS: Record<InstagramEngagementLocale, string> = {
  es: 'Te escribimos por privado 🤖',
  en: 'We sent you a DM 🤖',
  ca: "T'hem escrit per privat 🤖",
};

const PUBLIC_THANKS: Record<InstagramEngagementLocale, string> = {
  es: '¡Gracias! 🤍🤖',
  en: 'Thank you! 🤍🤖',
  ca: 'Gràcies! 🤍🤖',
};

export function instagramPrivateReplyPointer(locale?: string): string {
  return PRIVATE_REPLY_POINTERS[normalizeInstagramEngagementLocale(locale)];
}

export function instagramPublicThanks(locale?: string): string {
  return PUBLIC_THANKS[normalizeInstagramEngagementLocale(locale)];
}
