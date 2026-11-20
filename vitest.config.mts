import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // `backends.test.ts` spawns real processes; 5s is not enough on a cold CI
    // runner and produced a red build for a test that actually passed.
    testTimeout: 20_000
  }
})
