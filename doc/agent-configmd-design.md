# Agent ConfigMD — Markdown 双向同步面板

每个 Agent 实例可维护一个 `.md` 文件作为**单一可信数据源**，系统将其解析为 HTML 视图。
MD 与 HTML 之间**实时双向同步**：在编辑器中改 MD 会实时刷新 HTML 预览；
在 HTML 中操作（点击、勾选、表单修改）会通过补丁回写到 MD 文件。

## 一、架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  agent 实例目录 .sarosisworkspace/agents/{slug}/                     │
│   ├── agent.yaml         (configMd 配置)                             │
│   ├── config.md          ★ 数据源（用户/Agent 都可读写）             │
│   └── ui/                                                            │
│        ├── parser.js     (可选: 自定义 MD→HTML 解析器)               │
│        └── styles.css    (可选: 注入到预览的 CSS)                    │
└──────────────────────────────────────────────────────────────────────┘
                            ↑↓ FileWatcher
┌──────────────────────────────────────────────────────────────────────┐
│  Host: ConfigMdService                                               │
│   • Parser  (内置 marked-like / 加载 parser.js)                      │
│   • Patcher (replace-anchor / replace-bind / append / ...)           │
│   • Watcher (响应外部 .md 修改)                                      │
└──────────────────────────────────────────────────────────────────────┘
                            ↕ postMessage
┌──────────────────────────────────────────────────────────────────────┐
│  Webview: ConfigMDPanel                                              │
│   ┌──────────────────┬──────────────────┐                            │
│   │ Markdown 编辑器  │ HTML 预览(iframe)│                            │
│   │ (textarea)       │ + SDK 注入       │                            │
│   └──────────────────┴──────────────────┘                            │
└──────────────────────────────────────────────────────────────────────┘
                            ↕
                          Model
```

## 二、配置（在 `agent.yaml` 中）

```yaml
configMd:
  mdPath: config.md             # 必填，相对 agentDir
  parserPath: ui/parser.js      # 可选，自定义解析器
  stylesPath: ui/styles.css     # 可选，注入到预览的 CSS
  displayMode: side             # side | replace | tab
  defaultView: split            # split | preview | source
  editable: true
  syncDebounceMs: 300
  sandboxLevel: strict          # strict | standard | permissive
  capabilities:
    - md.read
    - md.write
    - chat.send
```

不配置 `capabilities` 时默认允许：`md.read / md.write / chat.send / chat.history / agent.status / agent.config`。

## 三、MD 中的"语义锚点"

内置解析器识别两种锚点，HTML 端可定向修改：

### 1. 块级锚点 — `agent-state`

```markdown
# 任务清单

<!-- agent-state:tasks -->
- [ ] 任务 A
- [x] 任务 B
- [ ] 任务 C
<!-- /agent-state:tasks -->
```

渲染为 `<div data-agent-state="tasks">…</div>`，用于整体替换该块内容。

### 2. 内联锚点 — `agent-bind`

```markdown
进度：<!-- agent-bind:progress -->33%<!-- /agent-bind:progress -->
```

渲染为 `<span data-agent-bind="progress">33%</span>`，用于替换内联文本。

## 四、HTML 端 SDK 用法

内置解析器渲染的预览中已**自动注入** `AgentConfigMd`，外加全局 `window.agent` 引用。

```html
<button id="confirm">确认</button>
<script>
  // 已自动 connect，可直接通过 window.agent 使用
  document.getElementById('confirm').onclick = () => {
    agent.sendEvent('user.confirm', { value: 1 });   // → 触发 chat 消息给 model
  };

  // 监听 model 推送的指令
  agent.on('command', (cmd) => {
    if (cmd.name === 'highlight') { /* ... */ }
  });

  // 监听 MD 内容变化（不论来源：editor / model / external / html）
  agent.on('sync', ({ markdown, version, origin }) => {
    console.log('md updated by', origin, 'v', version);
  });

  // 主动改 MD
  await agent.applyPatch([
    { op: 'replace-anchor', anchor: 'tasks', content: '- [x] all done' }
  ]);

  // 或读 / 写整个文件
  const { markdown } = await agent.readMd();
  await agent.writeMd(markdown + '\n\n## 新增章节\n');

  // 通知
  agent.notify('已保存', 'success');

  // 直接给 model 发消息
  agent.chatSend('请优化任务列表', { showInChat: false });
