/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true,
    browser: true,
  },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/next-env.d.ts',
    '**/prisma/migrations/**',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    eqeqeq: ['error', 'always'],
    // One way to reach the client address (decisions 0052/0055): through the resolver, never
    // by reaching into the framework or opening a forwarding header wherever it is handy.
    // The three files that do read it are the only ones allowed to, by override below.
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[property.name='ip'][object.name=/^(request|req)$/]",
        message: 'Read the resolved address through requestMeta (clientIp), not request.ip.',
      },
      {
        selector: "MemberExpression[property.name=/^x-(real-ip|forwarded-for)$/]",
        message: 'Read the client address through resolveClientAddress/clientIpFrom, not a header directly.',
      },
      {
        selector: "MemberExpression[computed=true][property.value=/^(x-real-ip|x-forwarded-for)$/]",
        message: 'Read the client address through resolveClientAddress/clientIpFrom, not a header directly.',
      },
    ],
  },
  overrides: [
    {
      // The request-metadata module, the API bootstrap that resolves the address once and the
      // web tier's single door to the API: the three places allowed to touch it.
      files: ['apps/api/src/auth/request.ts', 'apps/api/src/bootstrap.ts', 'apps/web/src/lib/upstream.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
