import { defineConfig } from "vitest/config";

/**
 * Verdict tests only. Scoped to src/ and qa/ so the vendored reference repo
 * (Curso-IA/) and the separate svg-arena/ app are NOT swept into this run.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "qa/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "Curso-IA/**", "svg-arena/**"],
  },
});
