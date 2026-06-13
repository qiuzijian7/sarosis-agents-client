# VSCode 源码二开项目测试流程设计

> 基于 sarosis-agents-client（VS Code 1.120.0 fork）实际项目调研撰写，适用于所有 VSCode 二次开发项目。

---

## 一、测试分层架构

VS Code 本身已建立了一套成熟的分层测试体系，二开项目通常**继承上游测试基础设施 + 扩展自有测试**。

### 测试金字塔（从上到下）

```
        ┌──────────────┐
        │  Sanity Test  │  ← 发布前质量检查（跨平台/容器）
        ├──────────────┤
        │  Smoke Test   │  ← 冒烟测试（关键路径 UI 自动化）
        ├──────────────┤
        │  E2E Test     │  ← 端到端测试（完整用户场景）
        ├──────────────┤
        │ Integration   │  ← 集成测试（多模块协作）
        ├──────────────┤
        │  Unit Test    │  ← 单元测试（隔离的单模块验证）
        └──────────────┘
```

### 各层定位与工具

| 层级 | 运行环境 | 框架 | 测试文件位置 | 改代码后必跑？ |
|------|---------|------|-------------|:---:|
| **单元测试** | Node.js / Electron / Browser | Mocha + Sinon | `src/vs/*/test/` (同目录) | ✅ 是 |
| **集成测试** | Electron / Browser / Remote | Mocha + Playwright | `test/integration/` + Extension tests | ✅ 是 |
| **E2E 测试** | Electron + Playwright | 场景驱动 (.scenario.md) | `src/vs/sessions/test/e2e/` | 按需 |
| **冒烟测试** | Electron + Playwright | Mocha | `test/smoke/` | 发版前 |
| **组件测试** | Playwright Browser | Playwright | `test/componentFixtures/playwright/` | UI 变更时 |
| **质量检查** | Docker 多容器 | 脚本驱动 | `test/sanity/` | 发版前 |

---

## 二、完整测试流程

### Phase 1：开发阶段（Developer Loop）

```
改代码 → 编译检查 → 单元测试 → 提交
  ↑                              ↓
  └──────── 修复问题 ←───────────┘
```

**每次改动后必须执行**：

1. **编译检查**
   - 改 `src/` 下代码：`npm run compile-check-ts-native`
   - 改 `extensions/` 下代码：`npm run gulp compile-extensions`
   - 改 `build/` 下代码：`npm run typecheck`（在 `build/` 目录）
   - 推荐：启动 VS Code - Build watch task 后台增量编译

2. **分层检查**：`npm run valid-layers-check`
   - 防止跨层非法引用（例如 workbench 不能引用 sessions）
   - 检查循环依赖

3. **相关单元测试**：
   ```bash
   # Windows
   scripts\test.bat --grep <模块名>
   # macOS/Linux
   scripts/test.sh --grep <模块名>
   ```

4. **集成测试**（按需）：
   ```bash
   scripts\test-integration.bat --grep <模块名>
   ```

### Phase 2：提交前检查（Pre-commit / PR）

```
PR 提交 → CI 自动触发
  ├── 编译检查（TypeScript + 分层 + 循环依赖）
  ├── 单元测试（Electron + Browser + Remote 三种环境）
  ├── 集成测试（多环境）
  └── 代码风格检查
```

CI 矩阵示例：
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    run-target: [electron, browser, remote]
```

### Phase 3：合并前验证（Pre-merge）

```
合并到主分支前
  ├── 冒烟测试（关键路径 UI 自动化）
  │   ├── Explorer 操作
  │   ├── Editor 操作
  │   ├── Search 操作
  │   └── Terminal 操作
  ├── E2E 测试（完整业务场景）
  │   └── 自定义层（如 Agent Studio）的端到端场景
  ├── 组件测试（UI 变更时）
  │   └── 关键 UI 组件的可视化回归
  └── 专项测试
      └── Agent/Copilot 交互场景
