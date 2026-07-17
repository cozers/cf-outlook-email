import type { GraphTokenResponse, GraphMailMessage } from './types';
import { maskToken } from './utils/validation';

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphError {
  code: string;
  message: string;
}

// Graph scope ladder, tried in order until one yields a token.
//
// Why not `.default`? `.default` returns ONLY the permissions statically
// configured on the app registration and ignores incremental/dynamic consent.
// The Mozilla Thunderbird public client (the default client_id here) has NO
// static Graph permissions, so `.default` fails with AADSTS90023 even after a
// user grants Mail.ReadWrite at authorization time. Requesting the granular
// scope that was actually consented is what makes those tokens work.
//
// The ladder degrades gracefully: read-only accounts (only Mail.Read consented)
// fall through to the second rung; the final `.default` rung preserves the old
// behaviour for any account whose app registration DOES carry static perms.
export const GRAPH_SCOPE_LADDER = [
  'https://graph.microsoft.com/Mail.ReadWrite offline_access',
  'https://graph.microsoft.com/Mail.Read offline_access',
  'https://graph.microsoft.com/.default',
] as const;

// Put `preferred` (a scope string we already know works for this account) at the
// front so steady-state refreshes cost a single token request, then fall back to
// the rest of the ladder for the probe / recovery path.
function orderScopes(preferred?: string): string[] {
  const ladder = [...GRAPH_SCOPE_LADDER];
  if (!preferred) return ladder;
  const rest = ladder.filter((s) => s !== preferred);
  return [preferred, ...rest];
}

// A failure is "scope related" (worth trying a different scope) when Entra says
// the consented permissions don't match the request. A dead refresh_token
// (revoked/expired) fails identically for every scope, so we stop laddering to
// avoid burning subrequests — those AADSTS codes are matched here as terminal.
function isScopeRelatedError(err?: GraphError): boolean {
  if (!err) return false;
  const m = err.message || '';
  // Terminal: token itself is bad — no scope will help.
  if (/AADSTS(70000|700082|700084|50173|50076|50079|9002313)/.test(m)) return false;
  // Scope / consent mismatch — a different scope may succeed.
  return /AADSTS(90023|65001|70011|65004|500011)/.test(m) || /scope|consent|permission/i.test(m);
}

