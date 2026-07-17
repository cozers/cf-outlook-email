// Pure parsing/decoding helpers for the IMAP client. Kept free of any IO so they
// can be unit-tested directly (see test/imap.test.ts). Everything here operates on
// strings already read off the socket.

export interface ImapAddress {
  name: string;
  address: string;
}

export interface ImapEnvelope {
  date: string; // ISO 8601 (converted from RFC2822)
  subject: string;
  from?: ImapAddress;
  to?: ImapAddress[];
  cc?: ImapAddress[];
}

export interface ImapBodyPart {
  type: string; // e.g. "text"
  subtype: string; // e.g. "html"
  charset?: string;
  encoding?: string; // content-transfer-encoding
  disposition?: string; // "attachment" | "inline" | undefined
  children?: ImapBodyPart[]; // for multipart
  // IMAP body section number (RFC 3501), assigned by numberBodyParts for
  // multipart trees: "1", "2", "1.2", etc. Lets us FETCH just one part
  // (e.g. BODY.PEEK[1.2]) instead of the whole message. undefined on the root
  // of a single-part message (fetch its body via BODY[TEXT]).
  part?: string;
}

// --- IMAP quoted/atom string tokeniser ----------------------------------

// Tokenise an IMAP parenthesised list into a nested array of strings / arrays.
// Handles quoted strings (with \" and \\ escapes), NIL, atoms, and {n} literals
// are NOT expected here (ENVELOPE/BODYSTRUCTURE use quoted strings and NIL).
type SExpr = string | null | SExpr[];

export function tokenizeSExpr(input: string): SExpr[] {
  let i = 0;
  const n = input.length;

  function parseList(): SExpr[] {
    const out: SExpr[] = [];
    // assumes input[i] === '('
    i++; // skip '('
    while (i < n) {
      skipSpaces();
      if (i >= n) break;
      const ch = input[i];
      if (ch === ')') { i++; break; }
      if (ch === '(') { out.push(parseList()); continue; }
      out.push(parseAtomOrString());
    }
    return out;
  }

  function skipSpaces() {
    while (i < n && (input[i] === ' ' || input[i] === '\r' || input[i] === '\n')) i++;
  }

  function parseAtomOrString(): SExpr {
    const ch = input[i];
    if (ch === '"') return parseQuoted();
    // atom: read until space or paren
    let start = i;
    while (i < n && input[i] !== ' ' && input[i] !== '(' && input[i] !== ')' && input[i] !== '\r' && input[i] !== '\n') i++;
    const atom = input.slice(start, i);
    return atom === 'NIL' ? null : atom;
  }

  function parseQuoted(): string {
    i++; // skip opening quote
    let out = '';
    while (i < n) {
      const ch = input[i++];
      if (ch === '\\') { out += input[i++] ?? ''; continue; }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }

  const results: SExpr[] = [];
  while (i < n) {
    skipSpaces();
    if (i >= n) break;
    const ch = input[i];
    // Stray close paren at top level (e.g. the FETCH block's own ')'): skip it.
    // Without this the atom reader below would stall on ')' and spin forever.
    if (ch === ')') { i++; continue; }
    if (ch === '(') { results.push(parseList()); continue; }
    const before = i;
    results.push(parseAtomOrString());
    if (i === before) i++; // guarantee forward progress
  }
  return results;
}

// Return the substring of the first balanced parenthesised group starting at or
// after `from` (inclusive of the outer parens), honouring quoted strings so a ')'
// inside a quote doesn't close the group. Returns null if no balanced group.
// Used to isolate ENVELOPE / BODYSTRUCTURE lists from the rest of a FETCH block
// (which may carry a large, paren-laden RFC822 body we must not tokenise).
export function sliceBalanced(input: string, from: number): string | null {
  const open = input.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return input.slice(open, i + 1);
    }
  }
  return null;
}

// --- ENVELOPE ------------------------------------------------------------

// IMAP ENVELOPE structure (RFC 3501):
//   (date subject (from) (sender) (reply-to) (to) (cc) (bcc) in-reply-to message-id)
// Each address = (name adl mailbox host). We only need date/subject/from/to/cc.
export function parseFetchEnvelope(block: string): ImapEnvelope | null {
  const start = block.indexOf('ENVELOPE (');
  if (start < 0) return null;
  // Slice ONLY the balanced ENVELOPE group; the surrounding FETCH response has
  // trailing bytes (BODYSTRUCTURE, the raw body literal, the closing paren) that
  // must not reach the list tokeniser.
  const sub = sliceBalanced(block, start + 'ENVELOPE'.length);
  if (!sub) return null;
  const toks = tokenizeSExpr(sub);
  const env = toks[0];
  if (!Array.isArray(env)) return null;

  const date = typeof env[0] === 'string' ? env[0] : '';
  const subjectRaw = typeof env[1] === 'string' ? env[1] : '';
  const from = firstAddress(env[2]);
  const to = addressList(env[5]);
  const cc = addressList(env[6]);

  return {
    date: rfc2822ToIso(date),
    subject: decodeMimeEncodedWord(subjectRaw),
    from,
    to,
    cc,
  };
}