```

### Phase 4：发布质量检查（Release Gate）

```
发版前
  ├── Sanity Test（Docker 多容器环境）
  │   ├── Alpine Linux
  │   ├── CentOS 7
  │   ├── Debian 10 / 11
  │   ├── Ubuntu 20.04 / 22.04
  │   └── Windows Server
  ├── 截图对比测试（防止 UI 回归）
  ├── 性能测试（启动耗时、内存占用、Chat 性能）
  └── 遥测验证
```

---

## 三、项目（sarosis-agents-client）的测试现状

### 已覆盖的部分 ✅

| 区域 | 测试文件数 | 说明 |
|------|:--:|------|
| 上游 VS Code 测试 | ~170+ 目录 | base/platform/editor/workbench 全层 |
| Agent Studio 单元测试 | ~21 文件 | `src/vs/sessions/contrib/agentStudio/test/` |
| AgentHost 测试 | ~60+ 文件 | `src/vs/platform/agentHost/test/` |
| Sessions 层测试 | ~15 目录 | 工作台布局、会话管理、远程认证等 |
| CI 测试矩阵 | 3 OS × 3 Target | Linux/macOS/Windows × Electron/Browser/Remote |

### 值得关注的缺口 ⚠️

1. **Sessions E2E CI 被禁用**
   - `sessions-e2e.yml` 设为 `workflow_dispatch` 手动触发
   - PR 触发器被注释，无法自动验证
   - 位置：`.github/workflows/sessions-e2e.yml`

2. **WebView React 前端测试缺失**
   - `src/vs/sessions/contrib/agentStudio/webview/src/`
   - Zustand stores、ReactFlow 组件没有单元测试
   - WebView ↔ Host RPC 协议通信没有测试

3. **Sessions 层测试覆盖不如 workbench**
   - workbench：60+ 测试目录
   - sessions：~15 测试目录

---

## 四、改进建议（按优先级）

### 🔴 高优先级

#### 1. 恢复 Sessions E2E CI

```yaml
# .github/workflows/sessions-e2e.yml
on:
  pull_request:
    paths:
      - 'src/vs/sessions/**'
      - 'src/vs/sessions/contrib/agentStudio/**'
```

#### 2. 为 WebView 前端添加测试

```typescript
// 示例：Zustand store 纯逻辑测试（使用 Vitest，不需要 DOM）
import { describe, it, expect } from 'vitest';
import { useChatStore } from '../useChatStore';

describe('useChatStore', () => {
  it('should clean up only previous session live state on switch', () => {
    const { liveWorkflowExecutions } = useChatStore.getState();
    // ... 验证只删前一个 session 的桶，不 for-loop 清所有 key
  });
});
```

建议结构：
```
src/vs/sessions/contrib/agentStudio/webview/
├── src/
│   └── ...
└── __tests__/
    ├── stores/
    │   ├── useChatStore.test.ts
    │   └── useWorkflowStore.test.ts
    ├── protocol/
    │   └── messageProtocol.test.ts
    └── components/
        ├── ChatBar.test.tsx
        └── WorkflowEditor.test.tsx
```

### 🟡 中优先级

#### 3. Agent OS 能力槽集成测试

```
tests/ 验证点：
├── Model slot: provider 注册 → sendMessage 流程
├── Memory slot: agent-bindings.json 读写
├── Tool slot: builtinToolProvider 注册与 invoke
├── Planning slot: 节点编排
├── Execution slot: 工作流执行引擎
└── Retrieval slot: RAG 检索
```

#### 4. 工作流执行引擎关键路径测试

```
重点覆盖：
├── cancel 链路完整测试
│   ├── stream abort 验证（AbortController）
│   └── 状态修正验证（subagent_end 前检测 cancelled）
├── 变量替换两轮机制
│   ├── 第一轮 {{$var}}（用户填值）
│   └── 第二轮 {{$prev.output}}（上游节点输出）
└── 5 个 sendMessage 调用点
    ├── task / agent / skill / tool / ifElse
    └── _sendAndTrackStream 包装器
