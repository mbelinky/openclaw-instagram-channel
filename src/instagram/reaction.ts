const REACTION_CODEPOINTS_RE =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F]/gu;
const REACTION_REQUIRED_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

export function isReactionOnlyText(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 64 || !REACTION_REQUIRED_RE.test(value)) {
    return false;
  }
  return value.replace(REACTION_CODEPOINTS_RE, '').trim() === '';
}

const POSITIVE_PASSIVE_TOKEN_RE =
  /(?:\b(?:gracias|thanks|thank\s+you|gràcies|merci|amazing|beautiful|bravo|genial|preci[oa]s[oa]|fant[aá]stic[oa])\b|m['’]encanta|molt\s+b[ée]|❤️|😍|👏)/iu;
const AMBIGUOUS_OR_NEGATIVE_RE =
  /(?:\b(?:no|not|never|nunca|nothing|nada|hate|odio|bad|mal|horrible|terrible|problem|problema|queja|broken|roto|pero|però|but)\b)/iu;

export function isPositivePassiveComment(text: string): boolean {
  const value = text.trim();
  if (
    !value ||
    value.length > 500 ||
    /[?¿]/u.test(value) ||
    /(?:https?:\/\/|www\.)/iu.test(value)
  ) return false;
  if (isReactionOnlyText(value)) return true;
  return POSITIVE_PASSIVE_TOKEN_RE.test(value) && !AMBIGUOUS_OR_NEGATIVE_RE.test(value);
}
