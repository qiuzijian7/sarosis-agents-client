# pack.ps1 - SINGLE packaging entry. Routes to the right pipeline by diff.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 -File scripts).
#
#   powershell -File .ci/scripts/pack.ps1                       # auto: decide by diff
#   powershell -File .ci/scripts/pack.ps1 -DryRun              # show decision only
#   powershell -File .ci/scripts/pack.ps1 -Base HEAD~1          # decide by last commit
#   powershell -File .ci/scripts/pack.ps1 -Mode patch -Only vssaros-bridge
#   powershell -File .ci/scripts/pack.ps1 -Mode exe            # force EXE fast pack
#   powershell -File .ci/scripts/pack.ps1 -Mode full           # force full build
#
# Routes:
#   patch -> pack-dsh-plugins.ps1   plugin-only tgz + manifest, no EXE (default for plugin-only diffs)
#   exe   -> pack-dsh-only.ps1      reuse staging, still a full EXE (needs -InitBaseline first)
#   full  -> build-baseline.ps1     complete local build + timing + auto -InitBaseline
#
# NOTE for CI: the full route calls the LOCAL one-shot baseline script (it skips
# install-deps by design). On CI, trigger .ci/package-win-exe.yml instead - use
# -DryRun here only as a dispatcher that prints "route=full".

param(
    [string]$Base = 'HEAD',
    [ValidateSet('auto', 'patch', 'exe', 'full')][string]$Mode = 'auto',
    [string]$Only = '',
    [string]$SignKey = '',
    [string]$MinClient = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# Purge the CodeBuddy --require shim for every child process (safe-delete blocks bulk prune).
$env:NODE_OPTIONS = '--max-old-space-size=8192'
$scriptRoot = (Resolve-Path $PSScriptRoot).Path
$repoRoot = (Resolve-Path (Split-Path (Split-Path $scriptRoot))).Path
Set-Location $repoRoot
$shell = (Get-Process -Id $PID).Path

. (Join-Path $scriptRoot 'pack-diff.ps1')

function Invoke-PackStep([string]$Label, [string[]]$Arguments) {
    Write-Host "[pack] ---> $Label"
    Write-Host ("[pack] cmd : {0} {1}" -f $shell, ($Arguments -join ' '))
    if ($DryRun) {
        Write-Host '[pack] DRY RUN: nothing executed'
        return
    }
    & $shell @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    Write-Host "[pack] <--- $Label done"
}

$diff = Get-PackDiff -Base $Base
Write-Host "[pack] base=$Base files=$($diff.Files.Count) plugin=$($diff.Plugin.Count) kernel=$($diff.Kernel.Count) docs=$($diff.Docs.Count)"
if ($diff.Plugin.Count) { Write-Host "[pack] plugin example: $($diff.Plugin[0])" }
if ($diff.Kernel.Count) { Write-Host "[pack] kernel example: $($diff.Kernel[0])" }
if ($diff.IgnoredUntracked.Count) {
    Write-Host "[pack] note: $($diff.IgnoredUntracked.Count) untracked non-plugin file(s) ignored (commit them to affect routing)"
}

$route = $Mode
if ($Mode -eq 'auto') {
    if ($diff.HasKernel) {
        $route = 'full'
        Write-Host '[pack] auto: kernel changes present -> full build'
    } elseif ($diff.HasPlugin) {
        $route = 'patch'
        Write-Host '[pack] auto: only dsh-plugins changes -> plugin patch'
    } else {
        throw 'No artifact-affecting changes detected. Use -Mode patch|exe|full explicitly to rebuild anyway (or -Base HEAD~1 to judge the last commit).'
    }
}
Write-Host "route=$route"

switch ($route) {
    'patch' {
        if ($diff.HasKernel) {
            throw "Explicit -Mode patch but kernel changes are present (e.g. $($diff.Kernel[0])). A plugin patch cannot carry kernel changes - use -Mode full."
        }
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'pack-dsh-plugins.ps1'), '-Base', $Base)
        if ($Only) { $arguments += @('-Only', $Only) }
        if ($SignKey) { $arguments += @('-SignKey', $SignKey) }
        if ($MinClient) { $arguments += @('-MinClient', $MinClient) }
        Invoke-PackStep 'plugin patch' $arguments
    }
    'exe' {
        if ($diff.HasKernel) {
            throw "Explicit -Mode exe but kernel changes are present (e.g. $($diff.Kernel[0])). Reusing a baseline staging would ship a NEW version with an OLD kernel - use -Mode full."
        }
        $baseline = Join-Path $repoRoot '.build\pack-reports\quick-baseline.json'
        $staging = Join-Path (Split-Path $repoRoot) 'VSCode-win32-x64'
        $sentinel = Join-Path $staging 'resources\app\out\main.js'
        if (-not (Test-Path -LiteralPath $baseline) -or -not (Test-Path -LiteralPath $sentinel)) {
            throw "EXE fast pack needs a baseline staging and quick-baseline.json (missing: $baseline / $sentinel). Run -Mode full once first; build-baseline.ps1 registers the baseline automatically."
        }
        # pack-dsh-only.ps1 runs its own guards against quick-baseline.json.
        Invoke-PackStep 'EXE fast pack (reuse staging)' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'pack-dsh-only.ps1'))
    }
    'full' {
        Write-Host '[pack] full route: complete local build; this can take a long time. On CI prefer .ci/package-win-exe.yml.'
        Invoke-PackStep 'full build + baseline registration' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'build-baseline.ps1'))
    }
}

if (-not $DryRun) { Write-Host "[pack] DONE route=$route" }
