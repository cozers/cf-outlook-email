import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    alias: {
      // Workers-only module; aliased to a stub so the pure parsers in src/imap.ts
      // can be imported and unit-tested under vitest's Node environment.
      'cloudflare:sockets': new URL('./test/stubs/cloudflare-sockets.ts', import.meta.url).pathname,
    },
  },
});
