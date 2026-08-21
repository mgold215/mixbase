import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent scratch directories. Gitignored, but eslint does not read
    // .gitignore, so it walked them and reported warnings on files no human
    // wrote — the same untracked-tool-junk-in-the-checkout class that produced
    // two 16k phantom-error incidents (2026-08-19 / 08-20) and sent a run
    // chasing an environment problem as if it were a code problem.
    ".remember/**",
    ".agents/**",
    ".codex/**",
  ]),
]);

export default eslintConfig;
