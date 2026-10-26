import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      // `server-only` throws outside the Next.js server bundle; unit tests run in plain Node.
      'server-only': path.resolve(__dirname, 'tests/unit/helpers/empty.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    restoreMocks: true,
  },
});
