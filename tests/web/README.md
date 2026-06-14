# Agent Studio Web 模式自动化测试

## 📋 概述

本文档说明如何使用 Playwright 对 saros-agents-client 项目进行 Web 模式自动化测试，包括 UI 交互和录屏功能。

---

## 🚀 快速开始

### 1. 安装依赖

```bash
# 安装项目依赖（如果还没安装）
cd G:\CustomWorkspaces\AIProjects\saros-agents-client
npm install

# 安装 Playwright 浏览器
npm run playwright-install
```

### 2. 编译项目

```bash
# 编译 TypeScript 代码
npm run compile
```

### 3. 运行测试

```bash
# 运行所有 Web 模式测试（自动启动 VSCode Web 服务器）
npm run test:web

# 或有头模式运行（可以看到浏览器界面）
npm run test:web:ui

# 调试模式（逐步执行）
npm run test:web:debug
```

### 4. 查看测试结果

```bash
# 查看 HTML 报告
npm run test:web:report

# 或直接打开
npx playwright show-report test-results
```

---

## 📊 测试结构

```
saros-agents-client/
├── playwright.web.config.ts          # Playwright Web 模式配置文件
├── tests/
│   └── web/
│       ├── agent-studio.spec.ts     # Agent Studio 测试用例
│       └── README.md               # 本文件
├── test-results/                    # 测试结果输出目录
│   ├── agent-studio-spec-xxx/
│   │   ├── video.webm              # 🎥 测试录像
│   │   ├── trace.zip               # 🔍 Trace 文件
│   │   └── screenshots/           # 📸 截图
│   └── results.json                # 测试结果 JSON
└── package.json                    # 包含测试脚本
```

---

## 🎥 录像功能说明

### 录像配置

在 `playwright.web.config.ts` 中配置：

```typescript
use: {
  // 始终录制视频
  video: 'on',
  videoSize: { width: 1920, height: 1080 },
  
  // 失败时保留 Trace（包含截图、网络请求、操作记录）
  trace: 'retain-on-failure',
  
  // 仅失败时截图
  screenshot: 'only-on-failure',
}
```

### 查看录像

测试完成后，录像文件保存在 `test-results/` 目录：

```bash
# 方法 1：通过 HTML 报告查看
npm run test:web:report
# 在报告中点击测试用例 → Attachments → video.webm

# 方法 2：直接打开视频文件
start test-results\agent-studio-spec-xxx\video.webm

# 方法 3：查看 Trace（更强大）
npx playwright show-trace test-results\agent-studio-spec-xxx\trace.zip
```

---

## 🧪 测试用例说明

### agent-studio.spec.ts

包含以下测试用例：

| 测试用例 | 说明 |
|---------|------|
| `VSCode Web should load successfully` | 验证 VSCode Web 模式正常加载 |
| `Agent Studio view should be accessible` | 验证 Agent Studio 视图可访问 |
| `Agent Studio WebView should load` | 验证 Agent Studio WebView 加载 |
| `Should interact with Agent Studio chat in WebView` | 测试聊天交互功能 |
| `Should verify Agent Studio UI elements` | 验证 UI 元素存在 |

---

## 🛠️ 高级用法

### 1. 运行单个测试

```bash
# 运行指定测试文件
npx playwright test tests/web/agent-studio.spec.ts --config=playwright.web.config.ts

# 运行指定测试用例
npx playwright test --config=playwright.web.config.ts -g "Agent Studio WebView should load"
```

### 2. 调试测试

```bash
# 调试模式（逐步执行，可查看 DOM）
npm run test:web:debug

# 或有头模式（可以看到浏览器界面）
npm run test:web:ui
```

### 3. 查看 Trace

Trace 比视频更强大，可以：
- 回放整个测试过程
- 查看每个操作时的 DOM 状态
- 查看网络请求
- 查看控制台日志

```bash
# 打开 Trace 查看器
npx playwright show-trace test-results/agent-studio-spec-xxx/trace.zip
```

---

## 🔧 配置说明

### playwright.web.config.ts 关键配置

```typescript
export default defineConfig({
  testDir: './tests/web',           // 测试文件目录
  timeout: 120_000,                // 测试超时时间（毫秒）
  
  use: {
    video: 'on',                   // 录像配置：始终录制
    trace: 'retain-on-failure',    // Trace 配置：失败时保留
    baseURL: 'http://localhost:9222', // VSCode Web 服务器地址
  },
  
  webServer: {
    command: 'node scripts/code-sessions-web.js --port 9222 --skip-welcome --mock',
    url: 'http://localhost:9222',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

### 自定义配置

如需修改配置，编辑 `playwright.web.config.ts`：

- **修改端口**：更改 `webServer.command` 中的 `--port 9222` 和 `baseURL`
- **修改超时**：调整 `timeout` 和 `use.actionTimeout`
- **修改录像质量**：调整 `videoSize` 和 `video`
- **修改浏览器**：在 `projects` 中配置 `browserName` 和 `channel`

---

## 🐛 故障排除

### 问题 1：VSCode Web 服务器启动失败

**症状**：测试报错 `Timed out waiting for WebServer`

**解决方案**：
```bash
# 手动启动 VSCode Web 服务器，检查是否有错误
node scripts/code-sessions-web.js --port 9222 --skip-welcome --mock

# 如果报错，检查：
# 1. 项目是否已编译（npm run compile）
# 2. 端口 9222 是否被占用（netstat -ano | findstr 9222）
# 3. 查看错误日志
```

### 问题 2：WebView 未找到

**症状**：测试报错 `WebView not found`

**解决方案**：
1. 检查 Agent Studio 是否正确安装和激活
2. 手动打开 VSCode Web，确认 Agent Studio 视图存在
3. 检查 WebView 的 selector 是否正确（`iframe.webview`）

### 问题 3：测试超时

**症状**：测试超时失败

**解决方案**：
1. 增加 `timeout` 配置（当前 120_000ms）
2. 检查 Agent 响应时间是否过长
3. 使用 `npm run test:web:debug` 逐步调试

### 问题 4：录像文件未生成

**症状**：`test-results/` 目录中没有 `video.webm`

**解决方案**：
1. 检查 `video` 配置是否为 `'on'`
2. 检查测试是否成功完成（失败可能因 `retain-on-failure` 不保留录像）
3. 检查 `test-results/` 目录权限

---

## 📚 参考资料

- [Playwright 官方文档](https://playwright.dev/)
- [Playwright 录像功能](https://playwright.dev/docs/videos)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [VSCode Web 模式文档](https://code.visualstudio.com/docs/editor/vscode-web)

---

## 📝 更新日志

- **2026-05-29**：初始版本，创建 Web 模式测试环境
  - 创建 `playwright.web.config.ts` 配置文件
  - 创建 `tests/web/agent-studio.spec.ts` 测试脚本
  - 添加 `package.json` 测试脚本
  - 编写本文档

---

## 💡 提示

- 首次运行测试时，建议使用 `npm run test:web:ui` 有头模式，可以看到测试执行过程
- 如果测试失败，优先查看 `trace.zip`，比视频更详细
- 定期清理 `test-results/` 目录，避免占用过多磁盘空间
- 在 CI/CD 环境中，建议使用 `video: 'retain-on-failure'` 避免存储过多视频

---

**祝您测试顺利！** 🎉
