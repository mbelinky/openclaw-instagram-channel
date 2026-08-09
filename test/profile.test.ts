import { describe, expect, it, vi } from 'vitest';
import {
  buildInstagramUserProfileRequest,
  lookupInstagramUserProfile,
} from '../src/instagram/profile.js';

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('Instagram profile lookup', () => {
  it('asks Meta only for the permitted username field', () => {
    const request = buildInstagramUserProfileRequest({
      senderId: '123456789',
      accessToken: 'secret-token',
    });
    expect(request.url).toBe('https://graph.instagram.com/v25.0/123456789?fields=username');
    expect(request.init).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer secret-token' },
    });
  });

  it('returns a bare username and normalizes a display marker', async () => {
    const fetchImpl = vi.fn(async () => response(200, { username: '@example' }));
    await expect(lookupInstagramUserProfile({
      senderId: '123456789',
      accessToken: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual({ username: 'example' });
  });

  it('does not convert unavailable or malformed profiles into invented names', async () => {
    await expect(lookupInstagramUserProfile({
      senderId: '123456789',
      accessToken: 'token',
      fetchImpl: (async () => response(200, {})) as typeof fetch,
    })).resolves.toBeNull();
    await expect(lookupInstagramUserProfile({
      senderId: '123456789',
      accessToken: 'token',
      fetchImpl: (async () => response(403, { error: { message: 'denied' } })) as typeof fetch,
    })).rejects.toThrow('Instagram profile lookup failed (HTTP 403)');
  });
});
