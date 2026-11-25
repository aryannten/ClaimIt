import js from '@eslint/js';

const baseRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-shadow': 'error',
  'no-console': 'warn',
  'no-promise-executor-return': 'error',
  'no-unreachable-loop': 'error',
  'no-template-curly-in-string': 'warn'
};

export default [
  {
    ignores: ['node_modules/**', 'assets/**', 'config/**']
  },
  {
    files: ['src/**/*.js'],
    ignores: ['src/content/**', 'src/popup/**', 'src/options/**', 'src/ui/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        navigator: 'readonly',
        URL: 'readonly',
        Intl: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        btoa: 'readonly'
      }
    },
    rules: baseRules
  },
  {
    files: ['src/providers/tab-helpers.js'],
    languageOptions: {
      globals: {
        window: 'readonly'
      }
    }
  },
  {
    files: ['src/content/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        Event: 'readonly',
        MutationObserver: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: baseRules
  },
  {
    files: ['src/popup/**/*.js', 'src/options/**/*.js', 'src/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        Option: 'readonly',
        Intl: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: baseRules
  },
  {
    files: ['src/background.js', 'src/scheduler.js'],
    rules: {
      'no-restricted-globals': ['error', 'setTimeout', 'setInterval'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='periodInMinutes']",
          message: 'Use one-shot { when } alarms instead of periodInMinutes.'
        },
        {
          selector: "Identifier[name='setTimeout']",
          message: 'Do not use setTimeout in service worker scheduling.'
        },
        {
          selector: "Identifier[name='setInterval']",
          message: 'Do not use setInterval in service worker scheduling.'
        }
      ]
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: baseRules
  }
];
