// Minimal IMAP-over-XOAUTH2 client for Cloudflare Workers.
//
// Why this exists: purchased / "refreshed" Outlook accounts are frequently
// consented ONLY to the IMAP resource (https://outlook.office.com/IMAP.AccessAsUser.All)
// and can never obtain a Microsoft Graph token. Graph-only tooling rejects them
// with AADSTS90023. To read those mailboxes we speak IMAP directly, authenticating
// with the OAuth2 access token via the XOAUTH2 SASL mechanism.
//
// Workers has no `net`/`tls` and no npm IMAP library works here, so this is a
// hand-rolled client on top of Cloudflare's `connect()` TCP+TLS socket. The wire
// protocol handling is deliberately small (LOGIN via XOAUTH2, SELECT, UID SEARCH,
// UID FETCH, UID STORE) and every non-IO concern (response tokenising, envelope /
// body-structure parsing, MIME decoding) is a pure function exported for unit tests.

import { connect } from 'cloudflare:sockets';
import type { GraphError } from './graph';
import {
  decodeImapUtf7,
  decodeMimeEncodedWord,
  decodeContentTransfer,
  parseFetchEnvelope,
  parseBodyStructure,
  pickTextPart,
  pickBodyPart,
  type ImapEnvelope,
  type ImapBodyPart,
} from './imapParse';

// Office 365 / Outlook IMAP endpoint. 993 = implicit TLS.
const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;

// A parsed message summary as surfaced to the mail dispatcher. Intentionally
// shaped to mirror what the Graph path produces after normalisation, so routes
// downstream don't care which channel produced it.
export interface ImapMessageSummary {
  uid: number;
  // The folder this message lives in. Set by imapFetchList so the dispatcher can
  // build a stable id (imap:<folder>:<uid>) that detail/delete can route back —
  // essential for the merged 'all' view where items come from different folders.
  folder: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  date: string; // ISO 8601
  preview: string;
  seen: boolean;
  hasAttachments: boolean;
}

export interface ImapMessageDetail extends ImapMessageSummary {
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  bodyHtml?: string;
  bodyText?: string;
}

// Folder name mapping. The app's folder vocabulary ('inbox' / 'junkemail') is the
// Graph well-known-folder set; IMAP uses different names. Outlook exposes Junk as
// "Junk" (some tenants "Junk Email"); we SELECT by the mapped name and fall back.
const FOLDER_MAP: Record<string, string[]> = {
  inbox: ['INBOX'],
  junkemail: ['Junk', 'Junk Email', 'Junk E-Mail'],
  deleteditems: ['Deleted', 'Deleted Items', 'Trash'],
};

function foldersFor(folder: string): string[] {
  return FOLDER_MAP[folder] ?? [folder];
}

// --- low-level connection ------------------------------------------------

// One IMAP conversation. Not reused across requests (Workers are short-lived and
// each fetch gets its own socket). All reads accumulate into a buffer that the
// tagged-command helper scans for the command's completion line.
class ImapConnection {
  private socket: ReturnType<typeof connect>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private buffer = '';
  private tagSeq = 0;
  private closed = false;

