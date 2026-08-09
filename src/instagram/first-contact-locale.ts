let detectorPromise: Promise<typeof import('eld/small')> | undefined;

function loadDetector() {
  detectorPromise ??= import('eld/small');
  return detectorPromise;
}

export async function detectInstagramMessageLocale(text?: string): Promise<string | undefined> {
  const candidate = text?.trim();
  if (!candidate) return undefined;

  try {
    const { eld } = await loadDetector();
    const result = eld.detect(candidate);
    const locale = result.language.trim().toLowerCase();
    return locale && result.isReliable() ? locale : undefined;
  } catch {
    return undefined;
  }
}
