/** @type {import("prettier").Config} */
const config = {
  tabWidth: 2,
  useTabs: false,
  semi: false,
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'avoid',
  quoteProps: 'consistent',
  bracketSpacing: true,
  bracketSameLine: false,
  objectWrap: 'preserve',
  endOfLine: 'lf',
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: ['<TYPES>', '', '<BUILTIN_MODULES>', '', '<THIRD_PARTY_MODULES>', '', '^[.]'],
  importOrderParserPlugins: ['typescript', 'decorators-legacy'],
  importOrderTypeScriptVersion: '5.0.0',
  importOrderCaseSensitive: false,
}

export default config
