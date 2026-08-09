const INSTAGRAM_GRAPH_ORIGIN = 'https://graph.instagram.com';
const INSTAGRAM_GRAPH_API_VERSION = 'v25.0';
const PROFILE_REQUEST_TIMEOUT_MS = 2_000;

export interface InstagramUserProfile {
  username: string;
}

export interface InstagramUserProfileRequest {
  url: string;
  init: RequestInit;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function buildInstagramUserProfileRequest(params: {
  senderId: string;
  accessToken: string;
  signal?: AbortSignal;
}): InstagramUserProfileRequest {
  const url = new URL(
    `${INSTAGRAM_GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_API_VERSION}/${encodeURIComponent(params.senderId)}`,
  );
  url.searchParams.set('fields', 'username');
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: { authorization: `Bearer ${params.accessToken}` },
      ...(params.signal ? { signal: params.signal } : {}),
    },
  };
}

/**
 * Resolves the handle that Meta permits an app to read after the user has sent
 * the professional account a DM. Callers must treat failure as non-fatal.
 */
export async function lookupInstagramUserProfile(params: {
  senderId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InstagramUserProfile | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? PROFILE_REQUEST_TIMEOUT_MS);
  try {
    const request = buildInstagramUserProfileRequest({
      senderId: params.senderId,
      accessToken: params.accessToken,
      signal: controller.signal,
    });
    const response = await (params.fetchImpl || fetch)(request.url, request.init);
    const body = parseJson(await response.text()) as { username?: unknown };
    if (!response.ok) {
      throw new Error(`Instagram profile lookup failed (HTTP ${response.status})`);
    }
    const username = nonBlankString(body.username)?.replace(/^@+/, '');
    return username ? { username } : null;
  } finally {
    clearTimeout(timeout);
  }
}
