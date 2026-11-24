# pack-dsh-plugins.ps1 - build a plugin-only patch (no EXE, no Inno Setup).
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads -File scripts as ANSI unless there is a BOM.
#
# This is the P0 entry of the plugin-level update path. It produces tgz + plugins-manifest.json
# under build/saros/update-server/downloads/plugins/, which the update server exposes as
# /api/dsh-plugins and /downloads/plugins/*.tgz.
#
# Usage:
#   powershell -File .ci/scripts/pack-dsh-plugins.ps1 -Only vssaros-bridge,vssaros-chat-surface
#   powershell -File .ci/scripts/pack-dsh-plugins.ps1 -Base <commit>
#   powershell -File .ci/scripts/pack-dsh-plugins.ps1 -Only x -SignKey <pem> -MinClient 2.2.26248

param(
    [string]$Only = '',
    [string]$Base = 'HEAD',
    [string]$SignKey = '',
    [string]$MinClient = '',
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
# CI variables are injected as environment variables; explicit parameters win.
if (-not $Only -and $env:PATCH_ONLY) { $Only = $env:PATCH_ONLY }
if ($env:PATCH_BASE) { $Base = $env:PATCH_BASE }
if (-not $SignKey -and $env:PATCH_SIGN_KEY) { $SignKey = $env:PATCH_SIGN_KEY }
if (-not $MinClient -and $env:SAROS_MIN_CLIENT) { $MinClient = $env:SAROS_MIN_CLIENT }
# Purge the CodeBuddy --require shim (its safe-delete hook blocks rmSync in the generator)
# and give node a normal heap. Same reasoning as build-baseline.ps1.
$env:NODE_OPTIONS = '--max-old-space-size=4096'
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

function Assert-Exit([string]$Label) {
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}

# ---- guard 1: only dsh-plugins/** may differ from the baseline -----------------
# Shared classification with pack.ps1 (single source of truth for routing):
# pure docs/design changes are ignored; untracked non-plugin tooling files do not block a patch.
. (Join-Path $PSScriptRoot 'pack-diff.ps1')
$diff = Get-PackDiff -Base $Base
if ($diff.Kernel.Count -gt 0) {
    throw "Non-plugin product changes detected ($($diff.Kernel.Count), e.g. $($diff.Kernel[0])): a plugin patch cannot carry kernel changes. Run -Mode full instead."
}
$changed = $diff.Plugin
Write-Host "[plugin-patch] guard 1 OK: $($changed.Count) plugin file(s), $($diff.Docs.Count) doc-only change(s) ignored"

# ---- guard 2: runtime content changes require a version bump ------------------
# pnpm treats file:<dir> with an unchanged version as a no-op (dsh-plugins/README.md rule 1).
$changedSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($f in $changed) { [void]$changedSet.Add($f) }
$needBump = @{}
foreach ($f in $changed) {
    if ($f -notmatch '^dsh-plugins/([^/]+)/(.+)$') { continue }
    $pkgDir = $Matches[1]
    $rel = $Matches[2]
    if ($rel -eq 'package.json' -or $rel -match '^(dev|test)/' -or $rel -match '\.md$') { continue }
    $needBump[$pkgDir] = $true
}
$missingBump = @($needBump.Keys | Where-Object { -not $changedSet.Contains("dsh-plugins/$_/package.json") })
if ($missingBump.Count -gt 0) {
    throw "Runtime content changed without a version bump: $($missingBump -join ', '). Run: node scripts/dsh-plugin-deploy.mjs --bump"
}
Write-Host '[plugin-patch] guard 2 OK: version bump rule satisfied'

# ---- generate ---------------------------------------------------------------
$nodeArgs = @('build/saros/package-dsh-plugins.mjs')
if ($Only) { $nodeArgs += @('--only', $Only) } else { $nodeArgs += @('--base', $Base) }
if ($SignKey) { $nodeArgs += @('--sign-key', $SignKey) }
if ($MinClient) { $nodeArgs += @('--min-client', $MinClient) }
if ($Out) { $nodeArgs += @('--out', $Out) }
node @nodeArgs
Assert-Exit 'package-dsh-plugins.mjs'

$outDir = if ($Out) { $Out } else { Join-Path $repoRoot 'build\saros\update-server\downloads\plugins' }
$manifest = Join-Path $outDir 'plugins-manifest.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "Manifest not produced: $manifest" }
$m = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$total = [math]::Round((($m.plugins | Measure-Object -Property size -Sum).Sum) / 1KB, 1)
Write-Host "[plugin-patch] DONE: $($m.plugins.Count) plugin(s), $total KB, signed=$([bool]$m.signature)"
Write-Host "[plugin-patch] manifest: $manifest"
Write-Host '[plugin-patch] next: sync downloads/plugins/ to the update server DOWNLOADS_DIR/plugins/'
Write-Host '                     (deploy-package/scripts/deploy-update-server.ps1 does this)'
