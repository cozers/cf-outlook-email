// Test stub for the `cloudflare:sockets` runtime module, which only exists inside
// the Workers runtime. The unit tests exercise the pure parsing/decoding functions
// in imap.ts / imapParse.ts and never call connect(), so a throwing stub is enough
// to let the module import under vitest's Node environment.
export function connect(): never {
  throw new Error('cloudflare:sockets connect() is not available in unit tests');
}