</script>
```

如果使用**自定义解析器**且要使用 SDK，需要在 HTML 中显式引入：

```html
<script src="agent-configmd-sdk.js"></script>
<script>
  AgentConfigMd.connect().then((agent) => { window.agent = agent; });
</script>
```

## 五、Model 控制 MD（特殊代码块协议）

Model 在回复中嵌入特殊代码块即可修改 MD 或向 HTML 推送指令：

### `configmd-patch` — 修改 MD

````markdown
```configmd-patch
[
  { "op": "replace-anchor", "anchor": "tasks",
    "content": "- [x] 任务 A\n- [x] 任务 B\n- [x] 任务 C" },
  { "op": "replace-bind", "anchor": "progress", "content": "100%" }
]
```
````

支持的 `op`：
- `replace-anchor` — 替换 `agent-state:NAME` 块的 body
- `replace-bind` — 替换 `agent-bind:NAME` 内联文本
- `replace-section` — 按标题替换章节（`heading: "任务清单"`）
- `append` — 追加到末尾
- `prepend` — 在头部插入
- `replace-all` — 整文件替换

### `configmd-command` — 给 HTML 发指令

````markdown
```configmd-command
{ "name": "highlight", "params": { "selector": "#confirm" } }
```
````

HTML 端通过 `agent.on('command', ...)` 接收。

## 六、自定义解析器（`ui/parser.js`）

```javascript
// CommonJS 风格
module.exports = {
  parse(markdown, ctx) {
    // 返回 HTML 字符串
    return `<div class="custom">${markdown}</div>`;
  },
};

// 或 ES 风格
exports.default = {
  parse(markdown, ctx) { /* ... */ },
};
```

- 解析器在 Host 进程的隔离作用域中运行（`new Function`）
- `ctx.employeeId` 可用
- 输出会经过基础 sanitize（去除 `<script>`、`on*=` 等）
- iframe sandbox 是真正的安全防线

## 七、同步机制

| 变更来源 | 触发 | 同步路径 |
|---------|------|----------|
| 编辑器输入 | textarea onChange (debounced) | → `writeSource(origin: 'editor')` → 解析 → 推送 HTML |
| HTML 操作 | SDK `applyPatch` / `writeMd` | → `applyPatch(origin: 'html')` → 解析 → 推送 MD/HTML |
| 外部编辑 | `.md` 文件被改（VSCode/外部） | FileWatcher → 解析 → 推送 MD/HTML |
| Model 输出 | 含 `configmd-patch` 块 | → `applyPatch(origin: 'model')` → 解析 → 推送 MD/HTML |

**防回环**：每次 Host 自身写入会在 `pendingWriteOrigin` 标记，文件监听器跳过下一个事件。

**乐观并发**：`writeSource` / `applyPatch` 接受 `baseVersion`，版本不匹配时拒绝（避免覆盖未读到的更新）。

## 八、能力清单

| Capability | 说明 |
|-----------|------|
| `md.read` | 读 MD 文件 |
| `md.write` | 写 MD 文件 / 应用 patch |
| `chat.send` | 触发给 model 发消息 |
| `chat.history` | 读 chat 历史 |
| `agent.status` | 读 agent 状态 |
| `agent.config` | 读 agent 配置 |
| `notification` | 显示通知 |
| `clipboard` | 剪贴板访问 |

未在 `capabilities` 中列出但属于默认集合的能力依然允许；显式列出后则白名单化。

## 九、目录结构

```
src/vs/sessions/contrib/agentStudio/
├── browser/
│   ├── configMdService.ts            ★ Host 服务实现
│   └── agentStudioWebviewController.ts (路由 configmd.*)
├── webview/src/
│   ├── features/configmd/
│   │   ├── ConfigMDPanel.tsx         ★ 双视图组件
│   │   ├── configMdBridge.ts         ★ iframe ↔ Host 桥
│   │   └── agent-configmd-sdk.js     (独立 SDK 文件)
│   ├── store/useConfigMdStore.ts
│   └── styles/configmd.css
└── common/agentStudio.ts             (re-export)

src/vs/sessions/common/
├── agentStudioTypes.ts                (AgentConfigMd / ConfigMdCapability)
└── agentStudioService.ts              (IConfigMdService)
```
