import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "output/**",
      "data/**",
      "coverage/**",
      "fixtures/audio/**",
      "tools/native-test/**",
      "tools/libkeyfinder/**",
      "tools/keyfinder-cli/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  // Dependencies flow from app adapters to catalog services to audio/domain code.
  ...[
    ["domain", ["catalog", "audio-analysis", "audio-renderer"]],
    ["audio-analysis", ["catalog", "audio-renderer"]],
    ["audio-renderer", ["catalog", "audio-analysis"]],
    ["catalog", []],
  ].map(([name, forbidden]) => ({
    files: [`packages/${name}/src/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/apps/**",
                "@dnb-crate/cli",
                "@dnb-crate/mcp-server",
                ...forbidden.flatMap((dependency) => [
                  `@dnb-crate/${dependency}`,
                  `@dnb-crate/${dependency}/**`,
                  `**/${dependency}/**`,
                ]),
              ],
              message:
                "Keep package dependencies pointing toward domain/audio code; compose application behavior in the catalog or app adapters.",
            },
          ],
        },
      ],
    },
  })),
);
