/**
 * OAuth2 authentication via chrome.identity.launchWebAuthFlow.
 *
 * Uses the authorization-code flow with token refresh:
 *   1. launchWebAuthFlow opens Google consent screen
 *   2. Auth code is exchanged for access + refresh tokens
 *   3. Tokens are stored in chrome.storage.local
 *   4. Access token is auto-refreshed when expired
 */

import { CLIENT_ID, CLIENT_SECRET, SCOPES, REDIRECT_URL } from './config.js';

let cachedToken = null;
let tokenExpiresAt = 0;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a valid access token. Returns null if not authenticated.
 * Automatically refreshes expired tokens.
 */
export async function getAccessToken() {
  // In-memory cache (avoids storage reads on every API call)
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const stored = await chrome.storage.local.get([
    'access_token',
    'refresh_token',
    'expires_at',
  ]);

  // Token still valid in storage
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 60_000) {
    cachedToken = stored.access_token;
    tokenExpiresAt = stored.expires_at;
    return cachedToken;
  }

  // Attempt refresh
  if (stored.refresh_token) {
    try {
      return await refreshAccessToken(stored.refresh_token);
    } catch (_) {
      return null;
    }
  }

  return null;
}

/**
 * Launch the interactive OAuth consent flow.
 * Returns the new access token on success.
 */
export async function authenticate() {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code received');
  }

  return exchangeCode(code);
}

/**
 * Revoke tokens and clear stored credentials.
 */
export async function signOut() {
  const stored = await chrome.storage.local.get(['access_token']);
  if (stored.access_token) {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${stored.access_token}`,
        { method: 'POST' },
      );
    } catch (_) {
      // Best-effort revocation
    }
  }

  await chrome.storage.local.remove(['access_token', 'refresh_token', 'expires_at']);
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Check if the user has a valid (or refreshable) session.
 */
export async function isAuthenticated() {
  const token = await getAccessToken();
  return !!token;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URL,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await res.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  await chrome.storage.local.set({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
  });

  cachedToken = tokens.access_token;
  tokenExpiresAt = expiresAt;

  return tokens.access_token;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    // Refresh token revoked or invalid — clear everything
    await chrome.storage.local.remove(['access_token', 'refresh_token', 'expires_at']);
    cachedToken = null;
    tokenExpiresAt = 0;
    throw new Error('Session expired. Please sign in again.');
  }

  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  await chrome.storage.local.set({
    access_token: data.access_token,
    expires_at: expiresAt,
  });

  cachedToken = data.access_token;
  tokenExpiresAt = expiresAt;

  return data.access_token;
}
