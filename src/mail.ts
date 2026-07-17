// Mail dispatcher: the single entry point the routes use for token acquisition
// and mail operations, hiding the Graph-vs-IMAP choice behind one normalised API.
//
// Why this layer exists: an account's refresh_token may be consented to Microsoft
// Graph OR only to the IMAP resource (purchased / "refreshed" tokens frequently are
// IMAP-only and can never mint a Graph token — they fail with AADSTS90023). This
// module probes / remembers which channel an account uses (accounts.mail_protocol)
// and routes list/detail/delete accordingly, returning one shape either way so the
// route handlers and frontend stay protocol-agnostic.

import type { AccountRow, MailProtocol } from './types';
import { run } from './db';
import { getAccessToken, getImapAccessToken } from './graph';
import {
  fetchEmails as graphFetchEmails,
  fetchEmailDetail as graphFetchDetail,
  deleteEmail as graphDeleteEmail,
} from './graph';
import {
  imapFetchList,
  imapFetchDetail,
  imapDelete,
  imapBatchDelete,
  type ImapMessageSummary,
  type ImapMessageDetail,
} from './imap';

// Normalised output shapes — identical to what the routes already emit to the
// frontend, so switching a route onto the dispatcher needs no frontend change.
export interface MailListItem {
  id: string; // Graph: opaque message id. IMAP: "imap:<folder>:<uid>".
  subject: string;
  from: { name: string; address: string };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface MailDetailItem extends MailListItem {
  toRecipients: { name: string; address: string }[];
  ccRecipients: { name: string; address: string }[];
  body: { contentType: string; content: string };
}

export type ResolvedProtocol = Exclude<MailProtocol, 'auto'>;

export interface ResolvedToken {
  protocol: ResolvedProtocol;
  token: string;
}

// Normalise a possibly-NULL column (older rows predate migration 0004).
function protocolOf(acc: AccountRow): MailProtocol {
  return (acc.mail_protocol as MailProtocol) || 'auto';
}

// Persist the outcome of a successful token acquisition: rotated refresh_token
// (when Microsoft issued one), the working scope, the resolved protocol, and mark
// the account active. Written in one UPDATE to minimise D1 round trips.
async function persistSuccess(
  db: D1Database,
  acc: AccountRow,
  protocol: ResolvedProtocol,
  newRefreshToken: string | undefined,
  scope: string | undefined
): Promise<void> {
  const refreshToken =
    newRefreshToken && newRefreshToken !== acc.refresh_token ? newRefreshToken : acc.refresh_token;
  await run(
    db,
    `UPDATE accounts SET refresh_token = ?, mail_protocol = ?, token_scope = ?,
     status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [refreshToken, protocol, scope ?? acc.token_scope ?? '', acc.id]
  );
}

async function markError(db: D1Database, accId: number): Promise<void> {
  await run(db, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    accId,
  ]);
}

// Acquire an access token for the account, resolving its protocol.
//   - 'graph' / 'imap': go straight to that channel.
//   - 'auto': try Graph first (the scope ladder cleanly fails IMAP-only tokens
//     with a scope error), then fall back to IMAP; remember whichever worked.
// Persists rotation/scope/protocol on success and marks the account 'error' when
// every channel fails, so callers only deal with the happy value.
export async function acquireToken(
  db: D1Database,
  acc: AccountRow
): Promise<{ resolved?: ResolvedToken; error?: string }> {
  const proto = protocolOf(acc);

  if (proto === 'graph') {
    const r = await getAccessToken(acc.client_id, acc.refresh_token, acc.token_scope || undefined);
    if (r.token) {
      await persistSuccess(db, acc, 'graph', r.newRefreshToken, r.scope);
      return { resolved: { protocol: 'graph', token: r.token } };
    }
    await markError(db, acc.id);
    return { error: r.error?.message ?? 'Graph token 获取失败' };
  }

  if (proto === 'imap') {
    const r = await getImapAccessToken(acc.client_id, acc.refresh_token);
    if (r.token) {
      await persistSuccess(db, acc, 'imap', r.newRefreshToken, r.scope);
      return { resolved: { protocol: 'imap', token: r.token } };
    }
    await markError(db, acc.id);
    return { error: r.error?.message ?? 'IMAP token 获取失败' };
  }

  // auto: probe Graph, then IMAP.
  const g = await getAccessToken(acc.client_id, acc.refresh_token, acc.token_scope || undefined);
  if (g.token) {
    await persistSuccess(db, acc, 'graph', g.newRefreshToken, g.scope);
    return { resolved: { protocol: 'graph', token: g.token } };
  }
  const im = await getImapAccessToken(acc.client_id, acc.refresh_token);
  if (im.token) {
    await persistSuccess(db, acc, 'imap', im.newRefreshToken, im.scope);
    return { resolved: { protocol: 'imap', token: im.token } };
  }

  await markError(db, acc.id);
  // Surface the Graph error (the primary channel) but note IMAP also failed.
  const gMsg = g.error?.message ?? 'Graph 失败';
  const iMsg = im.error?.message ?? 'IMAP 失败';
  return { error: `令牌获取失败（Graph: ${gMsg}；IMAP: ${iMsg}）` };
}

// --- id encoding for IMAP -------------------------------------------------

const IMAP_ID_PREFIX = 'imap:';

function encodeImapId(folder: string, uid: number): string {
  return `${IMAP_ID_PREFIX}${folder}:${uid}`;
}

// Parse "imap:<folder>:<uid>"; returns null for a Graph (opaque) id.
function decodeImapId(id: string): { folder: string; uid: number } | null {
  if (!id.startsWith(IMAP_ID_PREFIX)) return null;
  const rest = id.slice(IMAP_ID_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep < 0) return null;
  const folder = rest.slice(0, sep);
  const uid = parseInt(rest.slice(sep + 1), 10);
  if (!folder || Number.isNaN(uid)) return null;
  return { folder, uid };
}

// --- normalisers ----------------------------------------------------------

function imapSummaryToItem(m: ImapMessageSummary): MailListItem {
  return {
    id: encodeImapId(m.folder, m.uid),
    subject: m.subject,
    from: { name: m.fromName, address: m.fromAddress },
    receivedDateTime: m.date,
    bodyPreview: m.preview,
    isRead: m.seen,
    hasAttachments: m.hasAttachments,
  };
}

function imapDetailToItem(m: ImapMessageDetail): MailDetailItem {
  return {
    ...imapSummaryToItem(m),
    toRecipients: m.to,
    ccRecipients: m.cc,
    body: {
      contentType: m.bodyHtml ? 'html' : 'text',
      content: m.bodyHtml ?? m.bodyText ?? '',
    },
  };
}

// --- operations -----------------------------------------------------------

export async function listEmails(
  db: D1Database,
  acc: AccountRow,
  opts: { folder?: string; top?: number; skip?: number; keyword?: string }
): Promise<{ items?: MailListItem[]; error?: string }> {
  const t = await acquireToken(db, acc);
  if (!t.resolved) return { error: t.error };

  if (t.resolved.protocol === 'imap') {
    const r = await imapFetchList(acc.email, t.resolved.token, {
      folder: opts.folder,
      top: opts.top,
    });
    if (r.error) return { error: r.error.message };
    let items = (r.items ?? []).map(imapSummaryToItem);
    // IMAP has no server-side search here; filter client-side to honour keyword.
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      items = items.filter(
        (m) =>
          m.subject.toLowerCase().includes(kw) ||
          m.bodyPreview.toLowerCase().includes(kw) ||
          m.from.address.toLowerCase().includes(kw)
      );
    }
    return { items };
  }

  const r = await graphFetchEmails(t.resolved.token, opts);
  if (r.error) return { error: r.error.message };
  const items = (r.items ?? []).map((e) => ({
    id: e.id,
    subject: e.subject ?? '(无主题)',
    from: {
      name: e.from?.emailAddress?.name ?? '',
      address: e.from?.emailAddress?.address ?? '未知',
    },
    receivedDateTime: e.receivedDateTime,
    bodyPreview: e.bodyPreview ?? '',
    isRead: e.isRead,
    hasAttachments: e.hasAttachments,
  }));
  return { items };
}

export async function getEmailDetail(
  db: D1Database,
  acc: AccountRow,
  messageId: string
): Promise<{ item?: MailDetailItem; error?: string; code?: string }> {
  const t = await acquireToken(db, acc);
  if (!t.resolved) return { error: t.error };

  const imapId = decodeImapId(messageId);
  if (t.resolved.protocol === 'imap' || imapId) {
    if (!imapId) return { error: '邮件标识无效', code: 'NOT_FOUND' };
    const r = await imapFetchDetail(acc.email, t.resolved.token, imapId.folder, imapId.uid);
    if (r.error) return { error: r.error.message, code: r.error.code };
    return { item: imapDetailToItem(r.item!) };
  }

  const r = await graphFetchDetail(t.resolved.token, messageId);
  if (r.error) return { error: r.error.message, code: r.error.code };
  const e = r.item!;
  return {
    item: {
      id: e.id,
      subject: e.subject ?? '(无主题)',
      from: {
        name: e.from?.emailAddress?.name ?? '',
        address: e.from?.emailAddress?.address ?? '未知',
      },
      toRecipients: (e.toRecipients ?? []).map((x) => ({
        name: x.emailAddress?.name ?? '',
        address: x.emailAddress?.address ?? '',
      })),
      ccRecipients: (e.ccRecipients ?? []).map((x) => ({
        name: x.emailAddress?.name ?? '',
        address: x.emailAddress?.address ?? '',
      })),
      receivedDateTime: e.receivedDateTime,
      body: e.body ?? { contentType: 'text', content: e.bodyPreview ?? '' },
      bodyPreview: e.bodyPreview ?? '',
      isRead: e.isRead,
      hasAttachments: e.hasAttachments,
    },
  };
}

export async function deleteMessage(
  db: D1Database,
  acc: AccountRow,
  messageId: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  const t = await acquireToken(db, acc);
  if (!t.resolved) return { ok: false, error: t.error };

  const imapId = decodeImapId(messageId);
  if (t.resolved.protocol === 'imap' || imapId) {
    if (!imapId) return { ok: false, error: '邮件标识无效', code: 'NOT_FOUND' };
    const r = await imapDelete(acc.email, t.resolved.token, imapId.folder, imapId.uid);
    return { ok: r.ok, error: r.error?.message, code: r.error?.code };
  }

  const r = await graphDeleteEmail(t.resolved.token, messageId);
  return { ok: r.ok, error: r.error?.message, code: r.error?.code };
}

// Batch delete: acquire the token ONCE, then route to the right channel.
//   Graph: fan out the deletes in parallel under a single token (N+1 subrequests).
//   IMAP:  a single connection handles the whole set (one socket, not N) — see
//          imapBatchDelete — because Workers caps concurrent outbound sockets.
// Returns a per-id ok map plus a `forbidden` flag (Graph read-only accounts) so
// the route can build the same summary message as before.
export async function batchDelete(
  db: D1Database,
  acc: AccountRow,
  messageIds: string[]
): Promise<{ results: Map<string, boolean>; forbidden: boolean; error?: string }> {
  const results = new Map<string, boolean>();
  for (const id of messageIds) results.set(id, false);
  if (!messageIds.length) return { results, forbidden: false };

  const t = await acquireToken(db, acc);
  if (!t.resolved) return { results, forbidden: false, error: t.error };

  // Route by resolved protocol. A mixed id set can't happen (an account is one
  // protocol), but namespaced ids are the source of truth for folder/uid.
  if (t.resolved.protocol === 'imap') {
    const targets: { id: string; folder: string; uid: number }[] = [];
    for (const id of messageIds) {
      const dec = decodeImapId(id);
      if (dec) targets.push({ id, folder: dec.folder, uid: dec.uid });
      // ids that don't decode stay marked failed
    }
    const map = await imapBatchDelete(acc.email, t.resolved.token, targets);
    for (const [id, ok] of map) results.set(id, ok);
    return { results, forbidden: false };
  }

  // Graph: parallel deletes sharing the one token.
  const settled = await Promise.all(
    messageIds.map(async (id) => ({ id, r: await graphDeleteEmail(t.resolved!.token, id) }))
  );
  let forbidden = false;
  for (const { id, r } of settled) {
    results.set(id, r.ok);
    if (r.error?.code === 'FORBIDDEN') forbidden = true;
  }
  return { results, forbidden };
}
