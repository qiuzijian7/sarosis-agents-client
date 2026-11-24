# pack-diff.ps1 - shared diff classification for pack.ps1 and pack-dsh-plugins.ps1.
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads -File scripts as ANSI unless BOM).
# Dot-source it:  . (Join-Path $PSScriptRoot 'pack-diff.ps1')
#
# Rule (single source of truth for routing):
#   - tracked changes vs <Base> are all considered;
#   - untracked files matter ONLY under dsh-plugins/ (a brand-new plugin must be packaged);
#     other untracked tooling/docs are reported as IgnoredUntracked and do NOT force a full
#     rebuild (they cannot enter an artifact until committed anyway);
#   - Kernel = paths that change shipped bytes or packaging logic;
#   - Docs = everything else (docs/, design/, dev/, test/, scripts/, *.md ...).
#
# Keeping this in one file avoids pack.ps1 and pack-dsh-plugins.ps1 drifting apart.

function Get-PackDiff {
    param([string]$Base = 'HEAD')

    $kernelPattern = '^(src|extensions|build|resources|remote|cli|\.ci|deploy-package)/|^(product|package|package-lock)\.json$|^gulpfile\.mjs$'

    $tracked = @(git diff --name-only $Base)
    if ($LASTEXITCODE -ne 0) { throw "git diff failed (exit $LASTEXITCODE)" }
    $untracked = @(git ls-files --others --exclude-standard)

    $normalize = { param($p) (($p -replace '\\', '/')).Trim() }
    $untrackedPlugin = @($untracked | Where-Object { (& $normalize $_) -match '^dsh-plugins/' })
    $ignoredUntracked = @($untracked | Where-Object { (& $normalize $_) -notmatch '^dsh-plugins/' })

    $all = @()
    $all += $tracked
    $all += $untrackedPlugin
    $files = @($all | Where-Object { $_ } | ForEach-Object { & $normalize $_ } | Select-Object -Unique)

    $plugin = @($files | Where-Object { $_ -match '^dsh-plugins/' })
    $kernel = @($files | Where-Object { $_ -match $kernelPattern })
    $docs = @($files | Where-Object { $_ -notmatch '^dsh-plugins/' -and $_ -notmatch $kernelPattern })

    return [pscustomobject]@{
        Base             = $Base
        Files            = $files
        Plugin           = $plugin
        Kernel           = $kernel
        Docs             = $docs
        IgnoredUntracked = $ignoredUntracked
        HasPlugin        = ($plugin.Count -gt 0)
        HasKernel        = ($kernel.Count -gt 0)
        HasChanges       = ($files.Count -gt 0)
    }
}
