import { configDefaults, defineConfig } from 'vitest/config'
// VsSaros patch (Windows): scripts/dsh-superagent is a POSIX service script (tmux, ps, sh) that VsSaros never runs — the
// plugin runs inside the VsSaros dsh Host — so its spec runs on POSIX only.
const posixOnlySpecs = process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []
// Share one React instance across DSH client packages and tests.
// VsSaros fix (2026-11-06): 15 s per test and hook, not vitest's 5 s. The full suite runs its 90 files in parallel; under
// that load a Runtime start, a SQLite migration or a panel's 5-second poll took past 5 s now and then, which failed a
// correct test. A test that needs longer still says so itself.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: [...configDefaults.exclude, ...posixOnlySpecs], setupFiles: ['tests/fixtures/setup.ts'],
    testTimeout: 15_000, hookTimeout: 15_000 } })