function firstAddress(node: SExpr): ImapAddress | undefined {
  const list = addressList(node);
  return list && list.length ? list[0] : undefined;
}

function addressList(node: SExpr): ImapAddress[] | undefined {
  if (!Array.isArray(node)) return undefined;
  const out: ImapAddress[] = [];
  for (const a of node) {
    if (!Array.isArray(a)) continue;
    // (name adl mailbox host)
    const name = typeof a[0] === 'string' ? decodeMimeEncodedWord(a[0]) : '';
    const mailbox = typeof a[2] === 'string' ? a[2] : '';
    const host = typeof a[3] === 'string' ? a[3] : '';
    const address = mailbox && host ? `${mailbox}@${host}` : mailbox || '';
    out.push({ name, address });
  }
  return out;
}

// --- BODYSTRUCTURE -------------------------------------------------------

// Parse a BODYSTRUCTURE into a tree. This handles the shapes we care about:
//   single part: ("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 1234 ...)
//   multipart:   (<part> <part> ... "alternative" ...)
export function parseBodyStructure(block: string): ImapBodyPart | null {
  const start = block.indexOf('BODYSTRUCTURE (');
  if (start < 0) return null;
  // Only the balanced BODYSTRUCTURE group — never the trailing FETCH bytes.
  const sub = sliceBalanced(block, start + 'BODYSTRUCTURE'.length);
  if (!sub) return null;
  const toks = tokenizeSExpr(sub);
  const node = toks[0];
  if (!Array.isArray(node)) return null;
  const tree = interpretStructNode(node);
  numberBodyParts(tree);
  return tree;
}

