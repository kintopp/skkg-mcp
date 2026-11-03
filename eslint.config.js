// Flat ESLint config (ESLint 10). Dev-only, not part of the runtime or the .mcpb bundle.

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'research/', 'plans/', 'dist/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