```

### 🟢 低优先级

#### 5. 多工作区隔离测试

```
├── IQuotaGuard 各自限流验证
├── 多 workspace 独立 OS+Driver+Provider
└── AgentBinding per-workspace 隔离
```

#### 6. 性能基准测试

```
├── Agent Studio 首次打开启动耗时
├── WebView 渲染性能（ReactFlow 大工作流）
└── LLM 流式响应内存占用
```

---

## 五、测试编写规范

本项目 `.github/copilot-instructions.md` 定义了测试编码规范：

### 断言风格

```typescript
// ✅ 推荐：快照式断言，一个 deepStrictEqual 覆盖多个校验点
assert.deepStrictEqual(actual, {
    status: 'completed',
    nodes: [{ id: 'n1', status: 'done' }],
    result: 'expected output'
});

// ❌ 避免：多个分散的精确断言
assert.strictEqual(actual.status, 'completed');
assert.strictEqual(actual.nodes[0].status, 'done');
assert.strictEqual(actual.result, 'expected output');
```

### 依赖注入

```typescript
// ✅ 注入依赖而不是 stub 全局对象
class MyService {
    constructor(
        @optional(IResizeObserver) private resizeObserver?: IResizeObserver
    ) {
        this.resizeObserver = resizeObserver ?? new NativeResizeObserver();
    }
}

// ❌ 不要在测试中 (window as any).ResizeObserver = mockResizeObserver
```

### 文件约定

- 单元测试文件放在对应源码同目录的 `test/` 子目录下
- 测试文件命名：与源码同名 + `.test.ts`
- 集成测试文件以 `.integrationTest.ts` 结尾
- 使用 `describe` 和 `it` 保持与现有模式一致
- 不要将测试添加到错误的测试套件中（例如附加到文件末尾而不是相关的 suite 内部）

---

## 六、快速命令参考

### 日常开发

```bash
# 编译检查（仅 src/ 目录）
npm run compile-check-ts-native

# 分层检查
npm run valid-layers-check

# 运行特定单元测试
scripts\test.bat --grep "WorkflowExecution"

# 运行特定集成测试
scripts\test-integration.bat --grep "agentStudio"
```

### CI 相关

```bash
# 完整单元测试（所有环境）
scripts\test.bat

# 浏览器环境测试
scripts\test.bat --runGlob **/browser/**

# 生成测试覆盖率
scripts\test.bat --coverage

# 编译 + 测试一键
npm run strict-null-check  # (如果有)
```

### 构建与调试

```bash
# 增量编译（watch 模式）
# 推荐启动 VS Code - Build task

# 全量编译
npm run compile

# 启动调试
scripts\code.bat
```

---

## 七、总结

```
┌─────────────────────────────────────────────────────────────────┐
│                    开发阶段 (改一行就跑)                         │
│  compile-check → valid-layers → unit test (--grep 相关模块)     │
├─────────────────────────────────────────────────────────────────┤
│                    PR 阶段 (自动触发)                            │
│  TypeScript check → 分层检查 → 循环依赖                         │
│  单元测试 (E/B/R) → 集成测试 (E/B/R) → 代码风格                │
├─────────────────────────────────────────────────────────────────┤
│                    合并前验证                                    │
│  冒烟测试 → E2E → 组件测试 → Agent 专项                        │
├─────────────────────────────────────────────────────────────────┤
│                    发版质量闸                                    │
│  Sanity (8 Docker 容器) → 截图对比 → 性能 → 遥测               │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：VSCode 二开项目的测试不是从零搭建，而是**继承上游 + 在自定义层补齐**。上游的 base/platform/editor/workbench 测试提供兜底，开发精力应集中在自定义层（如 sessions/）和新增功能（如 Agent Studio）的测试覆盖上。
