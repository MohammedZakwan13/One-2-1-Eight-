import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**', 'coverage/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // CMS-managed image URLs can point at any https CDN host, so next/image's remotePattern allow-list cannot be known
      // ahead of time. Assets are shipped pre-optimised (WebP) – see next.config.ts.
      '@next/next/no-img-element': 'off',
      // The client-approved storefront copy contains literal apostrophes in JSX text; they render correctly and must stay verbatim.
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The mock backend and tests may use looser patterns.
    files: ['mocks/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
