# 验证打包关键构件
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$appRoot = Join-Path (Split-Path $pwd.Path -Parent) "VSCode-win32-x64\resources\app"
if (-not (Test-Path $appRoot)) { $appRoot = "..\VSCode-win32-x64\resources\app" }
Write-Host ('Verifying staging dir: ' + $appRoot)

# 自愈：补齐 agent-studio/out 与 node_modules/typescript（gulp 扩展管线不认识 agent-studio，
# 且 out/ 被 .gitignore 排除；typescript 是 html/css/json 语言服务器运行时依赖）。
# 必须在校验与 Inno 打包之前确保存在，否则带病出包。详见 build/saros/strip-before-pack.mjs
# （2026-08-29 生产事故）。放在校验步骤可保证无论前面的 gulp/strip 是否被绕过，这里都会兜底。
function Copy-IfMissing($rel, $repoRel, $sentinel) {
  $dst = Join-Path $appRoot $rel
  $dstSentinel = Join-Path $dst $sentinel
  if (Test-Path $dstSentinel) { return }
  $src = Join-Path $repoRoot $repoRel
  if (Test-Path (Join-Path $src $sentinel)) {
    Copy-Item -Recurse -Force $src $dst
    Write-Host ('  [SELF-HEAL] copied ' + $rel)
  } else {
    Write-Host ('  [WARN] self-heal source missing: ' + $repoRel)
  }
}
Copy-IfMissing "extensions\agent-studio\out" "extensions\agent-studio\out" "extension.js"
Copy-IfMissing "node_modules\typescript" "node_modules\typescript" "package.json"

$required = @(
  "node_modules\@vscode\ripgrep\bin\rg.exe",
  "extensions\agentmemory-memory\dist\extension.js",
  "extensions\codebuddy-provider\dist\extension.cjs.js",
  "extensions\tof-authentication\out\extension.js",
  "extensions\agent-studio\out\extension.js",
  "node_modules\typescript\package.json",
  "out\vs\sessions\contrib\agentStudio\browser\views\knowledgeBase\kbWorker.js",
  "out\vs\sessions\sessions.desktop.main.js",
  "out\vs\sessions\contrib\agentStudio\webview\media\kbblocks.js"
)
$missing = @()
foreach ($rel in $required) {
  $p = Join-Path $appRoot $rel
  if (Test-Path $p) { Write-Host ('  [OK] ' + $rel) }
  else { Write-Host ('  [MISSING] ' + $rel); $missing += $rel }
}
if ($missing.Count -gt 0) {
  Write-Error (('Staging verification failed, missing:' + [Environment]::NewLine + ' - ') + ($missing -join ([Environment]::NewLine + ' - ')))
  exit 1
}
Write-Host "[OK] All critical artifacts present in staging."
