# VS Code 源码项目自动化编译、运行和调试指南

## 目录
1. [现有配置概览](#现有配置概览)
2. [自动化编译配置](#自动化编译配置)
3. [自动化运行配置](#自动化运行配置)
4. [自动化调试配置](#自动化调试配置)
5. [AI 工具集成](#ai-工具集成)
6. [高级自动化技巧](#高级自动化技巧)
7. [常见问题排查](#常见问题排查)

---

## 现有配置概览

你的项目已经配置了完整的自动化工具：

### ✅ 已配置的任务 (tasks.json)
- **核心编译任务**: Transpile, Typecheck, Extensions Build
- **组合任务**: VS Code - Build (一键构建)
- **监听任务**: 支持 watch 模式自动重新编译
- **运行任务**: Run Dev, Run Dev Agents
- **清理任务**: Kill 系列任务用于重启构建

### ✅ 已配置的调试 (launch.json)
- **主进程调试**: Attach to Main Process (端口 5875)
- **扩展主机调试**: Attach to Extension Host (端口 5870)
- **共享进程调试**: Attach to Shared Process (端口 5879)
- **Agent 主机调试**: Attach to Agent Host Process (端口 5878)
- **复合调试配置**: VS Code, VS Code Agents

---

## 自动化编译配置

### 1. 使用 VS Code 任务（推荐）

#### 一键编译（默认构建任务）
```bash
# 在 VS Code 中按 Ctrl+Shift+B 或运行：
Task: Run Build Task
```

这会自动执行 `VS Code - Build` 任务，包含：
- Core - Transpile (esbuild 转译)
- Core - Typecheck (TypeScript 类型检查)
- Ext - Build (扩展构建)
- Copilot - Build (Copilot 构建)

#### 监听模式（自动重新编译）

**启动监听模式：**
```bash
# 在 VS Code 中运行以下任务：
- Core - Transpile (自动启动 watch 模式)
- Core - Typecheck (自动启动 watch 模式)
- Ext - Build (自动启动 watch 模式)
```

**或者使用命令行：**
```bash
# 终端1: 启动所有 watch 任务
npm run watch

# 终端2: 启动开发版本
./scripts/code.bat --inspect=5875
```

### 2. 使用自定义脚本（build-vscode.bat）

你已经有一个完整的编译脚本 `build-vscode.bat`，它执行：
1. 生产编译（带混淆）
2. 扩展编译
3. 打包 Win32 x64 版本

**运行方式：**
```bash
.\build-vscode.bat
```

### 3. 优化编译流程

创建自定义 npm scripts（在 package.json 中）：

```json
{
  "scripts": {
    "dev": "npm run watch & npm run start",
    "dev:fast": "npm run watch:client & npm run start",
    "build:prod": "npx gulp compile-build-with-mangling",
    "build:dev": "npm run compile",
    "clean": "npx gulp clean",
    "rebuild": "npm run clean && npm run build:prod"
  }
}
```

---

## 自动化运行配置

### 1. 使用 VS Code 任务运行

#### 运行开发版本
```bash
# 在 VS Code 中运行任务：
Task: Run Task → Run Dev
```

对应的脚本：
```bash
# Windows
.\scripts\code.bat

# Linux/Mac
./scripts/code.sh
```

#### 运行 Agent 版本
```bash
# 在 VS Code 中运行任务：
Task: Run Task → Run Dev Agents
```

会自动添加参数：
```bash
.\scripts\code.bat --agents `
  --user-data-dir=$env:USERPROFILE\.vscode-oss-sessions-dev `
  --extensions-dir=$env:USERPROFILE\.vscode-oss-sessions-dev\extensions
```

### 2. 一键编译并运行

使用组合任务 `Run and Compile Code - OSS`：
```bash
# 这会按顺序执行：
1. Transpile Client
2. Run Dev
```

或者在命令行：
```bash
npm run compile && .\scripts\code.bat
```

### 3. 自动化重启

创建重启脚本 `restart-vscode.bat`：

```batch
@echo off
echo Stopping running instances...
taskkill /F /IM "Code - OSS.exe" 2>nul

echo Waiting for cleanup...
timeout /t 2 /nobreak >nul

echo Recompiling...
call npm run compile

echo Starting VS Code...
start "" ".\scripts\code.bat" --inspect=5875

echo Done!
```

---

## 自动化调试配置

### 1. 使用复合调试配置（推荐）

#### 调试完整 VS Code（主进程 + 扩展主机 + 共享进程）

在 VS Code 中：
```
Run and Debug (Ctrl+Shift+D) → 选择 "VS Code" → 按 F5
```

这会同时启动：
- Launch VS Code Internal (主进程)
- Attach to Main Process (端口 5875)
- Attach to Extension Host (端口 5870)
- Attach to Shared Process (端口 5879)
- Attach to Agent Host Process (端口 5878)

#### 调试 Agent 版本

```
Run and Debug → 选择 "VS Code Agents" → 按 F5
```

### 2. 手动附加到进程

如果自动附加失败，可以手动附加：

1. 启动 VS Code（带调试标志）：
   ```bash
   .\scripts\code.bat --inspect=5875 --remote-debugging-port=9222
   ```

2. 在 VS Code 中运行调试配置：
   - `Attach to Main Process` (端口 5875)
   - `Attach to Extension Host` (端口 5870)
   - `Attach to Shared Process` (端口 5879)

### 3. 调试特定扩展

示例：调试 Markdown 扩展

```
Run and Debug → 选择 "Markdown Extension Tests" → 按 F5
```

### 4. 条件断点和日志断点

在源代码中设置：
- **条件断点**：右键断点 → Add Conditional Breakpoint
- **日志断点**：右键断点 → Add Logpoint

示例条件：
```javascript
// 条件断点
this.name === 'AgentStudio'

// 日志断点
Agent {this.id} initialized with {this.capabilities.length} capabilities
```

---

## AI 工具集成

### 1. GitHub Copilot 集成

#### 安装和配置
1. 安装 GitHub Copilot 扩展
2. 登录 GitHub 账号
3. 在设置中启用：
   ```json
   {
     "github.copilot.enable": {
       "*": true,
       "yaml": true,
       "markdown": true
     },
     "github.copilot.editor.enableAutoCompletions": true
   }
   ```

#### 使用 Copilot 辅助编译调试
- **代码补全**：自动完成编译配置
- **内联聊天**：选中代码 → Ctrl+I → 输入 "fix build error"
- **聊天面板**：Ctrl+Shift+I → 询问 "如何优化 VS Code 编译速度"

### 2. CodeBuddy 集成

#### 使用 CodeBuddy 自动化任务
```bash
# 在 CodeBuddy 中运行：
/commit  # 自动提交代码
/model    # 切换 AI 模型
```

#### CodeBuddy 技能集成
- **agent-reach**：搜索 GitHub Issues 和 Discussions
- **technical-analyst**：分析编译错误模式
- **web-access**：查找编译文档和解决方案

### 3. 使用 AI 辅助调试

#### 示例：让 AI 分析编译错误

**输入：**
```
我的编译报错：
Error: Cannot find module 'vs/base/common/path'
```

**AI 辅助输出：**
```bash
# 可能的原因和解决方案：
1. 依赖未安装 → 运行 npm install
2. 路径别名未配置 → 检查 tsconfig.json
3. 编译顺序错误 → 先运行 Core - Transpile
```

---

## 高级自动化技巧

### 1. 使用 Gulp 自定义构建流程

创建 `gulpfile.js` 自定义任务：

```javascript
const gulp = require('gulp');
const { series, parallel } = gulp;

// 自定义任务：清理 + 编译 + 打包
gulp.task('my-build', series(
  'clean',
  parallel('transpile-client', 'typecheck-client'),
  'compile-extensions',
  'package'
));

// 监听文件变化并自动重新加载
gulp.task('dev-watch', () => {
  gulp.watch('src/**/*.ts', series('transpile-client', 'reload'));
});
```

运行：
```bash
npx gulp my-build
```

### 2. 使用 nodemon 自动重启

安装 nodemon：
```bash
npm install -g nodemon
```

创建 `nodemon.json`：
```json
{
  "watch": ["out", "extensions"],
  "ext": "js,json",
  "exec": "taskkill /F /IM \"Code - OSS.exe\" && .\\scripts\\code.bat",
  "delay": "2"
}
```

运行：
```bash
nodemon
```

### 3. 使用 PowerShell 脚本自动化

创建 `automate-build.ps1`：

```powershell
# 自动化编译、运行、调试
param(
    [string]$Mode = "dev"  # dev, prod, debug
)

switch ($Mode) {
    "dev" {
        Write-Host "=== 开发模式：监听 + 运行 ===" -ForegroundColor Green
        Start-Process -FilePath "code" -ArgumentList ".", "--new-window"
        Start-Sleep -Seconds 2
        code --command "Tasks: Run Task" --task "VS Code - Build"
    }
    "prod" {
        Write-Host "=== 生产编译 ===" -ForegroundColor Yellow
        .\build-vscode.bat
    }
    "debug" {
        Write-Host "=== 启动调试会话 ===" -ForegroundColor Cyan
        code --command "Debug: Select and Start Debugging" --args "VS Code"
    }
}
```

运行：
```powershell
.\automate-build.ps1 -Mode debug
```

### 4. 集成到 CI/CD

创建 `.github/workflows/build.yml`：

```yaml
name: Build and Test VS Code

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: windows-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Compile
      run: npm run compile
      
    - name: Run tests
      run: npm test
      
    - name: Package
      run: npx gulp vscode-win32-x64
      
    - name: Upload artifacts
      uses: actions/upload-artifact@v3
      with:
        name: vscode-build
        path: .build/win32-x64/
```

---

## 常见问题排查

### 1. 编译失败

**问题**：TypeScript 编译错误
```
error TS2307: Cannot find module 'vs/base/common/path'
```

**解决方案**：
```bash
# 1. 确保依赖已安装
npm install

# 2. 先运行转译任务
npm run watch-client-transpiled

# 3. 在新终端中运行类型检查
npm run watch-clientd
```

### 2. 调试无法附加

**问题**：Attach to Extension Host 超时

**解决方案**：
```bash
# 1. 确保主进程已启动并开启调试端口
.\scripts\code.bat --inspect=5875

# 2. 在 launch.json 中增加超时时间
{
  "name": "Attach to Extension Host",
  "timeout": 30000  # 增加到 30 秒
}

# 3. 手动检查端口是否监听
netstat -ano | findstr 5870
```

### 3. 监听任务占用端口

**问题**：Cannot start watch task, port already in use

**解决方案**：
```bash
# 运行清理任务
Task: Run Task → Kill VS Code - Build

# 或者手动清理
.\build-vscode.bat clean
taskkill /F /IM "ng.exe"  # 如果使用了 angular 编译器
```

### 4. 扩展未加载

**问题**：调试时扩展不生效

**解决方案**：
```bash
# 1. 检查扩展是否已编译
ls extensions/*/out/

# 2. 使用正确的用户数据目录
.\scripts\code.bat --user-data-dir=.vscode-oss-dev

# 3. 禁用其他扩展避免冲突
.\scripts\code.bat --disable-extensions
```

---

## 快速参考卡片

### 🚀 常用命令速查

| 功能 | 命令/操作 |
|------|-----------|
| 一键编译 | `Ctrl+Shift+B` → `VS Code - Build` |
| 启动监听 | `Ctrl+Shift+P` → `Tasks: Run Task` → `Core - Transpile` |
| 运行开发版 | `Ctrl+Shift+P` → `Tasks: Run Task` → `Run Dev` |
| 启动调试 | `F5` → 选择 `VS Code` |
| 附加到扩展主机 | `F5` → 选择 `Attach to Extension Host` |
| 查看编译日志 | `Ctrl+Shift+U` → 选择 `Tasks` |
| 清理构建 | `npx gulp clean` |

### 📁 关键文件路径

| 文件 | 路径 | 用途 |
|------|------|------|
| 任务配置 | `.vscode/tasks.json` | 定义编译、运行任务 |
| 调试配置 | `.vscode/launch.json` | 定义调试会话 |
| 编译脚本 | `build-vscode.bat` | 生产环境编译 |
| 开发脚本 | `scripts/code.bat` | 启动开发版本 |
| 扩展入口 | `extensions/*/src/` | 扩展源代码 |

---

## 总结

通过以上配置，你可以实现：

1. ✅ **自动化编译**：使用 VS Code 任务或自定义脚本
2. ✅ **自动化运行**：一键启动开发版本
4. ✅ **自动化调试**：复合调试配置，一键调试所有进程
5. ✅ **AI 辅助**：集成 GitHub Copilot 和 CodeBuddy
6. ✅ **CI/CD 集成**：自动化构建和测试流程

**推荐工作流**：
```bash
# 开发时（监听模式）
1. 启动监听：Tasks → Core - Transpile (watch)
2. 启动调试：F5 → "VS Code"
3. 修改代码 → 自动重新编译 → 自动重新加载

# 生产构建时
1. 运行 .\build-vscode.bat
2. 检查 .build/win32-x64/ 输出
```

---

**文档版本**：1.0  
**最后更新**：2026-05-13  
**维护者**：AI Assistant
