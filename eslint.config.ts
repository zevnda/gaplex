import js from '@eslint/js'
import unusedImports from 'eslint-plugin-unused-imports'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**/*', 'node_modules/**/*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'unused-imports': unusedImports,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'strict': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclarator > ArrowFunctionExpression > TSTypeAnnotation',
          message:
            'Do not use explicit return types on arrow functions. Rely on TypeScripts inference.',
        },
        {
          selector: 'FunctionDeclaration > TSTypeAnnotation',
          message: 'Do not use explicit return types on function declarations.',
        },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          args: 'none',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      'no-multiple-empty-lines': 'warn',
      'no-unreachable': 'error',
      'no-sync': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      // This is a long-running CLI/daemon whose entire interface is console
      // output, so unlike a UI app there's no "stray debug log" concern here.
      'no-console': 'off',
      'quotes': ['warn', 'single', { avoidEscape: true }],
      'object-shorthand': ['warn', 'always'],
    },
  },
)
