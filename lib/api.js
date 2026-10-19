// Client for the OAuth endpoints used by Claude Code: usage (session/weekly
// limits), account profile and access token renewal.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {readCredentials, writeCredentials} from './accounts.js';
import {_} from './i18n.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const API_BASE = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
// Renew a bit before expiry so a request doesn't fail halfway.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ApiError extends Error {
    constructor(message, {status = 0, needsLogin = false, retryAfter = 0} = {}) {
        super(message);
        this.status = status;
        this.needsLogin = needsLogin;
        this.retryAfter = retryAfter;
    }
}

export class ClaudeApi {
    constructor() {
        this._session = new Soup.Session({
            user_agent: 'claude-juggler-gnome/0.1',
            timeout: 30,
        });
        // Avoid two concurrent renewals of the same account (refresh tokens rotate).
        this._refreshing = new Map();
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    async _request(method, url, {token, body, cancellable} = {}) {
        const msg = Soup.Message.new(method, url);
        const headers = msg.get_request_headers();
        headers.append('Accept', 'application/json');
        if (token) {
            headers.append('Authorization', `Bearer ${token}`);
            headers.append('anthropic-beta', OAUTH_BETA);
        }
        if (body) {
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }

        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable ?? null);
        // get_status() throws for codes outside the Soup.Status enum (e.g. 429).
        const status = msg.status_code;
        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            // non-JSON response (e.g. a proxy error page)
        }

        if (status < 200 || status >= 300) {
            const detail = json?.error?.message ?? json?.error_description ?? json?.error ?? msg.get_reason_phrase();
            const retryAfter = Number(msg.get_response_headers().get_one('retry-after')) || 0;
            throw new ApiError(`HTTP ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
                {status, retryAfter});
        }
        return json;
    }

    async _refresh(account, creds) {
        const oauth = creds.claudeAiOauth;
        if (!oauth.refreshToken)
            throw new ApiError(_('No refresh token'), {needsLogin: true});

        let data;
        try {
            data = await this._request('POST', TOKEN_URL, {
                body: {
                    grant_type: 'refresh_token',
                    refresh_token: oauth.refreshToken,
                    client_id: CLIENT_ID,
                    scope: (oauth.scopes ?? []).join(' '),
                },
            });
        } catch (e) {
            // The CLI may have renewed and rotated the token meanwhile.
            const latest = readCredentials(account);
            if (latest && latest.claudeAiOauth.refreshToken !== oauth.refreshToken)
                return latest;
            if (e.status === 400 || e.status === 401)
                throw new ApiError(_('Session expired — please log in again'), {status: e.status, needsLogin: true});
            throw e;
        }

        const updated = {
            ...creds,
            claudeAiOauth: {
                ...oauth,
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? oauth.refreshToken,
                expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
                ...(data.scope ? {scopes: data.scope.split(' ')} : {}),
                ...(data.refresh_token_expires_in
                    ? {refreshTokenExpiresAt: Date.now() + data.refresh_token_expires_in * 1000} : {}),
            },
        };
        writeCredentials(account, updated);
        return updated;
    }

    async _ensureFresh(account, {force = false} = {}) {
        const creds = readCredentials(account);
        if (!creds)
            throw new ApiError(_('Login pending'), {needsLogin: true});
        if (!force && creds.claudeAiOauth.expiresAt - REFRESH_MARGIN_MS > Date.now())
            return creds.claudeAiOauth.accessToken;
        // Account linked to another app's folder: the owner renews it, otherwise
        // rotating the refresh token would log the other app out.
        if (account.readOnly) {
            if (!force && creds.claudeAiOauth.expiresAt > Date.now())
                return creds.claudeAiOauth.accessToken;
            throw new ApiError(_('Token expired — open Claude with this account to renew it'), {needsLogin: true});
        }

        let pending = this._refreshing.get(account.id);
        if (!pending) {
            pending = this._refresh(account, creds).finally(() => this._refreshing.delete(account.id));
            this._refreshing.set(account.id, pending);
        }
        return (await pending).claudeAiOauth.accessToken;
    }

    async _authed(account, path, cancellable) {
        let token = await this._ensureFresh(account);
        try {
            return await this._request('GET', `${API_BASE}${path}`, {token, cancellable});
        } catch (e) {
            if (e.status !== 401)
                throw e;
            token = await this._ensureFresh(account, {force: true});
            return this._request('GET', `${API_BASE}${path}`, {token, cancellable});
        }
    }

    fetchUsage(account, cancellable) {
        return this._authed(account, '/api/oauth/usage', cancellable);
    }

    fetchProfile(account, cancellable) {
        return this._authed(account, '/api/oauth/profile', cancellable);
    }
}

// Normalizes the /api/oauth/usage response into what the UI needs.
export function parseUsage(raw) {
    const window = w => w && typeof w.utilization === 'number'
        ? {used: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null}
        : null;

    // Per-model weekly limits (e.g. Fable) come in `limits` with
    // kind "weekly_scoped"; the seven_day_opus/sonnet fields are the old format.
    const extras = [];
    for (const limit of Array.isArray(raw?.limits) ? raw.limits : []) {
        if (limit.kind !== 'weekly_scoped' || typeof limit.percent !== 'number')
            continue;
        const name = limit.scope?.model?.display_name ?? limit.scope?.surface?.display_name ?? limit.scope?.surface;
        extras.push({
            label: typeof name === 'string' ? name : _('model'),
            used: limit.percent,
            resetsAt: limit.resets_at ? Date.parse(limit.resets_at) : null,
        });
    }
    if (!extras.length) {
        for (const [key, label] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
            const w = window(raw?.[key]);
            if (w)
                extras.push({label, ...w});
        }
    }

    return {
        session: window(raw?.five_hour),
        weekly: window(raw?.seven_day),
        extras,
        fetchedAt: Date.now(),
    };
}
