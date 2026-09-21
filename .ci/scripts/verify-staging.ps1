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
# 2026-09-15：codebase 图谱解析 Worker 池按**运行时路径**读该模块
# （`codebaseGraphParserPool._initPool` → `<appRoot>/node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js`），
# 缺则 `Worker pool init failed … fallback to main thread` ⇒ 18 万节点索引改在渲染主线程解析（UI 冻结）。
# 它从不被静态 import（字符串路径），gulp 的依赖拷贝曾漏掉它 —— 发布包 2.2.26032-saros 实测缺失。
# install-deps.ps1（5.4）只保障**源码树** node_modules，产物侧需在此与 strip-before-pack.mjs 双重兜底。
Copy-IfMissing "node_modules\@vscode\tree-sitter-wasm" "node_modules\@vscode\tree-sitter-wasm" "wasm\tree-sitter.js"
# 2026-09-20（用户报「10/11 个语言的 tree-sitter wasm 读取失败」）：上面的 sentinel 只证明
# `wasm\tree-sitter.js` 在 ✗ —— 不证明**各语言** wasm 在 ✗✗。bundler 只会带上 VS Code 自身引用的
# 那 7 个（bash/css/ini/powershell/regex/typescript/tree-sitter ✓），agentStudio 图谱按**运行时路径**
# 读的另 10 个（tsx/javascript/python/go/rust/java/ruby/cpp/c-sharp/php ✗）从不被静态 import ⇒ 被丢 ✗✗。
# ⇒ 以仓库侧 wasm 目录为准逐文件补齐（不硬编码清单，防漂移 ✓；与 strip-before-pack.mjs 2.6b 同源）。
$repoWasmDir = Join-Path $repoRoot "node_modules\@vscode\tree-sitter-wasm\wasm"
if (Test-Path $repoWasmDir) {
  $stagingWasmDir = Join-Path $appRoot "node_modules\@vscode\tree-sitter-wasm\wasm"
  $added = 0
  foreach ($f in (Get-ChildItem $repoWasmDir -Filter *.wasm)) {
    $dst = Join-Path $stagingWasmDir $f.Name
    if (-not (Test-Path $dst)) {
      Copy-Item -Force $f.FullName $dst
      $added++
      Write-Host ('  [SELF-HEAL] copied tree-sitter-wasm/wasm/' + $f.Name)
    }
  }
  if ($added -gt 0) { Write-Host ('  [WARN] per-language wasm missing ' + $added + ' (self-healed) — bundler dropped runtime-path-loaded artifacts') }
} else {
  Write-Error "repo-side node_modules\@vscode\tree-sitter-wasm\wasm not found — cannot verify per-language wasm"
  exit 1
}

$required = @(
  "node_modules\@vscode\ripgrep\bin\rg.exe",
  "extensions\agentmemory-memory\dist\extension.js",
  "extensions\codebuddy-provider\dist\extension.cjs.js",
  "extensions\tof-authentication\out\extension.js",
  "extensions\agent-studio\out\extension.js",
  "node_modules\typescript\package.json",
  "node_modules\@vscode\tree-sitter-wasm\wasm\tree-sitter.js",
  "out\vs\sessions\contrib\agentStudio\browser\views\knowledgeBase\kbWorker.js",
  "out\vs\sessions\sessions.desktop.main.js",
  "out\vs\sessions\contrib\agentStudio\webview\media\kbblocks.js",
  # 2026-09-21：能力插件清单（build/next 生成的**运行时路径加载**产物，同 wasm 一类 ✗）。
  # 缺它 ⇒ 安装版静默退到「dev 硬编码回退清单」，且每个插件的 primary import 指向 src/ ✗。
  "out\vs\extensions\capability-plugins.js"
)
# 2026-09-20：逐语言 wasm 也进**硬性**清单（sentinel 只证包目录在 ✗ —— 那次安装版缺 10 个语言
# 照样绿灯放行 ✗✗）。以仓库侧目录为准动态展开（防清单漂移 ✓）。
if (Test-Path $repoWasmDir) {
  foreach ($f in (Get-ChildItem $repoWasmDir -Filter *.wasm)) {
    $required += "node_modules\@vscode\tree-sitter-wasm\wasm\$($f.Name)"
  }
}
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
