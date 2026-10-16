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
# 2026-10-10：dsh 底座伴生插件 `dsh-plugins/**`（@vssaros/dsh-bridge 控制桥 + @vssaros/dsh-chat-surface
# 聊天承载 + dsh-compat.json 随包兼容清单）—— **运行时按路径读取**（DshHostSupervisor 从
# `<appPath>/dsh-plugins/` 复制进 dsh profile 再 `dsh plugin add`；pnpm 的 file: 必须真实目录，不进 asar），
# 从不被静态 import ⇒ 属"打包拷贝只带走它认识的文件"高危类（同 kbWorker / tree-sitter-wasm / .agents）。
# 缺失的后果：控制桥不存在 ⇒ 工作区注册 / 会话绑定 / 升级闸门全部静默退回 URL 行兜底。
Copy-IfMissing "dsh-plugins" "dsh-plugins" "vssaros-bridge\package.json"
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
  "out\vs\extensions\capability-plugins.js",
  # 2026-09-25：内置智能体资源 `resources/.agents/**` —— **点目录**，运行时按路径读取
  #   （skillRegistryService 扫 skills、feishuSyncCore 找 kb/feishu-sync.mjs），从不被静态 import
  #   ⇒ 打包拷贝整棵漏掉。实测已发布包缺它 ⇒ 内置技能全不可用、点「同步飞书」报
  #   「未找到内置同步脚本（resources/.agents/kb/feishu-sync.mjs）——安装可能不完整」。
  #   自愈在 build/saros/strip-before-pack.mjs 的 ensureDir('resources/app/resources/.agents')；
  #   这里做**硬性**校验：缺失即判出包失败（与 kbWorker.js / tree-sitter-wasm 同一类关键构件）。
  "resources\.agents\kb\feishu-sync.mjs",
  "resources\.agents\skills\kb-feishu-sync\SKILL.md",
  "resources\.agents\skills\kb-build\SKILL.md",
  "resources\.agents\mcp-presets",
  "resources\.agents\builtin-workflows",
  # 2026-10-10：dsh 底座构件（同上：运行时按路径读取，缺失即底座静默残废——硬性校验）。
  # 伴生插件（控制桥 + 页面桥客户端）：
  "dsh-plugins\vssaros-bridge\package.json",
  "dsh-plugins\vssaros-bridge\cordis.patch.yml",
  "dsh-plugins\vssaros-bridge\lib\index.js",
  "dsh-plugins\vssaros-bridge\lib\client.js",
  # chat-surface 插件（聊天框会话绑定 / 主题同步 / 插入引用）：
  "dsh-plugins\vssaros-chat-surface\package.json",
  "dsh-plugins\vssaros-chat-surface\cordis.patch.yml",
  "dsh-plugins\vssaros-chat-surface\lib\index.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.js",
  # 皮肤部件：lib/client.js 只是入口，各换皮点在同目录的 package-local chunk 里
  # （dsh client-modules 契约：require.async("./client.<name>.js")，服务端按 dirname(clientPath) 取文件）。
  # 缺任一 → 对应 UI 静默不换皮（入口把失败记进 window.__vssarosChatSurface.partErrors）。
  "dsh-plugins\vssaros-chat-surface\lib\client.skin.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.hero.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.queue.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.usage.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.tools.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.approval.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.openInApp.js",
  "dsh-plugins\vssaros-chat-surface\lib\client.preset.js",
  # 随包兼容清单（稳定通道可升级到的 dsh 版本）：
  "dsh-plugins\dsh-compat.json",
  # ★ 2026-10-14：随包 **vendored 第三方技能包** archify（上游 `@tt-a1i/archify-dsh`，MIT）。
  #   它的负载在 `skills/`（不在 `lib/` 里）= gulpfile 的 glob **单独列**的一行 ⇒ 打包漏掉那行时
  #   本地开发一切正常、装出来只有个空壳（"装了插件但没技能" ✗）。这里硬性钉三件：
  #   入口清单（package.json）+ patch（没有它技能不会挂载）+ 技能本体（SKILL.md）。
  "dsh-plugins\vssaros-archify\package.json",
  "dsh-plugins\vssaros-archify\cordis.patch.yml",
  "dsh-plugins\vssaros-archify\skills\archify\SKILL.md",
  #   上游 MIT 许可证必须随分发（合规；见该目录 VENDOR.md）：
  "dsh-plugins\vssaros-archify\LICENSE",
  # dsh 视图 preload（build/next 独立编译 + gulpfile.vscode.ts 资源清单）：
  "out\vs\sessions\contrib\dshHarness\electron-browser\preload-dshView.js"
)
# 2026-09-20：逐语言 wasm 也进**硬性**清单（sentinel 只证包目录在 ✗ —— 那次安装版缺 10 个语言
# 照样绿灯放行 ✗✗）。以仓库侧目录为准动态展开（防清单漂移 ✓）。
if (Test-Path $repoWasmDir) {
  foreach ($f in (Get-ChildItem $repoWasmDir -Filter *.wasm)) {
    $required += "node_modules\@vscode\tree-sitter-wasm\wasm\$($f.Name)"
  }
}
# 2026-10-10：内置 dsh 运行时 + profile 种子（README 4.29/4.32；build/prepack-dsh-runtime.mjs 生成）。
# 策略=**硬性**（2026-10-16 由"条件硬性"收紧 —— 用户报「打包出的 vssaros.exe 无法找到 dsh」）：
#   两个打包入口（.ci/scripts/package-vscode.ps1 与 deploy-package/scripts/build-installer.ps1）
#   现在都会先跑 prepack，所以"仓库侧没有 dsh-runtime\<bundled>"本身就是**异常**（prepack 没跑/失败）
#   ⇒ 不能再只 WARN 放行：那样会静默出一个"首启弹准备环境、要用户自己 npm 装运行时"的包 ✗✗。
$bundledVer = $null
try { $bundledVer = (Get-Content -Raw -Encoding utf8 "dsh-plugins\dsh-compat.json" | ConvertFrom-Json).bundled } catch {}
if (-not $bundledVer) {
  Write-Error "cannot read dsh-plugins\dsh-compat.json .bundled (无法确定该内置哪个 dsh 版本)"
  exit 1
}
if (-not (Test-Path (Join-Path $repoRoot "dsh-runtime\$bundledVer"))) {
  Write-Error ("repo has no dsh-runtime\" + $bundledVer + " - 先跑 node build/prepack-dsh-runtime.mjs（两个打包入口都会自动跑；手动打包时别跳过）")
  exit 1
}
$required += "dsh-runtime\$bundledVer\node_modules\@deepseek-ai\dsh\lib\bin.js"
$required += "dsh-runtime\$bundledVer\node_modules\sherpa-onnx-win-x64\sherpa-onnx.node"  # 语音输入引擎（win）
# ⚠ profile 种子是**加速项**，不是硬性（2026-10-16 收紧"运行时本体"时一并定的口径）：
#   建种子要 pnpm（`dsh plugin add` 直接 spawn 它），CI 机器不一定有 ⇒ 缺种子只该**告警**：
#   没有它时首启会自己装 profile（慢 1-2 分钟）。硬拦的后果是"为了一个加速项不出包" ✗✗。
$seedWarn = @(
  "dsh-runtime\$bundledVer\profile-seed\seed.json",
  "dsh-runtime\$bundledVer\profile-seed\profiles\vssaros\package.json",
  "dsh-runtime\$bundledVer\profile-seed\profiles\vssaros\node_modules\@vssaros\dsh-bridge\package.json"
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

# 加速项（profile 种子）只告警：缺它 ⇒ 首启自己装 profile（慢 1-2 分钟，且要求用户有 pnpm）。
# 必须在日志里可见 —— 否则"首启慢"会被当成偶发，没人知道是种子没进包 ✗。
foreach ($rel in $seedWarn) {
  if (Test-Path (Join-Path $appRoot $rel)) { Write-Host ('  [OK] ' + $rel) }
  else { Write-Host ('  [WARN] ' + $rel + ' (profile seed missing - first run will install plugins itself; needs pnpm, ~1-2 min)') }
}

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
