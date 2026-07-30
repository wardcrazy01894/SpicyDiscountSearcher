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
      // The popup builds one trusted string of its own markup; everything that
      // comes from a vendor page goes through textContent instead.
      'no-restricted-syntax': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['*.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
);