async function requestGraphToken(
  clientId: string,
  refreshToken: string,
  scope: string
): Promise<{ token?: string; newRefreshToken?: string; error?: GraphError }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, string>;
      return {
        error: {
          code: err.error || 'TOKEN_FAILED',
          message: err.error_description
            ? sanitizeErrorMessage(err.error_description)
            : `Token request failed with status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as GraphTokenResponse;
    return {
      token: data.access_token,
      newRefreshToken: data.refresh_token,
    };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error during token request: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Get a Graph access token from a refresh_token, walking the scope ladder.
// `preferredScope` (persisted per-account as token_scope) is tried first so the
// common case is a single request. Returns the scope that worked so the caller
// can persist it, plus a rotated refresh_token when Microsoft issues one.
export async function getAccessToken(
  clientId: string,
  refreshToken: string,
  preferredScope?: string
): Promise<{ token?: string; newRefreshToken?: string; scope?: string; error?: GraphError }> {
  const scopes = orderScopes(preferredScope);
  let lastError: GraphError | undefined;

  for (const scope of scopes) {
    const res = await requestGraphToken(clientId, refreshToken, scope);
    if (res.token) {
      return { token: res.token, newRefreshToken: res.newRefreshToken, scope };
    }
    lastError = res.error;
    // Stop early on network errors or a terminally-dead token — retrying other
    // scopes would only waste subrequests against the free-tier budget.
    if (res.error?.code === 'NETWORK_ERROR') break;
    if (!isScopeRelatedError(res.error)) break;
  }

  return { error: lastError ?? { code: 'TOKEN_FAILED', message: 'Token request failed' } };
}

// IMAP token endpoint + scope. IMAP-authorized (e.g. purchased) refresh_tokens
// consented to the outlook.office.com IMAP resource, NOT to Graph, so they can
// never mint a Graph token — they must go through this path and then XOAUTH2.
// Upstream (xiaozhi349/outlookEmail) uses the /consumers tenant here; personal
// Outlook accounts live in the consumers tenant, and /common can misroute them.
const IMAP_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const IMAP_TOKEN_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';

// Acquire an IMAP access token (for XOAUTH2) from a refresh_token.
// Mirrors getAccessToken's shape: returns a rotated refresh_token when Microsoft
// issues one, plus the scope that worked (always IMAP_TOKEN_SCOPE here) so the
// caller can persist it the same way as the Graph path.
export async function getImapAccessToken(
  clientId: string,
  refreshToken: string
): Promise<{ token?: string; newRefreshToken?: string; scope?: string; error?: GraphError }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: IMAP_TOKEN_SCOPE,
    });

    const res = await fetch(IMAP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, string>;
      return {
        error: {
          code: err.error || 'TOKEN_FAILED',
          message: err.error_description
            ? sanitizeErrorMessage(err.error_description)
            : `IMAP token request failed with status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as GraphTokenResponse;
    return {
      token: data.access_token,
      newRefreshToken: data.refresh_token,
      scope: IMAP_TOKEN_SCOPE,
    };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error during IMAP token request: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Fetch email list from inbox
export async function fetchEmails(
  accessToken: string,
  options: { folder?: string; top?: number; skip?: number; keyword?: string } = {}
): Promise<{ items?: GraphMailMessage[]; error?: GraphError }> {
  const { folder = 'inbox', top = 20, skip = 0, keyword } = options;

  // Aggregated view: merge inbox + junk, sorted by date desc. Single page (skip ignored)
  // to keep merged ordering correct; 2 subrequests stay within the free-tier budget.
  if (folder === 'all') {
    const [inbox, junk] = await Promise.all([
      fetchEmails(accessToken, { folder: 'inbox', top, skip: 0, keyword }),
      fetchEmails(accessToken, { folder: 'junkemail', top, skip: 0, keyword }),
    ]);
    // If both fail, surface the error; otherwise show whatever succeeded
    if (inbox.error && junk.error) return { error: inbox.error };
    const merged = [...(inbox.items ?? []), ...(junk.items ?? [])]
      .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
      .slice(0, top);
    return { items: merged };
  }

  let url = `${GRAPH_BASE}/me/mailFolders/${folder}/messages`;
  const params = new URLSearchParams({
    $top: String(top),
    $skip: String(skip),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments',
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Prefer: 'outlook.body-content-type="text"',
  };

  if (keyword) {
    params.set('$search', `"${keyword}"`);
    headers['ConsistencyLevel'] = 'eventual';
  }

  url += '?' + params.toString();

  try {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      return { error: { code: 'RATE_LIMITED', message: 'Graph API rate limited, please retry later' } };
    }

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        error: {
          code: 'GRAPH_ERROR',
          message: `Failed to fetch emails: ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as { value: GraphMailMessage[] };
    return { items: data.value || [] };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error fetching emails: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Fetch single email detail
export async function fetchEmailDetail(
  accessToken: string,
  messageId: string
): Promise<{ item?: GraphMailMessage; error?: GraphError }> {
  const url =
    `${GRAPH_BASE}/me/messages/${messageId}?` +
    new URLSearchParams({
      $select:
        'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isRead,hasAttachments',
    }).toString();

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="html"',
      },
    });

    if (res.status === 404) {
      return { error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    }

    if (!res.ok) {
      return {
        error: { code: 'GRAPH_ERROR', message: `Failed to fetch email detail: ${res.status}` },
      };
    }

    const data = (await res.json()) as GraphMailMessage;
    return { item: data };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Delete a message (Graph soft-deletes it to Deleted Items)
export async function deleteEmail(
  accessToken: string,
  messageId: string
): Promise<{ ok: boolean; error?: GraphError }> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 204 || res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    if (res.status === 403) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: '无删除权限：该账号是只读授权。请在「编辑账号 → 重新授权」重新授权以获取读写权限',
        },
      };
    }
    return { ok: false, error: { code: 'GRAPH_ERROR', message: `删除失败: ${res.status}` } };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'NETWORK_ERROR', message: `Network error: ${e instanceof Error ? e.message : 'unknown'}` },
    };
  }
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64, present when fetching a single fileAttachment
}

// List attachments metadata for a message
export async function listAttachments(
  accessToken: string,
  messageId: string
): Promise<{ items?: GraphAttachment[]; error?: GraphError }> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,size`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { error: { code: 'GRAPH_ERROR', message: `获取附件列表失败: ${res.status}` } };
    const data = (await res.json()) as { value: GraphAttachment[] };
    return { items: data.value ?? [] };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Fetch a single attachment (includes base64 contentBytes for fileAttachment)
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<{ attachment?: GraphAttachment; error?: GraphError }> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments/${attachmentId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return { error: { code: 'NOT_FOUND', message: '附件不存在' } };
    if (!res.ok) return { error: { code: 'GRAPH_ERROR', message: `获取附件失败: ${res.status}` } };
    const data = (await res.json()) as GraphAttachment;
    return { attachment: data };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Remove any token-like strings from error messages
function sanitizeErrorMessage(msg: string): string {
  // Redact anything that looks like a token (long base64/alphanumeric strings)
  return msg.replace(/[A-Za-z0-9_-]{40,}/g, (match) => maskToken(match));
}
