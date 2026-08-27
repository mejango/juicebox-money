import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Coverage must be able to instrument production TSX that no unit test
  // imports. Next keeps JSX for its own compiler; Vitest needs it lowered to
  // JavaScript before V8's uncovered-file parser sees it.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts', './test/dialog-shim.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      // `*.browsertest.tsx` routes only exist in the deterministic browser
      // build; the Playwright suite is their only caller.
      exclude: ['src/**/*.d.ts', 'src/**/*.browsertest.tsx'],
      // Global floors cover every production TS/TSX file, including currently
      // untested UI and routes. They were raised from the original ~8% floor
      // after adding real component write-flow coverage (10.61/8.16/9.24/11.10
      // measured). Keep high, targeted floors below for trust boundaries.
      // Semantic transaction coverage remains separately inventoried because
      // a line percentage cannot prove safe calldata.
      thresholds: {
        statements: 10.4,
        branches: 8,
        functions: 9.1,
        lines: 10.9,
        'src/components/project/AutoIssuanceSection.tsx': {
          statements: 30,
          branches: 25,
          functions: 18,
          lines: 35,
        },
        'src/components/project/CashOutFlow.tsx': {
          statements: 65,
          // The direct-sell approval queue (TxSteps) only branches under a live
          // pool quote, which the jsdom flow does not drive; ratchet back up
          // once that route has a unit fixture.
          branches: 62,
          functions: 55,
          lines: 68,
        },
        'src/components/project/ExtrasTab.tsx': {
          statements: 65,
          branches: 64,
          functions: 55,
          lines: 68,
        },
        'src/hooks/useSafeTx.ts': {
          statements: 78,
          branches: 68,
          functions: 80,
          lines: 82,
        },
        'src/lib/bendystraw.ts': {
          statements: 60,
          branches: 60,
          functions: 38,
          lines: 60,
        },
        'src/lib/cashOut.ts': {
          statements: 85,
          branches: 80,
          functions: 75,
          lines: 85,
        },
        'src/lib/contract-write.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'src/lib/launch.ts': {
          statements: 90,
          branches: 75,
          functions: 90,
          lines: 90,
        },
        'src/lib/manage.ts': {
          statements: 80,
          branches: 65,
          functions: 75,
          lines: 85,
        },
        'src/lib/relayr.ts': {
          statements: 80,
          branches: 65,
          functions: 82,
          lines: 82,
        },
        'src/lib/safe.ts': {
          statements: 50,
          branches: 32,
          functions: 60,
          lines: 55,
        },
        'src/lib/transaction-builders.ts': {
          statements: 95,
          branches: 80,
          functions: 100,
          lines: 95,
        },
        'src/lib/transaction-review.ts': {
          statements: 90,
          branches: 75,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
})
