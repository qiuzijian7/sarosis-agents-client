# VS Saros - Windows EXE packaging: download & bundle whisper.cpp (local ASR).
# Called by .ci/package-win-exe.yml AFTER 'package vscode-win32-x64' and BEFORE 'generate EXE'.
# Purpose (2026-09-25): video_analyze gets spoken content only from yt-dlp subtitle tracks,
# but xiaohongshu/douyin tutorial videos have NO subtitle track (speech only) => the model
# sees frames and must say "spoken content unknowable". whisper-cli + a ggml model provide
# offline local ASR: download video -> ffmpeg extracts audio -> whisper-cli transcribes.
# OPTIONAL (same policy as bundle-ffmpeg.ps1): a download failure only warns (does NOT fail
# the build); the feature degrades to frame-only analysis instead of breaking the installer.
# This script is intentionally pure ASCII to avoid the GBK-read issue with -File mode
# (same lesson as bundle-ffmpeg.ps1).

$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 1) Download whisper-cli + DLLs + ggml model into build/saros/{bin,models}/ (idempotent:
#    skips what is already present and valid).
#    --skip-selftest: the self-test synthesizes speech via Windows SAPI - CI agents may lack
#    audio/TTS components; it is a developer-machine check, not a CI gate.
#    If CI cannot reach GitHub/HuggingFace, point SAROS_WHISPER_URL / SAROS_WHISPER_MODEL_URL
#    at internal mirrors (both are passed straight through to fetch-whisper.mjs).
$extraArgs = @()
if ($env:SAROS_WHISPER_URL) { $extraArgs += @('--whisper-url', $env:SAROS_WHISPER_URL) }
if ($env:SAROS_WHISPER_MODEL_URL) { $extraArgs += @('--model-url', $env:SAROS_WHISPER_MODEL_URL) }
Write-Host "=== Fetching whisper.cpp binaries + model (optional dependency, local ASR) ==="
node build/saros/fetch-whisper.mjs --skip-selftest @extraArgs
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] whisper fetch failed (exit $LASTEXITCODE) - installer will ship WITHOUT local ASR."
  Write-Host "       video_analyze degrades to frame-only analysis ('spoken content unknowable')."
  Write-Host "       If CI cannot reach GitHub/HuggingFace, set SAROS_WHISPER_URL / SAROS_WHISPER_MODEL_URL."
} else {
  Write-Host "[OK] whisper-cli + DLLs + model fetched into build/saros/{bin,models}/"
}

# 2) Copy into the packaged build output so Inno Setup (code.iss `Source: "*"` + recursesubdirs)
#    bundles them. Target dirs = <repo>/../VSCode-win32-x64/resources/saros/{bin,models}/
#    (same layout strip-before-pack.mjs section 5.6 uses - keep this script in sync with it).
$buildOut = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"
$stagingBin = Join-Path $buildOut "resources\saros\bin"
$stagingModels = Join-Path $buildOut "resources\saros\models"
$repoBin = Join-Path $repoRoot "build\saros\bin"

$exe = Join-Path $repoBin "whisper-cli.exe"
if (Test-Path $exe) {
  New-Item -ItemType Directory -Force -Path $stagingBin | Out-Null
  Copy-Item $exe $stagingBin -Force
  Write-Host "[OK] bundled whisper-cli.exe -> resources/saros/bin/"
} else {
  Write-Host "[WARN] whisper-cli.exe not present in build/saros/bin - skipping (ASR degrades to frame-only)"
}

# DLLs are runtime dependencies (whisper.dll / ggml*.dll / parakeet.dll / SDL2.dll): missing any
# one of them means whisper-cli will not start. Glob by prefix instead of naming each - the DLL
# set changes between whisper.cpp versions (e.g. parakeet.dll appeared in v1.9).
$dllCount = 0
if (Test-Path $repoBin) {
  Get-ChildItem $repoBin -Filter *.dll |
    Where-Object { $_.Name -match '^(whisper|ggml|parakeet|SDL2)' } |
    ForEach-Object {
      New-Item -ItemType Directory -Force -Path $stagingBin | Out-Null
      Copy-Item $_.FullName $stagingBin -Force
      $dllCount++
    }
}
if ($dllCount -gt 0) {
  Write-Host "[OK] bundled $dllCount whisper DLLs -> resources/saros/bin/"
} else {
  Write-Host "[WARN] no whisper DLLs found in build/saros/bin - whisper-cli will not start"
}

$model = Join-Path $repoRoot "build\saros\models\ggml-base.bin"
if (Test-Path $model) {
  New-Item -ItemType Directory -Force -Path $stagingModels | Out-Null
  Copy-Item $model $stagingModels -Force
  Write-Host "[OK] bundled ggml-base.bin -> resources/saros/models/"
} else {
  Write-Host "[WARN] ggml-base.bin not present in build/saros/models - skipping (whisper has no model to load)"
}
