// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // GitRunner is the one chokepoint all git invocations go through
      // (execFile, shell:false, argv-only). These bans keep a future
      // caller from reaching for the shell-interpolating alternatives.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportSpecifier[imported.name="exec"], ImportDefaultSpecifier[local.name="exec"]',
          message:
            "child_process.exec is banned (shell interpolation risk) — use GitRunner (execFile, shell:false) instead.",
        },
        {
          selector:
            'MemberExpression[property.name="exec"][object.name=/^(child_process|childProcess|cp)$/]',
          message:
            "child_process.exec is banned (shell interpolation risk) — use GitRunner (execFile, shell:false) instead.",
        },
        {
          selector: 'Property[key.name="shell"][value.value=true]',
          message:
            'shell:true is banned — it re-enables shell interpolation that execFile with an argv array avoids.',
        },
      ],
    },
  },
);
