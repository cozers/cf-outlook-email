import { describe, it, expect } from 'vitest';
import {
  tokenizeSExpr,
  parseFetchEnvelope,
  parseBodyStructure,
  pickTextPart,
  pickBodyPart,
  numberBodyParts,
  decodeContentTransfer,
  decodeMimeEncodedWord,
  decodeImapUtf7,
  quotedPrintableToBytes,
  base64ToBytes,
  rfc2822ToIso,
} from '../src/imapParse';
import {
  buildXOAuth2,
  parseListResponse,
  parseDetailResponse,
  extractBodies,
} from '../src/imap';

// --- S-expression tokeniser ------------------------------------------------

describe('tokenizeSExpr', () => {
  it('parses a flat list of atoms and quoted strings', () => {
    const [list] = tokenizeSExpr('("text" "html" NIL)');
    expect(list).toEqual(['text', 'html', null]);
  });

  it('parses nested lists', () => {
    const [list] = tokenizeSExpr('("a" ("b" "c") "d")');
    expect(list).toEqual(['a', ['b', 'c'], 'd']);
  });

  it('honours backslash escapes inside quoted strings', () => {
    const [list] = tokenizeSExpr('("he said \\"hi\\"" "a\\\\b")');
    expect(list).toEqual(['he said "hi"', 'a\\b']);
  });

  it('maps NIL to null but keeps the atom "NILes"', () => {
    const [list] = tokenizeSExpr('(NIL NILes)');
    expect(list).toEqual([null, 'NILes']);
  });
});

// --- ENVELOPE --------------------------------------------------------------

describe('parseFetchEnvelope', () => {
  it('extracts date, subject, from, to, cc', () => {
    const block =
      '* 1 FETCH (UID 42 ENVELOPE ("Tue, 15 Jul 2026 05:43:43 +0000" "Hello there" ' +
      '(("Alice Example" NIL "alice" "example.com")) ' + // from
      '(("Alice Example" NIL "alice" "example.com")) ' + // sender
      '(("Alice Example" NIL "alice" "example.com")) ' + // reply-to
      '(("Bob" NIL "bob" "test.org")) ' + // to
      '(("Carol" NIL "carol" "cc.net")) ' + // cc
      'NIL NIL NIL "<msgid@example.com>"))';
    const env = parseFetchEnvelope(block);
    expect(env).not.toBeNull();
    expect(env!.subject).toBe('Hello there');
    expect(env!.from).toEqual({ name: 'Alice Example', address: 'alice@example.com' });
    expect(env!.to).toEqual([{ name: 'Bob', address: 'bob@test.org' }]);
    expect(env!.cc).toEqual([{ name: 'Carol', address: 'carol@cc.net' }]);
    expect(env!.date).toBe(new Date('Tue, 15 Jul 2026 05:43:43 +0000').toISOString());
  });

  it('decodes an RFC2047 encoded-word subject', () => {
    const block =
      '* 1 FETCH (ENVELOPE ("Tue, 15 Jul 2026 05:43:43 +0000" ' +
      '"=?utf-8?B?5L2g5aW9?=" ' + // "你好" in base64 utf-8
      '(("S" NIL "s" "x.com")) NIL NIL NIL NIL NIL NIL "<id>"))';
    const env = parseFetchEnvelope(block);
    expect(env!.subject).toBe('你好');
  });

  it('returns null when there is no ENVELOPE', () => {
    expect(parseFetchEnvelope('* 1 FETCH (UID 5 FLAGS (\\Seen))')).toBeNull();
  });
});

// --- BODYSTRUCTURE ---------------------------------------------------------

