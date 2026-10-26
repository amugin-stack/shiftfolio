import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Vitest config for the Lyve scheduler. Tests live next to the code they
// exercise under src/ as `*.test.ts` files (Vitest's default include).
//
// Environment is intentionally `node` rather than `jsdom` because the
// modules under test today (payout, useStreams merge helpers, timezone
// helpers) are pure functions that don't touch the DOM. Switch to
// `happy-dom` or `jsdom` here if/when we add component tests.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**', 'src/hooks/**'],
    },
  },
})