  constructor() {
    this.socket = connect(
      { hostname: IMAP_HOST, port: IMAP_PORT },
      { secureTransport: 'on', allowHalfOpen: false }
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  // Pull more bytes into the text buffer. Returns false on EOF.
  private async pump(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    if (value) this.buffer += this.decoder.decode(value, { stream: true });
    return true;
  }

  // Read the server greeting (untagged line ending in CRLF) after connect.
  async readGreeting(timeoutMs: number): Promise<void> {
    await this.withTimeout(async () => {
      while (!this.buffer.includes('\r\n')) {
        if (!(await this.pump())) throw new Error('connection closed before greeting');
      }
    }, timeoutMs, 'greeting');
  }

  private nextTag(): string {
    this.tagSeq += 1;
    return 'A' + this.tagSeq.toString().padStart(3, '0');
  }

  // Send a tagged command and read until its tagged completion line ("<tag> OK|NO|BAD ...").
  // Returns the full accumulated response text for that command (untagged lines + tagged line).
  async command(raw: string, timeoutMs: number): Promise<{ tag: string; text: string; status: string }> {
    const tag = this.nextTag();
    await this.writeLine(`${tag} ${raw}`);
    return this.collectUntilTag(tag, timeoutMs);
  }

  // Send a raw pre-tagged line (used for the XOAUTH2 continuation flow).
  async writeLine(line: string): Promise<void> {
    await this.writer.write(this.encoder.encode(line + '\r\n'));
  }

  // Read response lines until we see the completion line for `tag`. The regex is
  // anchored to line-start so message bodies that happen to contain "A001 OK" can't
  // spoof completion.
  async collectUntilTag(tag: string, timeoutMs: number): Promise<{ tag: string; text: string; status: string }> {
    const re = new RegExp(`^${tag} (OK|NO|BAD)\\b`, 'm');
    return this.withTimeout(async () => {
      // Keep reading until the tagged completion line appears in the buffer.
      for (;;) {
        const m = this.buffer.match(re);
        if (m) {
          const end = this.buffer.indexOf('\r\n', m.index!) + 2;
          const text = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end);
          return { tag, text, status: m[1] };
        }
        if (!(await this.pump())) throw new Error('connection closed mid-response');
      }
    }, timeoutMs, `command ${tag}`);
  }

  // Continuation-response read: server replies "+ ..." to ask for more input
  // (XOAUTH2). Resolve once a line starting with "+" or a tagged line is seen.
  async readContinuationOrTag(tag: string, timeoutMs: number): Promise<{ kind: 'cont' | 'tagged'; text: string; status?: string }> {
    const tagRe = new RegExp(`^${tag} (OK|NO|BAD)\\b`, 'm');
    return this.withTimeout(async () => {
      for (;;) {
        const tagged = this.buffer.match(tagRe);
        if (tagged) {
          const end = this.buffer.indexOf('\r\n', tagged.index!) + 2;
          const text = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end);
          return { kind: 'tagged' as const, text, status: tagged[1] };
        }
        const cont = this.buffer.match(/^\+.*\r\n/m);
        if (cont) {
          const text = cont[0];
          this.buffer = this.buffer.slice(cont.index! + text.length);
          return { kind: 'cont' as const, text };
        }
        if (!(await this.pump())) throw new Error('connection closed awaiting continuation');
      }
    }, timeoutMs, `auth ${tag}`);
  }

  private async withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`IMAP timeout during ${label}`)), ms);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writeLine(`${this.nextTag()} LOGOUT`);
    } catch {
      // best-effort; socket may already be gone
    }
    try {
      await this.writer.close();
    } catch { /* ignore */ }
    try {
      this.reader.releaseLock();
    } catch { /* ignore */ }
    try {
      await this.socket.close();
    } catch { /* ignore */ }
  }
}

// Build the XOAUTH2 SASL initial-response (base64 of the user+bearer blob).
export function buildXOAuth2(user: string, accessToken: string): string {
  const raw = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return btoa(raw);
}

const DEFAULT_TIMEOUT = 15000;

// Authenticate a fresh connection with XOAUTH2. Throws on auth failure with a
// message that distinguishes an expired/invalid token (so the caller can mark the
// account) from other protocol errors.
async function authenticate(conn: ImapConnection, email: string, accessToken: string): Promise<void> {
  const authArg = buildXOAuth2(email, accessToken);
  // Send AUTHENTICATE with the initial response inline (SASL-IR); Outlook supports it.
  await conn.writeLine(`X001 AUTHENTICATE XOAUTH2 ${authArg}`);
  const first = await conn.readContinuationOrTag('X001', DEFAULT_TIMEOUT);

  if (first.kind === 'tagged') {
    if (first.status === 'OK') return;
    throw new Error(saslError(first.text));
  }
  // Continuation: server wants the (base64) SASL error acknowledged with an empty line.
  await conn.writeLine('');
  const second = await conn.collectUntilTag('X001', DEFAULT_TIMEOUT);
  if (second.status === 'OK') return;
  throw new Error(saslError(second.text));
}

function saslError(text: string): string {
  // XOAUTH2 failures come back as a base64 JSON blob on the continuation line.
  const m = text.match(/^\+ (.+)\r\n/m);
  if (m) {
    try {
      const json = JSON.parse(atob(m[1].trim()));
      if (json.status) return `IMAP auth failed (status ${json.status})`;
    } catch { /* not base64 json */ }
  }
  if (/AUTHENTICATE failed|NO |BAD /i.test(text)) return 'IMAP authentication rejected (token invalid or IMAP disabled for this mailbox)';
  return 'IMAP authentication failed';
}

