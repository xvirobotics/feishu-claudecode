import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // spike/ holds standalone behaviour-check scripts ("7/7 SDK checks pass"
    // harnesses) run directly during development — they are not vitest
    // suites, so exclude them from the test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**'],
    server: {
      deps: {
        external: ['undici'],
      },
    },
  },
});