describe('parseBodyStructure', () => {
  it('parses a single text/plain part with charset and encoding', () => {
    const block =
      '* 1 FETCH (BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 1234 20))';
    const struct = parseBodyStructure(block);
    expect(struct).toMatchObject({ type: 'text', subtype: 'plain', charset: 'utf-8', encoding: 'quoted-printable' });
  });

  it('parses multipart/alternative with two text children', () => {
    const block =
      '* 1 FETCH (BODYSTRUCTURE (' +
      '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 100 5) ' +
      '("text" "html" ("charset" "utf-8") NIL NIL "base64" 200 4) ' +
      '"alternative"))';
    const struct = parseBodyStructure(block);
    expect(struct!.type).toBe('multipart');
    expect(struct!.subtype).toBe('alternative');
    expect(struct!.children).toHaveLength(2);
    expect(struct!.children![0]).toMatchObject({ type: 'text', subtype: 'plain', encoding: '7bit' });
    expect(struct!.children![1]).toMatchObject({ type: 'text', subtype: 'html', encoding: 'base64' });
  });

  it('pickTextPart prefers text/plain in a multipart', () => {
    const block =
      '* 1 FETCH (BODYSTRUCTURE (' +
      '("text" "html" ("charset" "utf-8") NIL NIL "base64" 200 4) ' +
      '("text" "plain" ("charset" "iso-8859-1") NIL NIL "quoted-printable" 100 5) ' +
      '"alternative"))';
    const struct = parseBodyStructure(block)!;
    const picked = pickTextPart(struct);
    expect(picked).toEqual({ charset: 'iso-8859-1', encoding: 'quoted-printable' });
  });

  it('detects an attachment disposition', () => {
    const block =
      '* 1 FETCH (BODYSTRUCTURE (' +
      '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 100 5) ' +
      '("application" "pdf" ("name" "doc.pdf") NIL NIL "base64" 5000 NIL NIL ("attachment" ("filename" "doc.pdf"))) ' +
      '"mixed"))';
    const struct = parseBodyStructure(block)!;
    const pdf = struct.children!.find((c) => c.subtype === 'pdf')!;
    expect(pdf.disposition).toBe('attachment');
  });
});

// --- content-transfer decoding --------------------------------------------

describe('decodeContentTransfer', () => {
  it('decodes base64 utf-8', () => {
    const b64 = btoa(unescape(encodeURIComponent('你好 world')));
    expect(decodeContentTransfer(b64, 'base64', 'utf-8')).toBe('你好 world');
  });

  it('decodes quoted-printable with soft breaks', () => {
    const qp = 'Hello=20World=\r\n again =E2=9C=93';
    expect(decodeContentTransfer(qp, 'quoted-printable', 'utf-8')).toBe('Hello World again ✓');
  });

  it('passes 7bit text through unchanged', () => {
    expect(decodeContentTransfer('plain ascii', '7bit', 'utf-8')).toBe('plain ascii');
  });

  it('handles latin1 (iso-8859-1) for 8bit content', () => {
    // 0xE9 = é in latin1
    const raw = String.fromCharCode(0x63, 0x61, 0x66, 0xe9); // "café"
    expect(decodeContentTransfer(raw, '8bit', 'iso-8859-1')).toBe('café');
  });
});

describe('quotedPrintableToBytes / base64ToBytes', () => {
  it('quoted-printable decodes hex escapes', () => {
    expect(Array.from(quotedPrintableToBytes('=41=42=43'))).toEqual([65, 66, 67]);
  });
  it('base64 roundtrips bytes', () => {
    expect(Array.from(base64ToBytes(btoa('ABC')))).toEqual([65, 66, 67]);
  });
});

// --- MIME encoded-word -----------------------------------------------------

describe('decodeMimeEncodedWord', () => {
  it('decodes a B-encoded word', () => {
    expect(decodeMimeEncodedWord('=?utf-8?B?5L2g5aW9?=')).toBe('你好');
  });
  it('decodes a Q-encoded word with underscore-as-space', () => {
    expect(decodeMimeEncodedWord('=?utf-8?Q?Hello_World?=')).toBe('Hello World');
  });
  it('concatenates adjacent encoded words dropping interword whitespace', () => {
    const out = decodeMimeEncodedWord('=?utf-8?B?5L2g?= =?utf-8?B?5aW9?=');
    expect(out).toBe('你好');
  });
  it('leaves plain text untouched', () => {
    expect(decodeMimeEncodedWord('just plain')).toBe('just plain');
  });
});

// --- modified UTF-7 --------------------------------------------------------