// SELECT a folder, trying the candidate names in order. Returns the selected name
// and EXISTS count, or throws if none of the candidates exist.
async function selectFolder(conn: ImapConnection, folder: string): Promise<{ name: string; exists: number }> {
  let lastErr = '';
  for (const name of foldersFor(folder)) {
    // Quote the mailbox name; IMAP mailbox names with spaces require quoting.
    const res = await conn.command(`SELECT "${name}"`, DEFAULT_TIMEOUT);
    if (res.status === 'OK') {
      const m = res.text.match(/\* (\d+) EXISTS/);
      return { name, exists: m ? parseInt(m[1], 10) : 0 };
    }
    lastErr = res.text;
  }
  throw new Error(`cannot select folder ${folder}: ${lastErr.slice(0, 120)}`);
}

// --- public operations ---------------------------------------------------

// Result envelope mirrors the Graph helpers: { items?, error? }.
export async function imapFetchList(
  email: string,
  accessToken: string,
  options: { folder?: string; top?: number } = {}
): Promise<{ items?: ImapMessageSummary[]; error?: GraphError }> {
  const folder = options.folder ?? 'inbox';
  const top = Math.min(options.top ?? 20, 50);

  // 'all' = inbox + junk merged, matching the Graph aggregated view.
  if (folder === 'all') {
    const [inbox, junk] = await Promise.all([
      imapFetchList(email, accessToken, { folder: 'inbox', top }),
      imapFetchList(email, accessToken, { folder: 'junkemail', top }),
    ]);
    if (inbox.error && junk.error) return { error: inbox.error };
    const merged = [...(inbox.items ?? []), ...(junk.items ?? [])]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, top);
    return { items: merged };
  }

  const conn = new ImapConnection();
  try {
    await conn.readGreeting(DEFAULT_TIMEOUT);
    await authenticate(conn, email, accessToken);
    const sel = await selectFolder(conn, folder);
    if (sel.exists === 0) return { items: [] };

    // Fetch the most recent `top` messages by sequence number. "N:*" gets the tail;
    // we ask for UID (stable id), FLAGS, ENVELOPE, BODYSTRUCTURE and a small text
    // preview. Using sequence range avoids a separate SEARCH round trip.
    const startSeq = Math.max(1, sel.exists - top + 1);
    const res = await conn.command(
      `FETCH ${startSeq}:${sel.exists} (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[TEXT]<0.512>)`,
      DEFAULT_TIMEOUT
    );
    if (res.status !== 'OK') return { error: { code: 'IMAP_ERROR', message: 'FETCH failed' } };

    const items = parseListResponse(res.text, folder);
    // Newest first.
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { items: items.slice(0, top) };
  } catch (e) {
    return { error: { code: 'IMAP_ERROR', message: e instanceof Error ? e.message : 'IMAP error' } };
  } finally {
    await conn.close();
  }
}

