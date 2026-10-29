import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', '.venv', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['test/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // The core must stay a pure library: no UI, no browser, no Node.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['react', 'react-*', 'three', 'three/*', 'fflate'], message: 'src/core must not depend on UI libraries.' },
          { group: ['node:*', 'fs', 'path', 'zlib', 'buffer'], message: 'src/core must not depend on Node.' },
          { group: ['**/ui/**', '../ui/*'], message: 'src/core must not import from src/ui.' },
        ],
      }],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'Buffer', 'process'],
    },
  },
);
