import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/data/*.generated.json', '.claude/worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Config and build scripts aren't in any tsconfig; let the default
        // project cover them rather than type-checking tooling.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/check-dist.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Everything reaching the popup comes from a vendor page or the
      // workbook, so it goes through textContent. This is the guard the
      // innerHTML fix never had — the comment that used to sit here described
      // markup-building that had already been removed, and the rule it
      // justified was 'off', which is the default and enforced nothing.
      // No `object` key: that restricts the property on ANY object, which is
      // the point. `object: '*'` is not a wildcard — it matches an object
      // literally named `*`, so the first version of this rule was itself a
      // no-op, exactly like the one it replaced.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent or createElement.' },
        { property: 'outerHTML', message: 'Use textContent or createElement.' },
        { property: 'insertAdjacentHTML', message: 'Use textContent or createElement.' },
      ],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Fixtures build DOM to scrape; that is the point of them.
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['*.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
);