export async function imapFetchDetail(
  email: string,
  accessToken: string,
  folder: string,
  uid: number
): Promise<{ item?: ImapMessageDetail; error?: GraphError }> {
  const conn = new ImapConnection();
  try {
    await conn.readGreeting(DEFAULT_TIMEOUT);
    await authenticate(conn, email, accessToken);
    await selectFolder(conn, folder);

    // Two-step fetch — critical for staying under Workers' 10ms-CPU / memory budget:
    // step 1 pulls only the METADATA (FLAGS + ENVELOPE + BODYSTRUCTURE), which is tiny.
    // Fetching BODY.PEEK[] instead would drag down the ENTIRE message including every
    // attachment inline (base64), then force a full-message MIME parse — that routinely
    // blows the CPU limit and crashes the request (the "open email = blank/error" bug).
    const metaRes = await conn.command(
      `UID FETCH ${uid} (FLAGS ENVELOPE BODYSTRUCTURE)`,
      DEFAULT_TIMEOUT
    );
    if (metaRes.status !== 'OK') return { error: { code: 'IMAP_ERROR', message: 'FETCH failed' } };

    const metaBlock = firstFetchBlock(metaRes.text);
    if (!metaBlock) return { error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    const env = parseFetchEnvelope(metaBlock);
    if (!env) return { error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    const struct = parseBodyStructure(metaBlock);
    const seen = /\\Seen/.test(matchFlags(metaBlock));
    const hasAttachments = struct ? structHasAttachment(struct) : false;

    // Step 2: fetch ONLY the chosen text part (html preferred, else plain), never the
    // attachments. pickBodyPart returns its IMAP section number; a single-part message
    // has no number, so we fall back to BODY[TEXT] (still just the body, not attachments).
    let bodyHtml: string | undefined;
    let bodyText: string | undefined;
    if (struct) {
      const picked = pickBodyPart(struct);
      if (picked) {
        const section = picked.part ? `BODY.PEEK[${picked.part}]` : 'BODY.PEEK[TEXT]';
        const nameFor = picked.part ? `BODY[${picked.part}]` : 'BODY[TEXT]';
        // Cap the fetched slice so a pathologically large single text part still can't
        // blow the budget; 256 KB is far more than any real HTML mail body.
        const bodyRes = await conn.command(
          `UID FETCH ${uid} (${section}<0.262144>)`,
          DEFAULT_TIMEOUT
        );
        if (bodyRes.status === 'OK') {
          const bodyBlock = firstFetchBlock(bodyRes.text);
          const raw = bodyBlock ? extractNamedLiteral(bodyBlock, sectionMarker(nameFor)) : null;
          if (raw != null) {
            const decoded = decodeContentTransfer(raw, picked.encoding, picked.charset);
            if (picked.subtype === 'html') bodyHtml = decoded;
            else bodyText = decoded;
          }
        }
      }
    }

    const detail: ImapMessageDetail = {
      uid,
      folder,
      subject: env.subject || '(无主题)',
      fromName: env.from?.name ?? '',
      fromAddress: env.from?.address ?? '未知',
      date: env.date || '',
      preview: (bodyText || bodyHtml?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '').slice(0, 300),
      seen,
      hasAttachments,
      to: env.to ?? [],
      cc: env.cc ?? [],
      bodyHtml,
      bodyText,
    };
    return { item: detail };
  } catch (e) {
    return { error: { code: 'IMAP_ERROR', message: e instanceof Error ? e.message : 'IMAP error' } };
  } finally {
    await conn.close();
  }
}

// Build a regex matching a BODY[...] section marker in a FETCH response, escaping
// the brackets/dots so "BODY[1.2]" matches literally.
function sectionMarker(name: string): RegExp {
  return new RegExp(name.replace(/[.[\]]/g, (m) => '\\' + m));
}

// Delete = mark \Deleted then EXPUNGE. Outlook moves it to Deleted Items, matching
// the Graph soft-delete semantics the UI already assumes.
export async function imapDelete(
  email: string,
  accessToken: string,
  folder: string,
  uid: number
): Promise<{ ok: boolean; error?: GraphError }> {
  const conn = new ImapConnection();
  try {
    await conn.readGreeting(DEFAULT_TIMEOUT);
    await authenticate(conn, email, accessToken);
    await selectFolder(conn, folder);
    const store = await conn.command(`UID STORE ${uid} +FLAGS (\\Deleted)`, DEFAULT_TIMEOUT);
    if (store.status !== 'OK') return { ok: false, error: { code: 'IMAP_ERROR', message: '标记删除失败' } };
    await conn.command(`UID EXPUNGE ${uid}`, DEFAULT_TIMEOUT).catch(() => undefined);
    // Some servers reject UID EXPUNGE (needs UIDPLUS); fall back to plain EXPUNGE.
    await conn.command('EXPUNGE', DEFAULT_TIMEOUT).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'IMAP_ERROR', message: e instanceof Error ? e.message : 'IMAP error' } };
  } finally {
    await conn.close();
  }
}

