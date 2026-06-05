---
name: vscode-fork-ghost-js-purge
description: 排查并修复 sarosis-agents-client（VSCode fork）因 src 混入幽灵 .js 导致 out 产物 const enum 缺命名导出、F5/启动时 ESM 抛 "does not provide an export named X" 主进程崩溃的问题。当出现 ESM SyntaxError "does not provide an export named"、崩在 ModuleJob._instantiate 或 startup/onReady、F5 启动几秒后进程消失不弹窗、或怀疑 out 产物里 const enum 被内联无导出时使用。
agent_created: true
---

# VSCode Fork 幽灵 JS 污染排查与清除

## 适用症状

任一即触发本流程：
- 启动 stderr：`SyntaxError: The requested module '.../xxx.js' does not provide an export named 'YYY'`
- 崩溃栈含 `at ModuleJob._instantiate (node:internal/modules/esm/module_job)` + `at async startup (src\main.ts)` + `at async onReady`
- F5 后进程起来几秒又全部消失、renderer 窗口不弹（主进程在创建窗口前崩溃退出）
- 怀疑 out 里某模块的 `const enum` 被 tsc 风格内联（`N /* Enum.Member */`，无运行时对象、无 export）

## 根因模型（务必先理解，避免走弯路）

1. **唯一产 JS 管线是 esbuild**：`build/next/index.ts transpile`（= `npm run transpile-client` / `watch-client-transpile`）。esbuild 对 `const enum` 的处理是**正确的**——生成运行时 `var X = (...)((X2)=>{...})(X||{})` 并放入 `export {}`。**不要怀疑 esbuild。**
2. **watch-client 不 emit JS**：它是 `watchTypeCheckTask('src')` → `createTsgoStream(..., {noEmit:true})`，只做类型检查。
3. **覆盖陷阱（真正根因）**：`build/next/index.ts` 的 main 流程是「先 `transpile()`（esbuild 正确产出）→ 后 `copyAllNonTsFiles()`（把 src 全部非 .ts 文件拷到 out）」。如果 src 里存在**与 .ts 同名的 .js**（tsc 误 emit 的幽灵产物），它会**在 esbuild 正确产物之后被拷贝覆盖**到 out → out 里 const enum 变成 tsc 内联形态、缺 export → ESM 校验失败 → 崩。
4. **幽灵 js 为何隐形**：`.gitignore` 忽略 `src/**/*.js`，幽灵 js 全是 git-untracked，git status 和肉眼都难发现。

## 关键判据

- **唯一可靠的幽灵指标 = 「与同名 .ts 并存的 .js」**。
- `find src/vs -name "*.js" | wc -l` **不可信**——仓库自带数千个合法纯 .js（无同名 .ts：测试夹具、loader、worker 等）。必须用脚本按"同名 .ts 并存"过滤。
- 坏产物特征：`grep "EnumName.Member */" xxx.js` 命中（tsc 内联注释）、且**无** `var EnumName` 运行时对象、**无** `export { EnumName }`。

## 修复步骤（顺序不可乱）

### 1. 先解锁 out（必须最先做）
Windows 文件锁会让 `fs.rm({force:true})` 静默失败，导致后续 transpile「跑了却不变」。
```bash
# Git Bash 杀进程必须加 MSYS_NO_PATHCONV=1，否则 /F 被当路径转换
MSYS_NO_PATHCONV=1 taskkill /F /IM "Code - OSS.exe" 2>/dev/null
# 杀整套 watch 进程树：找到 npm-run-all2 / build/next/index.ts 对应 node 进程并 kill
```

### 2. 扫描幽灵 js（用 .mjs 脚本，避免 shell 转义与 git 锁扫描）
写一个 node 脚本递归 `src/vs`，对每个 `.js` 检查同目录同名 `.ts` 是否存在；存在即幽灵。统计数量、列样本、抽查关键文件（如 `configurationRegistry.js`）是否含内联坏特征。参考 references/ghost-scan.mjs。

### 3. 删除幽灵 js
仅删「同名 .ts 并存 + git untracked」的 .js。脚本内二次确认两个条件再 unlink，逐个删并计数。

### 4. 重新 transpile
```bash
node build/next/index.ts transpile
```

### 5. 验证
- 关键 const enum 复查：每个目标 .js 含 `var EnumName` + `export { ... EnumName ... }`。重点验高频跨文件的：ConfigurationScope / StorageScope / KeyCode / EditorOption / SymbolKind / FileOperationResult / Platform / CharCode / WorkbenchState / LifecyclePhase。
- 资源拷贝数应下降（删了 N 个幽灵就少 N）。本项目基线：干净时 `Copied 10314 files`。
- 剩余仍"缺导出"的 const enum，逐个核验其**跨文件消费者是否为 0**——为 0 则是 esbuild 合法的文件内私有 enum 内联，无害。
- 重启 `npm run watch`，确认 transpile `0 errors`、watch-client noEmit `0 errors`。
- 复扫幽灵 js = 0。

## 防复发
- 根除幽灵 js 来源：不要在 src 上跑会 emit 的 tsc（如手动 `tsc -p src` 不带 `--noEmit`、或某些 IDE「编译 TS」动作）。本 fork 类型检查统一走 tsgo `noEmit`。
- 已有 `.gitignore: src/**/*.js` 保护提交，但不防本地污染 out，仍需定期复扫。

## 陷阱备忘
- 沙箱 shell 继承 `ELECTRON_RUN_AS_NODE=1`，**无法真实复现 F5**，直接跑 Code-OSS.exe 必报 `'electron' does not provide an export named 'Menu'`——这是假象，不是本 bug。要拿真实崩溃须让用户在真实 PowerShell 跑（参考 scripts/diag-f5.ps1）。
- bash `node -e` 内多层 `\\b` 正则转义会被吞导致假阴性；统一用 Write 工具写 `.mjs` 文件执行。
- 邻近项目的 `.git/index.lock` 可能触发 sandbox 拦截 git 命令；用纯 node fs 脚本绕过 git。