describe('decodeImapUtf7', () => {
  it('leaves ASCII folder names unchanged', () => {
    expect(decodeImapUtf7('INBOX')).toBe('INBOX');
  });
  it('decodes &- to &', () => {
    expect(decodeImapUtf7('Foo &- Bar')).toBe('Foo & Bar');
  });
  it('decodes a modified-UTF7 run', () => {
    // "収" (U+53CE) => UTF-16BE 0x53 0xCE => modified-base64 "U84" => &U84-
    expect(decodeImapUtf7('&U84-')).toBe('収');
  });
});

// --- date ------------------------------------------------------------------

describe('rfc2822ToIso', () => {
  it('converts a valid RFC2822 date', () => {
    expect(rfc2822ToIso('Tue, 15 Jul 2026 05:43:43 +0000')).toBe('2026-07-15T05:43:43.000Z');
  });
  it('returns the raw string for an unparseable date', () => {
    expect(rfc2822ToIso('not a date')).toBe('not a date');
  });
  it('returns empty for empty', () => {
    expect(rfc2822ToIso('')).toBe('');
  });
});

// --- XOAUTH2 ---------------------------------------------------------------

describe('buildXOAuth2', () => {
  it('builds the SASL base64 blob in the expected layout', () => {
    const blob = buildXOAuth2('user@x.com', 'TOKEN123');
    const decoded = atob(blob);
    expect(decoded).toBe('user=user@x.com\x01auth=Bearer TOKEN123\x01\x01');
  });
});

// --- full FETCH assembly ---------------------------------------------------

describe('parseListResponse', () => {
  it('parses a two-message list response and stamps the folder', () => {
    const text =
      '* 1 FETCH (UID 10 FLAGS (\\Seen) ' +
      'ENVELOPE ("Tue, 15 Jul 2026 05:00:00 +0000" "First" (("A" NIL "a" "x.com")) NIL NIL NIL NIL NIL NIL "<1>") ' +
      'BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1))\r\n' +
      '* 2 FETCH (UID 11 FLAGS () ' +
      'ENVELOPE ("Tue, 15 Jul 2026 06:00:00 +0000" "Second" (("B" NIL "b" "y.com")) NIL NIL NIL NIL NIL NIL "<2>") ' +
      'BODYSTRUCTURE ("text" "html" ("charset" "utf-8") NIL NIL "7bit" 20 1))\r\n' +
      'A001 OK FETCH completed\r\n';
    const items = parseListResponse(text, 'junkemail');
    expect(items).toHaveLength(2);
    const byUid = Object.fromEntries(items.map((i) => [i.uid, i]));
    expect(byUid[10]).toMatchObject({ subject: 'First', fromAddress: 'a@x.com', seen: true, folder: 'junkemail' });
    expect(byUid[11]).toMatchObject({ subject: 'Second', fromAddress: 'b@y.com', seen: false, folder: 'junkemail' });
  });

  it('skips blocks with no UID or no envelope', () => {
    const text =
      '* 1 FETCH (FLAGS (\\Seen))\r\n' + // no UID, no ENVELOPE
      'A001 OK done\r\n';
    expect(parseListResponse(text)).toHaveLength(0);
  });
});