// Batch delete over a SINGLE connection. Purchased/IMAP accounts can't open 30
// sockets (Workers caps concurrent connections), so the route's per-id fan-out
// would fail; this authenticates once, then SELECTs each folder in turn and
// marks+expunges all its UIDs. Returns per-uid ok flags keyed by the id string
// the caller passed, so it can tally exactly like the Graph path.
export async function imapBatchDelete(
  email: string,
  accessToken: string,
  targets: { id: string; folder: string; uid: number }[]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (const t of targets) result.set(t.id, false);
  if (!targets.length) return result;

  // Group by folder so we SELECT each mailbox once.
  const byFolder = new Map<string, { id: string; uid: number }[]>();
  for (const t of targets) {
    const list = byFolder.get(t.folder) ?? [];
    list.push({ id: t.id, uid: t.uid });
    byFolder.set(t.folder, list);
  }

  const conn = new ImapConnection();
  try {
    await conn.readGreeting(DEFAULT_TIMEOUT);
    await authenticate(conn, email, accessToken);
    for (const [folder, items] of byFolder) {
      try {
        await selectFolder(conn, folder);
      } catch {
        continue; // folder gone; leave these ids marked failed
      }
      // One UID STORE for the whole set (comma-separated UID list), then EXPUNGE once.
      const uidList = items.map((i) => i.uid).join(',');
      const store = await conn.command(`UID STORE ${uidList} +FLAGS (\\Deleted)`, DEFAULT_TIMEOUT);
      if (store.status !== 'OK') continue;
      await conn.command(`UID EXPUNGE ${uidList}`, DEFAULT_TIMEOUT).catch(() => undefined);
      await conn.command('EXPUNGE', DEFAULT_TIMEOUT).catch(() => undefined);
      for (const i of items) result.set(i.id, true);
    }
    return result;
  } catch {
    return result; // auth/connection failed: all remain false
  } finally {
    await conn.close();
  }
}

// Lightweight connectivity probe used by the auto-detect path: just auth + SELECT INBOX.
export async function imapProbe(email: string, accessToken: string): Promise<{ ok: boolean; error?: GraphError }> {
  const conn = new ImapConnection();
  try {
    await conn.readGreeting(DEFAULT_TIMEOUT);
    await authenticate(conn, email, accessToken);
    await selectFolder(conn, 'inbox');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'IMAP_ERROR', message: e instanceof Error ? e.message : 'IMAP error' } };
  } finally {
    await conn.close();
  }
}

// --- response assembly (pure over the raw FETCH text) --------------------

// Split one multi-message FETCH response into per-message blocks and parse each.
// `folder` is stamped onto every summary so the dispatcher can build routable ids.
export function parseListResponse(text: string, folder = 'inbox'): ImapMessageSummary[] {
  const blocks = splitFetchBlocks(text);
  const out: ImapMessageSummary[] = [];
  for (const b of blocks) {
    const uid = matchUid(b);
    const env = parseFetchEnvelope(b);
    if (uid == null || !env) continue;
    const struct = parseBodyStructure(b);
    const preview = buildPreview(b, struct);
    out.push({
      uid,
      folder,
      subject: env.subject || '(无主题)',
      fromName: env.from?.name ?? '',
      fromAddress: env.from?.address ?? '未知',
      date: env.date || '',
      preview,
      seen: /\\Seen/.test(matchFlags(b)),
      hasAttachments: struct ? structHasAttachment(struct) : false,
    });
  }
  return out;
}

export function parseDetailResponse(text: string, uid: number, folder = 'inbox'): ImapMessageDetail | null {
  const blocks = splitFetchBlocks(text);
  const block = blocks[0];
  if (!block) return null;
  const env = parseFetchEnvelope(block);
  if (!env) return null;
  const struct = parseBodyStructure(block);
  const raw = extractLiteralBody(block);
  const { html, textPlain } = raw ? extractBodies(raw) : { html: undefined, textPlain: undefined };
  return {
    uid,
    folder,
    subject: env.subject || '(无主题)',
    fromName: env.from?.name ?? '',
    fromAddress: env.from?.address ?? '未知',
    date: env.date || '',
    preview: (textPlain || '').slice(0, 300),
    seen: /\\Seen/.test(matchFlags(block)),
    hasAttachments: struct ? structHasAttachment(struct) : false,
    to: env.to ?? [],
    cc: env.cc ?? [],
    bodyHtml: html,
    bodyText: textPlain,
  };
}

// Break a FETCH response into blocks starting at each "* N FETCH (".
function splitFetchBlocks(text: string): string[] {
  const idxs: number[] = [];
  const re = /^\* \d+ FETCH \(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) idxs.push(m.index);
  return idxs.map((start, i) => text.slice(start, idxs[i + 1] ?? text.length));
}

// The first "* N FETCH (...)" block of a response, or null. Used by the two-step
// detail fetch where each command returns exactly one message's block.
export function firstFetchBlock(text: string): string | null {
  return splitFetchBlocks(text)[0] ?? null;
}

