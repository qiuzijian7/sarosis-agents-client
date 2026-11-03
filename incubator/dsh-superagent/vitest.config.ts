import { configDefaults, defineConfig } from 'vitest/config'
// VsSaros patch (Windows): scripts/dsh-superagent is a POSIX service script (tmux, ps, sh) that VsSaros never runs — the
// plugin runs inside the VsSaros dsh Host — so its spec runs on POSIX only.
const posixOnlySpecs = process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: [...configDefaults.exclude, ...posixOnlySpecs] } })
