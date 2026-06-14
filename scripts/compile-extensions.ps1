# ============================================================
# Local compile-extensions-build script
# Mirror of Blue Shield CI compile-extensions-build step
# Usage: .\scripts\compile-extensions.ps1
# ============================================================

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot\..

# ===== 1. Node =====
$nodeVersion = "22.22.1"
$currentNode = (node --version 2>$null) -replace 'v',''
if ($currentNode -notmatch "^22\.") {
    if (Get-Command nvm -ErrorAction SilentlyContinue) {
        nvm use $nodeVersion
        if ($LASTEXITCODE -ne 0) { throw "nvm use $nodeVersion failed" }
    } else {
        throw "Node ${currentNode} detected but $nodeVersion required. Install nvm-windows or switch manually."
    }
}
$env:PATH = "$env:LOCALAPPDATA\nvm\$nodeVersion;$env:PATH"
Write-Host "Node: $(node --version)" -ForegroundColor Cyan

# ===== 2. Install root deps (if missing) =====
if (-not (Test-Path "node_modules\gulp\bin\gulp.js")) {
    Write-Host "=== Installing root dependencies ===" -ForegroundColor Yellow
    $env:GYP_MSVS_VERSION      = "2022"
    $env:npm_config_target     = "39.8.8"
    $env:npm_config_runtime    = "electron"
    $env:npm_config_disturl    = "https://electronjs.org/headers"
    $env:npm_config_arch       = "x64"
    $env:npm_config_target_arch = "x64"
    $env:npm_config_build_from_source = "true"
    $env:npm_config_registry   = "https://registry.npmmirror.com/"
    $env:ELECTRON_MIRROR       = "https://npmmirror.com/mirrors/electron/"

    npm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "Root npm install failed" }

    npm rebuild @parcel/watcher @vscode/native-watchdog @vscode/policy-watcher `
        @vscode/spdlog @vscode/windows-process-tree @vscode/windows-registry `
        @vscode/deviceid @vscode/sqlite3 @vscode/windows-mutex `
        @vscode/windows-ca-certs kerberos native-keymap node-pty `
        windows-foreground-love --foreground-scripts
    if ($LASTEXITCODE -ne 0) { throw "Root npm rebuild failed" }
    Write-Host "[OK] Root dependencies installed" -ForegroundColor Green
}

# ===== 3. Install build/ deps (if missing) =====
if (-not (Test-Path "build\node_modules")) {
    Write-Host "=== Installing build/ dependencies ===" -ForegroundColor Yellow
    Push-Location build
    npm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "build/ npm install failed" }

    $tsGyp = "node_modules\tree-sitter\binding.gyp"
    if (Test-Path $tsGyp) {
        $gypContent = Get-Content $tsGyp -Raw
        $gypContent = $gypContent -replace '/std:c\+\+17', '/std:c++20'
        [System.IO.File]::WriteAllText((Resolve-Path $tsGyp), $gypContent, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "[FIX] tree-sitter binding.gyp patched: c++17 -> c++20"
    }

    npm rebuild tree-sitter --foreground-scripts
    if ($LASTEXITCODE -ne 0) { throw "build/ npm rebuild failed" }
    Pop-Location
    Write-Host "[OK] build/ dependencies installed" -ForegroundColor Green
}

# ===== 4. Install extension deps (if missing) =====
$extMarker = "extensions\.ext-installed"
if (-not (Test-Path $extMarker)) {
    Write-Host "=== Installing extension dependencies ===" -ForegroundColor Yellow
    $extRoots = Get-ChildItem extensions -Directory -Depth 2
    foreach ($extDir in $extRoots) {
        if (Test-Path "$($extDir.FullName)\package.json") {
            Push-Location $extDir.FullName
            npm install --ignore-scripts 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] $extDir install failed" -ForegroundColor DarkYellow }
            Pop-Location
        }
    }
    "" | Out-File $extMarker
    Write-Host "[OK] Extension dependencies installed" -ForegroundColor Green
}

# ===== 5. Cleanup: delete extensions known to fail vsce packaging =====
Write-Host "=== Cleanup problematic extensions ===" -ForegroundColor Yellow
$toDelete = @(
    "hermes-agent", "execution-example", "kanban-example",
    "memory-example", "planning-example", "retrieval-example",
    "shared", "tool-example"
)
foreach ($d in $toDelete) {
    $path = "extensions\$d"
    if (Test-Path $path) {
        cmd /c "rd /s /q `"$path`" 2>nul"
        Write-Host "  Deleted: $path"
    }
}

# ===== 6. Reinstall codebuddy-provider shared (pick up latest fixes) =====
Write-Host "=== Reinstall @saros/shared ===" -ForegroundColor Yellow
Push-Location extensions\codebuddy-provider
cmd /c "rd /s /q node_modules\@saros 2>nul"
npm install --ignore-scripts 2>&1 | Out-Null
Pop-Location
Write-Host "  [OK] @saros/shared reinstalled"

# ===== 7. Preflight check =====
Write-Host "=== Preflight: npm list --production ===" -ForegroundColor Yellow
Push-Location extensions\codebuddy-provider
$result = npm list --production --depth=99999 --loglevel=error 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Preflight WARNING (may be OK if only 'extraneous' warnings):"
    Write-Host $result
} else {
    Write-Host "  [OK] No ELSPROBLEMS" -ForegroundColor Green
}
Pop-Location

# ===== 8. Run compile-extensions-build =====
Write-Host "=== Running compile-extensions-build ===" -ForegroundColor Cyan
npx gulp compile-extensions-build --verbose
if ($LASTEXITCODE -ne 0) {
    Write-Error "compile-extensions-build FAILED (exit code: $LASTEXITCODE)"
    Pop-Location
    exit 1
}

Write-Host "`n=== DONE ===" -ForegroundColor Green
Pop-Location
