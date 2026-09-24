# VS Saros - Windows EXE packaging: download & bundle ffmpeg/ffprobe/yt-dlp.
# Called by .ci/package-win-exe.yml AFTER 'package vscode-win32-x64' and BEFORE 'generate EXE'.
# Purpose (2026-09-24 widened): vox voiceover video needs ffmpeg; the agent video tools
# (extract_video_frames / video_analyze) need ffmpeg+ffprobe AND yt-dlp (to download remote
# videos and subtitles). Shipping them means "zero user install".
# All three are OPTIONAL: a download failure only warns (does NOT fail the build). At runtime
# voxLaunchChannel.ts / mediaBinaries.ts fall back to multi-level probe (PATH / env override).
# This script is intentionally pure ASCII to avoid the GBK-read issue with -File mode.

$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 1) Download ffmpeg/ffprobe/yt-dlp static binaries into build/saros/bin/ (idempotent: skips if present)
Write-Host "=== Fetching media binaries (ffmpeg/ffprobe/yt-dlp, optional dependencies) ==="
node build/saros/fetch-ffmpeg.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] media binary download failed (exit $LASTEXITCODE) - installer will ship WITHOUT them."
  Write-Host "       vox voiceover video and the video tools (extract_video_frames / video_analyze)"
  Write-Host "       will fall back to the runtime probe (PATH / FFMPEG_PATH / YTDLP_PATH)."
} else {
  Write-Host "[OK] ffmpeg/ffprobe/yt-dlp fetched into build/saros/bin/"
}

# 2) Copy into the packaged build output so Inno Setup (code.iss `Source: "*"`) bundles them.
#    Target dir = <repo>/../VSCode-win32-x64/resources/saros/bin/ (same layout strip-before-pack uses).
#    Keep this list in sync with build/saros/strip-before-pack.mjs section 5.5.
$buildOut = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"
$stagingBin = Join-Path $buildOut "resources\saros\bin"
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe')) {
  $src = Join-Path $repoRoot "build\saros\bin\$name"
  if (Test-Path $src) {
    New-Item -ItemType Directory -Force -Path $stagingBin | Out-Null
    Copy-Item $src $stagingBin -Force
    Write-Host "[OK] bundled $name -> resources/saros/bin/"
  } else {
    Write-Host "[WARN] $name not present in build/saros/bin - skipping (video features degrade to PATH probe)"
  }
}