function matchUid(block: string): number | null {
  const m = block.match(/\bUID (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function matchFlags(block: string): string {
  const m = block.match(/FLAGS \(([^)]*)\)/);
  return m ? m[1] : '';
}

// A body preview for the list view: prefer the peeked <0.512> text slice if present,
// else fall back to empty. Decoded and stripped of tags/whitespace.
function buildPreview(block: string, struct: ImapBodyPart | null): string {
  const lit = extractNamedLiteral(block, /BODY\[TEXT\]<0>|BODY\[TEXT\]/);
  if (!lit) return '';
  let s = lit;
  if (struct) {
    const text = pickTextPart(struct);
    if (text) s = decodeContentTransfer(lit, text.encoding, text.charset);
  }
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Extract the {n}-literal that follows BODY[] in a detail FETCH.
function extractLiteralBody(block: string): string | null {
  return extractNamedLiteral(block, /BODY\[\]/);
}

// Generic: find `<marker> {<len>}\r\n<len bytes>` and return those bytes.
function extractNamedLiteral(block: string, marker: RegExp): string | null {
  const mk = block.match(marker);
  if (!mk) return null;
  const after = block.slice(mk.index! + mk[0].length);
  const lit = after.match(/(?:<\d+(?:\.\d+)?>)?\s*\{(\d+)\}\r\n/);
  if (!lit) {
    // Quoted-string form: BODY[TEXT] "..."
    const q = after.match(/^\s*"((?:[^"\\]|\\.)*)"/);
    return q ? q[1] : null;
  }
  const len = parseInt(lit[1], 10);
  const start = lit.index! + lit[0].length;
  return after.slice(start, start + len);
}

// From a full RFC822 message, pull out an HTML and/or plaintext body. Handles a
// single-part body and the common multipart/alternative + multipart/mixed cases.
export function extractBodies(raw: string): { html?: string; textPlain?: string } {
  const { headers, body } = splitHeaderBody(raw);
  // Keep the ORIGINAL-case header for extracting boundary/charset — MIME boundaries
  // are case-sensitive (RFC 2046), so lowercasing before pulling the boundary breaks
  // the split. Use a lowercased copy only for the type-prefix checks below.
  const ctypeRaw = headers['content-type'] || 'text/plain';
  const ctype = ctypeRaw.toLowerCase();

  if (ctype.startsWith('multipart/')) {
    const boundary = ctypeRaw.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary) {
      let html: string | undefined;
      let textPlain: string | undefined;
      for (const part of splitMultipart(body, boundary)) {
        const sub = extractBodies(part);
        if (sub.html && !html) html = sub.html;
        if (sub.textPlain && !textPlain) textPlain = sub.textPlain;
      }
      return { html, textPlain };
    }
  }

  const enc = headers['content-transfer-encoding'] || '';
  const charset = ctypeRaw.match(/charset="?([^";]+)"?/i)?.[1];
  const decoded = decodeContentTransfer(body, enc, charset);
  if (ctype.startsWith('text/html')) return { html: decoded };
  if (ctype.startsWith('text/plain')) return { textPlain: decoded };
  return {};
}

function splitHeaderBody(raw: string): { headers: Record<string, string>; body: string } {
  const idx = raw.indexOf('\r\n\r\n');
  const sep = idx >= 0 ? idx : raw.indexOf('\n\n');
  if (sep < 0) return { headers: {}, body: raw };
  const rawHeaders = raw.slice(0, sep);
  const body = raw.slice(sep + (raw[sep] === '\r' ? 4 : 2));
  const headers: Record<string, string> = {};
  // Unfold continuation lines (leading whitespace) then split on ':'.
  for (const line of rawHeaders.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  const segments = body.split(delim);
  for (const seg of segments) {
    const s = seg.replace(/^\r?\n/, '');
    if (!s || s.startsWith('--')) continue; // closing delimiter
    parts.push(s);
  }
  return parts;
}

// Does a parsed body structure contain a non-text attachment part?
function structHasAttachment(part: ImapBodyPart): boolean {
  if (part.children?.length) return part.children.some(structHasAttachment);
  const type = (part.type || '').toLowerCase();
  if (part.disposition === 'attachment') return true;
  return type !== 'text' && type !== 'multipart';
}

export { decodeImapUtf7, decodeMimeEncodedWord };