describe('parseDetailResponse + extractBodies', () => {
  it('parses a single-part text/plain body from a BODY[] literal', () => {
    const rfc822 =
      'Subject: Hi\r\n' +
      'Content-Type: text/plain; charset="utf-8"\r\n' +
      'Content-Transfer-Encoding: 7bit\r\n' +
      '\r\n' +
      'plain body line';
    const block =
      `* 1 FETCH (UID 77 FLAGS (\\Seen) ` +
      `ENVELOPE ("Tue, 15 Jul 2026 05:00:00 +0000" "Hi" (("A" NIL "a" "x.com")) NIL NIL (("B" NIL "b" "y.com")) NIL NIL NIL "<1>") ` +
      `BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 15 1) ` +
      `BODY[] {${rfc822.length}}\r\n${rfc822})\r\n` +
      `A001 OK done\r\n`;
    const detail = parseDetailResponse(block, 77, 'inbox')!;
    expect(detail).not.toBeNull();
    expect(detail.uid).toBe(77);
    expect(detail.folder).toBe('inbox');
    expect(detail.to).toEqual([{ name: 'B', address: 'b@y.com' }]);
    expect(detail.bodyText).toBe('plain body line');
  });

  it('extractBodies picks html and plain from multipart/alternative', () => {
    const boundary = 'BOUND123';
    const raw =
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="utf-8"\r\n\r\n` +
      `the plain part\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="utf-8"\r\n\r\n` +
      `<p>the html part</p>\r\n` +
      `--${boundary}--\r\n`;
    const { html, textPlain } = extractBodies(raw);
    expect(textPlain?.trim()).toBe('the plain part');
    expect(html?.trim()).toBe('<p>the html part</p>');
  });

  it('extractBodies decodes a base64 text/plain body', () => {
    const b64 = btoa('decoded content');
    const raw =
      'Content-Type: text/plain; charset="utf-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      b64;
    expect(extractBodies(raw).textPlain).toBe('decoded content');
  });
});

// --- body-part numbering & selection (the two-step detail fetch) -----------

describe('numberBodyParts', () => {
  it('leaves a single-part message root without a number', () => {
    // ("text" "plain" ...) — no children, so the root itself is the body.
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1))'
    )!;
    expect(struct.part).toBeUndefined();
    expect(struct.children).toBeUndefined();
  });

  it('numbers children of a multipart 1..N', () => {
    // multipart/alternative: (text/plain)(text/html)"alternative"
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE (' +
        '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1)' +
        '("text" "html" ("charset" "utf-8") NIL NIL "7bit" 20 1)' +
        '"alternative"))'
    )!;
    expect(struct.type).toBe('multipart');
    expect(struct.children?.[0].part).toBe('1');
    expect(struct.children?.[1].part).toBe('2');
  });

  it('prefixes nested multipart parts (1.1, 1.2)', () => {
    // multipart/mixed: [ multipart/alternative[ plain, html ], application/pdf ]
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE (' +
        '(' +
          '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1)' +
          '("text" "html" ("charset" "utf-8") NIL NIL "7bit" 20 1)' +
          '"alternative"' +
        ')' +
        '("application" "pdf" NIL NIL NIL "base64" 9000)' +
        '"mixed"))'
    )!;
    const alt = struct.children![0];
    expect(alt.part).toBe('1');
    expect(alt.children?.[0].part).toBe('1.1');
    expect(alt.children?.[1].part).toBe('1.2');
    expect(struct.children![1].part).toBe('2');
  });
});

describe('pickBodyPart', () => {
  it('returns undefined part for a single-part text message', () => {
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE ("text" "html" ("charset" "utf-8") NIL NIL "quoted-printable" 100 3))'
    )!;
    const picked = pickBodyPart(struct)!;
    expect(picked.part).toBeUndefined();
    expect(picked.subtype).toBe('html');
    expect(picked.encoding).toBe('quoted-printable');
  });

  it('prefers text/html over text/plain and returns its section number', () => {
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE (' +
        '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1)' +
        '("text" "html" ("charset" "utf-8") NIL NIL "7bit" 20 1)' +
        '"alternative"))'
    )!;
    const picked = pickBodyPart(struct)!;
    expect(picked.subtype).toBe('html');
    expect(picked.part).toBe('2');
  });

  it('skips an attachment part and picks the text body', () => {
    // multipart/mixed: text/plain + an attachment (application/pdf, disposition attachment)
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE (' +
        '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1)' +
        '("application" "pdf" NIL NIL NIL "base64" 9000 NIL ("attachment" ("filename" "a.pdf")))' +
        '"mixed"))'
    )!;
    const picked = pickBodyPart(struct)!;
    expect(picked.subtype).toBe('plain');
    expect(picked.part).toBe('1');
  });

  it('returns null when there is no usable text part', () => {
    const struct = parseBodyStructure(
      '* 1 FETCH (BODYSTRUCTURE ("image" "png" NIL NIL NIL "base64" 5000))'
    )!;
    expect(pickBodyPart(struct)).toBeNull();
  });
});
