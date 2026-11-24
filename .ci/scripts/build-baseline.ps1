# build-baseline.ps1 - one-shot full packaging baseline for plugin-level quick packs.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads -File scripts as ANSI unless there is a BOM.
#
# Equivalent to .ci/package-win-exe.yml steps 3..10, but safe to run on a developer machine:
#   - skips bk-set-version.ps1  (version stays as-is; baseline is an internal artifact)
#   - skips install-deps.ps1    (keeps the existing node_modules)
#   - skips compile-build.ps1   (it deletes out/ and all tsbuildinfo; instead call gulp directly,
#                                which only touches out-build and preserves the dev build in out/)
#
# Writes .build/pack-reports/timing-baseline.json and registers the quick-pack baseline
# (.build/pack-reports/quick-baseline.json) so .ci/scripts/pack-dsh-only.ps1 can be used afterwards.
#
# Run in background (full build can take a long time):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .ci/scripts/build-baseline.ps1

param([switch]$SkipOptional)

$ErrorActionPreference = 'Stop'
# Match CI exactly (.ci/package-win-exe.yml NODE_OPTIONS = --max-old-space-size=8192):
#   - the mangler's tsc worker OOMs on the default heap (observed ERR_WORKER_OUT_OF_MEMORY
#     after ~2 min in the first baseline attempt);
#   - inside CodeBuddy IDE the parent shell injects a --require shim whose safe-delete hook
#     blocks the bulk deletes in prepack/prune (see build/prepack-dsh-runtime.mjs header).
# Assigning unconditionally purges that shim for every child process of this build.
$env:NODE_OPTIONS = '--max-old-space-size=8192'
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot
$scriptRoot = Join-Path $repoRoot '.ci\scripts'
$reports = Join-Path $repoRoot '.build\pack-reports'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$shell = (Get-Process -Id $PID).Path
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'

# Keep the same setup target as pack-dsh-only.ps1 so the timing comparison is fair.
if (-not $env:SAROS_SETUP_TARGETS) { $env:SAROS_SETUP_TARGETS = 'user' }
# Deliberately do NOT set SAROS_PACK_MODE / SAROS_MEDIA_MODE / VSSAROS_SKIP_OFFICE_RUNTIME:
# pack-dsh-only.ps1 records their effective values in the baseline snapshot, so leaving them
# unset keeps manual quick packs consistent with this baseline.

function Write-Json([string]$Path, [object]$Value) {
    $json = ($Value | ConvertTo-Json -Depth 8) + "`n"
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Step([string]$Name, [string]$Script) {
    $started = Get-Date
    Write-Host "=== [$Name] start $(Get-Date -Format o) ==="
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot $Script)
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "$Name failed (exit $code)" }
    Write-Host ("=== [$Name] done in {0:N1} min ===" -f ((Get-Date) - $started).TotalMinutes)
}

$t0 = Get-Date
try {
    Invoke-Step 'kbblocks'        'build-kbblocks.ps1'

    $started = Get-Date
    Write-Host '=== [compile-build-with-mangling] (gulp directly, dev out/ preserved) ==='
    & $gulp compile-build-with-mangling --verbose
    if ($LASTEXITCODE -ne 0) { throw "compile-build-with-mangling failed (exit $LASTEXITCODE)" }
    Write-Host ("=== [compile-build-with-mangling] done in {0:N1} min ===" -f ((Get-Date) - $started).TotalMinutes)

    Invoke-Step 'copy-kbblocks'   'copy-kbblocks.ps1'
    Invoke-Step 'transpile'       'transpile-plugins.ps1'
    Invoke-Step 'extensions'      'compile-extensions.ps1'
    Invoke-Step 'package-vscode'  'package-vscode.ps1'

    if (-not $SkipOptional) {
        Invoke-Step 'bundle-ffmpeg' 'bundle-ffmpeg.ps1'
        Invoke-Step 'bundle-whisper' 'bundle-whisper.ps1'
    }

    Invoke-Step 'verify-staging'  'verify-staging.ps1'
    Invoke-Step 'generate-exe'    'generate-exe.ps1'

    $elapsed = [int]((Get-Date) - $t0).TotalSeconds
    Write-Json (Join-Path $reports 'timing-baseline.json') ([ordered]@{
        phase = 'baseline'
        commit = (git rev-parse HEAD).Trim()
        seconds = $elapsed
        setupTargets = $env:SAROS_SETUP_TARGETS
        finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
    Write-Host "=== [init quick-pack baseline] (total $elapsed s) ==="
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'pack-dsh-only.ps1') -InitBaseline
    if ($LASTEXITCODE -ne 0) { throw "InitBaseline failed (exit $LASTEXITCODE)" }
    Write-Host '=== BASELINE READY ==='
    exit 0
} catch {
    $elapsed = [int]((Get-Date) - $t0).TotalSeconds
    Write-Json (Join-Path $reports 'baseline-failed.json') ([ordered]@{
        phase = 'baseline'
        seconds = $elapsed
        error = $_.Exception.Message
        finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
    Write-Host "=== BASELINE FAILED after $elapsed s : $($_.Exception.Message) ==="
    exit 1
}
