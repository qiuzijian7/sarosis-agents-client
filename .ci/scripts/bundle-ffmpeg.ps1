# VS Saros - Windows EXE packaging: download & bundle ffmpeg (optional dep for vox voiceover video)
# Called by .ci/package-win-exe.yml AFTER 'package vscode-win32-x64' and BEFORE 'generate EXE'.
# ffmpeg is OPTIONAL: download failure only warns (does NOT fail the build). At runtime
# voxLaunchChannel.ts falls back to multi-level probe (winget / PATH / user-installed ffmpeg).
# This script is intentionally pure ASCII to avoid the GBK-read issue with -File mode.

$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 1) Download ffmpeg/ffprobe static binaries into build/saros/bin/ (idempotent: skips if present)
Write-Host "=== Fetching ffmpeg (optional dependency) ==="
node build/saros/fetch-ffmpeg.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] ffmpeg download failed (exit $LASTEXITCODE) - installer will ship WITHOUT ffmpeg."
  Write-Host "       vox voiceover video will fall back to runtime probe (winget/PATH/user-installed)."
} else {
  Write-Host "[OK] ffmpeg/ffprobe fetched into build/saros/bin/"
}

# 2) Copy into the packaged build output so Inno Setup (code.iss `Source: "*"`) bundles them.
#    Target dir = <repo>/../VSCode-win32-x64/resources/saros/bin/ (same layout strip-before-pack uses).
$buildOut = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"
$stagingBin = Join-Path $buildOut "resources\saros\bin"
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
  $src = Join-Path $repoRoot "build\saros\bin\$name"
  if (Test-Path $src) {
    New-Item -ItemType Directory -Force -Path $stagingBin | Out-Null
    Copy-Item $src $stagingBin -Force
    Write-Host "[OK] bundled $name -> resources/saros/bin/"
  } else {
    Write-Host "[WARN] $name not present in build/saros/bin - skipping (vox voiceover video unavailable)"
  }
}
