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

# === 可选依赖：媒体工具链（ffmpeg/ffprobe/yt-dlp @ resources/saros/bin/）===
# ★ 2026-09-24：这三个 exe 让「抽帧 / 视频理解」零安装可用（agent 的 extract_video_frames
#   与 video_analyze 靠 mediaBinaries.ts 优先解析该目录）。与 vox 的 ffmpeg 同一落点。
# ⚠ 刻意**不放进 $required**：它们是可选依赖，下载失败只该降级（运行时回退 PATH / 环境变量），
#   不该把整个出包判失败 —— 但必须在 CI 日志里**可见**，否则「安装包静默少了媒体能力」
#   只能等用户报「工具说请先安装 ffmpeg」才发现。
Write-Host ""
Write-Host "=== Optional: media toolchain (resources/saros/bin/) ==="
# $appRoot = <buildOut>/resources/app ⇒ 媒体二进制在其兄弟目录 <buildOut>/resources/saros/bin/
$mediaBinDir = Join-Path $appRoot "..\saros\bin"
$mediaMissing = @()
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe')) {
  if (Test-Path (Join-Path $mediaBinDir $name)) {
    Write-Host ('  [OK] resources\saros\bin\' + $name)
  } else {
    Write-Host ('  [WARN] resources\saros\bin\' + $name + ' MISSING - video features will degrade to PATH/env probe')
    $mediaMissing += $name
  }
}
if ($mediaMissing.Count -gt 0) {
  Write-Host "[WARN] Installer ships WITHOUT media binaries. Fix: node build/saros/fetch-ffmpeg.mjs"
}

# === 可选依赖：本地 ASR（whisper-cli + DLL @ resources/saros/bin/，模型 @ resources/saros/models/）===
# ★ 2026-09-25：video_analyze 的口播转写（无字幕轨视频——小红书/抖音教程——的唯一文本来源）。
#   与媒体工具链同级策略：不进 $required（下载失败只降级为「仅帧分析」），但必须在 CI 日志
#   **可见**，否则「安装包静默少了 ASR」只能等用户报「口播内容不可知」才发现。
#   DLL 只抽查 whisper.dll/ggml.dll 两个哨兵（全集随 whisper.cpp 版本漂移，拷贝侧按前缀 glob）。
Write-Host ""
Write-Host "=== Optional: local ASR (whisper.cpp @ resources/saros/) ==="
$asrMissing = @()
foreach ($name in @('whisper-cli.exe', 'whisper.dll', 'ggml.dll')) {
  if (Test-Path (Join-Path $mediaBinDir $name)) {
    Write-Host ('  [OK] resources\saros\bin\' + $name)
  } else {
    Write-Host ('  [WARN] resources\saros\bin\' + $name + ' MISSING - local ASR unavailable (frame-only fallback)')
    $asrMissing += $name
  }
}
$asrModel = Join-Path $appRoot "..\saros\models\ggml-base.bin"
if (Test-Path $asrModel) {
  Write-Host '  [OK] resources\saros\models\ggml-base.bin'
} else {
  Write-Host '  [WARN] resources\saros\models\ggml-base.bin MISSING - whisper has no model to load'
  $asrMissing += 'ggml-base.bin'
}
if ($asrMissing.Count -gt 0) {
  Write-Host "[WARN] Installer ships WITHOUT local ASR. Fix: node build/saros/fetch-whisper.mjs"
}
