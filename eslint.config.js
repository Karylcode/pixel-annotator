/* ESLint 9 flat config — only no-undef. Runtime remains zero-dependency. */
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'js/vendor/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { PA: 'writable' },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['js/**/*.js'],
    ignores: ['js/pixelate-worker.js'],
    languageOptions: {
      globals: { ...globals.browser, PA: 'writable' },
    },
  },
  {
    files: ['js/pixelate-worker.js'],
    languageOptions: {
      globals: { ...globals.worker, PA: 'writable' },
    },
  },
  {
    files: ['tools/**/*.js', 'tests/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      globals: { ...globals.node, PA: 'writable' },
    },
  },
  {
    files: ['tools/check.js'],
    languageOptions: {
      globals: {
        window: 'writable',
        document: 'writable',
        localStorage: 'writable',
        indexedDB: 'writable',
        ImageData: 'writable',
      },
    },
  },
];
