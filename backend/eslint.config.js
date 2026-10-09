import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const IO_MODULES = [
  '**/db/**',
  '**/plugins/**',
  '**/routes/**',
  '**/storage/**',
  '**/jobs/**',
  '**/security/**',
  '**/audit/**',
  '**/documents/**',
  '**/app.js',
  '**/context.js',
  'fastify',
  'fastify-*',
  '@fastify/*',
  'pg',
  '@aws-sdk/*',
  '@electric-sql/*',
  'node:fs',
  'node:fs/*',
  'node:net',
  'node:http',
  'node:https',
  'node:child_process',
  'node:dns',
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'load'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use Decimal for money (BACKEND.md §16).' },
      ],
    },
  },

  // domain/ və accounting/: IO-suz (BACKEND.md §3 "Qayda")
  {
    files: ['src/domain/**/*.ts', 'src/accounting/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: IO_MODULES,
              message: 'domain/ and accounting/ must stay free of IO (BACKEND.md §3).',
            },
          ],
        },
      ],
    },
  },

  // accounting/: saf deterministik mühərrik — float yox, saat yox, Node yox (BACKEND.md §6.1, §16)
  {
    files: ['src/accounting/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...IO_MODULES, 'node:*', '**/domain/**'],
              message:
                'accounting/ is a pure engine: no IO, no Node built-ins, no other app modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money must never go through floating point — use Decimal.',
        },
        { name: 'parseInt', message: 'Use Decimal/BigInt, not parseInt, for amounts.' },
        { name: 'fetch', message: 'accounting/ must not do IO.' },
        { name: 'process', message: 'accounting/ must not read the environment.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=type(number)][raw=/\\./]',
          message:
            'Fractional number literal in accounting code — money/rates must be Decimal strings.',
        },
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Number(...) conversion in accounting code — use Decimal/BigInt.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc|pow|sqrt|random)$/]",
          message: 'Math rounding/powers on amounts is forbidden — use rounding.ts (Decimal).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'The engine must not read the clock — pass dates in.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'The engine must not read the clock — pass dates in.',
        },
      ],
    },
  },
);