// Assign IMAP body section numbers (RFC 3501 §6.4.5) to a parsed structure tree.
// Children of a multipart are numbered 1..N; nested multiparts prefix the parent's
// number ("1.1", "1.2"). A single-part message's root gets no number (its body is
// fetched via BODY[TEXT]). This lets imapFetchDetail request only the text part
// (BODY.PEEK[<part>]) instead of the entire message with all attachments inline.
export function numberBodyParts(root: ImapBodyPart): void {
  function walk(part: ImapBodyPart, prefix: string): void {
    if (!part.children) return;
    part.children.forEach((child, idx) => {
      const num = prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`;
      child.part = num;
      walk(child, num);
    });
  }
  walk(root, '');
}

// Pick the best displayable body part and return its section number + metadata.
// Prefers text/html (rendered), then text/plain. Skips attachment-disposition
// parts. Returns null when the structure has no usable text part (rare). For a
// single-part text message, `part` is undefined (caller fetches BODY[TEXT]).
export function pickBodyPart(
  root: ImapBodyPart
): { part?: string; subtype: string; charset?: string; encoding?: string } | null {
  // Single-part message: the root itself is the body.
  if (!root.children) {
    if (root.type === 'text') {
      return { part: undefined, subtype: root.subtype, charset: root.charset, encoding: root.encoding };
    }
    return null;
  }

  let html: ImapBodyPart | undefined;
  let plain: ImapBodyPart | undefined;
  function scan(part: ImapBodyPart): void {
    if (part.children) { part.children.forEach(scan); return; }
    if (part.disposition === 'attachment') return;
    if (part.type !== 'text') return;
    if (part.subtype === 'html' && !html) html = part;
    else if (part.subtype === 'plain' && !plain) plain = part;
  }
  scan(root);

  const chosen = html ?? plain;
  if (!chosen) return null;
  return { part: chosen.part, subtype: chosen.subtype, charset: chosen.charset, encoding: chosen.encoding };
}

function interpretStructNode(node: SExpr[]): ImapBodyPart {
  // multipart: leading element is itself a list (a child part)
  if (Array.isArray(node[0])) {
    const children: ImapBodyPart[] = [];
    let i = 0;
    while (i < node.length && Array.isArray(node[i])) {
      children.push(interpretStructNode(node[i] as SExpr[]));
      i++;
    }
    const subtype = typeof node[i] === 'string' ? (node[i] as string) : 'mixed';
    return { type: 'multipart', subtype: subtype.toLowerCase(), children };
  }

  // single part: ("type" "subtype" (params) id desc encoding size ...)
  const type = (typeof node[0] === 'string' ? node[0] : 'application').toLowerCase();
  const subtype = (typeof node[1] === 'string' ? node[1] : 'octet-stream').toLowerCase();
  const params = Array.isArray(node[2]) ? node[2] : [];
  let charset: string | undefined;
  for (let j = 0; j + 1 < params.length; j += 2) {
    if (typeof params[j] === 'string' && (params[j] as string).toLowerCase() === 'charset') {
      charset = typeof params[j + 1] === 'string' ? (params[j + 1] as string) : undefined;
    }
  }
  const encoding = typeof node[5] === 'string' ? (node[5] as string).toLowerCase() : undefined;

  // Disposition, when present, is a later element: ("attachment" (...)) or ("inline" ...).
  let disposition: string | undefined;
  for (let k = 7; k < node.length; k++) {
    const el = node[k];
    if (Array.isArray(el) && typeof el[0] === 'string') {
      const d = (el[0] as string).toLowerCase();
      if (d === 'attachment' || d === 'inline') { disposition = d; break; }
    }
  }

  return { type, subtype, charset, encoding, disposition };
}

// Choose the best text part (prefer text/plain for previews) from a structure.
export function pickTextPart(part: ImapBodyPart): { charset?: string; encoding?: string } | null {
  if (part.type === 'text') return { charset: part.charset, encoding: part.encoding };
  if (part.children) {
    // prefer plain, then html
    const plain = part.children.find((c) => c.type === 'text' && c.subtype === 'plain');
    if (plain) return { charset: plain.charset, encoding: plain.encoding };
    for (const c of part.children) {
      const found = pickTextPart(c);
      if (found) return found;
    }
  }
  return null;
}

// --- content-transfer decoding ------------------------------------------

// Decode a body segment given its transfer encoding and charset. Supports
// base64 and quoted-printable; other encodings pass through. Charset handling
// covers utf-8 (default) and a best-effort latin1 fallback via TextDecoder.
export function decodeContentTransfer(data: string, encoding?: string, charset?: string): string {
  const enc = (encoding || '').toLowerCase();
  let bytes: Uint8Array | null = null;

  if (enc === 'base64') {
    bytes = base64ToBytes(data.replace(/\s+/g, ''));
  } else if (enc === 'quoted-printable') {
    bytes = quotedPrintableToBytes(data);
  }

  if (bytes) return decodeBytes(bytes, charset);
  // 7bit/8bit/binary/none: the string is already text; re-decode only if a
  // non-utf8 charset is declared and we can honour it.
  if (charset && !/utf-?8/i.test(charset)) {
    try {
      const raw = Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff);
      return decodeBytes(raw, charset);
    } catch { /* fall through */ }
  }
  return data;
}

function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = normaliseCharset(charset);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return bytesToBinaryString(bytes);
    }
  }
}

function normaliseCharset(charset?: string): string {
  if (!charset) return 'utf-8';
  const c = charset.toLowerCase();
  if (c === 'us-ascii' || c === 'ascii') return 'utf-8';
  return c;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function quotedPrintableToBytes(input: string): Uint8Array {
  // Remove soft line breaks (= at end of line), then decode =XX hex escapes.
  const cleaned = input.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

// --- MIME encoded-word (RFC 2047) ---------------------------------------

// Decode subject/name headers like =?utf-8?B?...?= or =?gbk?Q?...?=.
export function decodeMimeEncodedWord(input: string): string {
  if (!input || input.indexOf('=?') < 0) return input;
  // Encoded words separated only by whitespace should be concatenated with the
  // whitespace removed (RFC 2047 §6.2).
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*)(?==\?)?/g, (whole, charset, enc, text) => {
    return decodeOneWord(charset, enc, text);
  }).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    return decodeOneWord(charset, enc, text);
  });
}

function decodeOneWord(charset: string, enc: string, text: string): string {
  try {
    let bytes: Uint8Array;
    if (enc.toUpperCase() === 'B') {
      bytes = base64ToBytes(text);
    } else {
      // Q-encoding: '_' = space, =XX hex.
      bytes = quotedPrintableToBytes(text.replace(/_/g, ' '));
    }
    return new TextDecoder(normaliseCharset(charset)).decode(bytes);
  } catch {
    return text;
  }
}

// --- modified UTF-7 (IMAP mailbox names, RFC 3501 §5.1.3) ---------------

// Decode IMAP mailbox names which use a modified UTF-7 for non-ASCII. Most Outlook
// folders are ASCII so this is a safety net for localized folder names.
export function decodeImapUtf7(input: string): string {
  return input.replace(/&([^-]*)-/g, (_, b64) => {
    if (b64 === '') return '&';
    // modified base64 uses ',' instead of '/'
    const std = b64.replace(/,/g, '/');
    try {
      const bytes = base64ToBytes(padBase64(std));
      // UTF-16BE
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return out;
    } catch {
      return _;
    }
  });
}

function padBase64(s: string): string {
  const pad = s.length % 4;
  return pad ? s + '='.repeat(4 - pad) : s;
}

// --- date conversion -----------------------------------------------------

// Convert an RFC 2822 date (as ENVELOPE carries) to an ISO 8601 string. Falls
// back to the raw input if Date can't parse it, so ordering still works loosely.
export function rfc2822ToIso(date: string): string {
  if (!date) return '';
  const t = Date.parse(date);
  return Number.isNaN(t) ? date : new Date(t).toISOString();
}
