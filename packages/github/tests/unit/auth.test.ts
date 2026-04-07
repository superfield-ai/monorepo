import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pollGitHubAppAccessToken,
  requestGitHubAppDeviceCode,
} from '../../auth.ts';

describe('requestGitHubAppDeviceCode', () => {
  it('parses the GitHub device code response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      ),
    );

    const response = await requestGitHubAppDeviceCode('client-123', fetchImpl as typeof fetch);

    expect(response).toEqual({
      deviceCode: 'device-123',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });
});

describe('pollGitHubAppAccessToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling until the token is granted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('error=authorization_pending', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          'access_token=token-123&token_type=bearer&scope=repo&expires_in=3600',
          { status: 200 },
        ),
      );

    const promise = pollGitHubAppAccessToken('client-123', 'device-123', 1, fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const token = await promise;

    expect(token).toEqual({
      accessToken: 'token-123',
      tokenType: 'bearer',
      scope: 'repo',
      expiresIn: 3600,
      refreshToken: undefined,
      refreshTokenExpiresIn: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('accepts token responses without a scope field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('access_token=token-123&token_type=bearer', { status: 200 }),
    );

    const promise = pollGitHubAppAccessToken(
      'client-123',
      'device-123',
      1,
      fetchImpl as typeof fetch,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const token = await promise;

    expect(token).toEqual({
      accessToken: 'token-123',
      tokenType: 'bearer',
      scope: undefined,
      expiresIn: undefined,
      refreshToken: undefined,
      refreshTokenExpiresIn: undefined,
    });
  });

  it('throws on access denied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('error=access_denied', { status: 200 }));

    const errorPromise = pollGitHubAppAccessToken(
      'client-123',
      'device-123',
      1,
      fetchImpl as typeof fetch,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(errorPromise).resolves.toMatchObject({ name: 'access_denied' });
  });
});
