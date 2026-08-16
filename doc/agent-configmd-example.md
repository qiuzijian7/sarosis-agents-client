# ConfigMD 样例工程

完整可预览的样例，已就绪于 **Researcher** Agent。重新加载窗口后选中 Researcher 即可看到右侧的 ConfigMD 面板。

## 文件清单

```
.sarosisworkspace/
└── agents/
    └── researcher-nlmniq3/
        ├── agent.yaml          # 包含 configMd 配置块
        ├── config.md           # 数据源（MD）
        └── ui/
            ├── parser.js       # 自定义 MD→HTML 解析器
            └── styles.css      # 自定义预览样式
```

## 体验路径

1. **重新加载窗口**（Ctrl+R 或 `Developer: Reload Window`）
2. 在 Workspace 中选中 **Researcher** 节点
3. 右侧 ConfigMD 面板会自动展开，并排显示：
   - **左侧**：带行号 + 语法高亮的 MD 编辑器
   - **右侧**：通过自定义 parser + styles 渲染的 HTML 预览
4. 在编辑器中修改 `# 当前进度` 部分的 `45%` → 预览实时更新
5. 点击预览中的「🔄 刷新数据 / 📤 导出报告 / 💬 询问 Model」按钮 → 触发 chat 事件
6. 点击工具栏 **⚙ 配置** 按钮 → 可以重新上传 parser.js / styles.css，或恢复内置解析器

## 样例特性展示

| 特性 | 在样例中的体现 |
|------|------|
| 自定义 parser.js | `ui/parser.js` — 处理标题、列表、待办、引用、代码块 |
| 自定义 styles.css | `ui/styles.css` — 渐变标题、紫色徽章进度条、卡片化任务列表 |
| 语义锚点 `agent-state` | `## 2. 任务清单` 被 `<!-- agent-state:tasks -->` 包裹 |
| 内联绑定 `agent-bind` | `## 1. 当前进度` 中的 `45%` 被 `<!-- agent-bind:progress -->` 包裹 |
| HTML 互动控件 | `## 4. 互动控件` 中的 3 个按钮，data-event 触发 |
| 待办列表 | `## 2. 任务清单` 中的 `- [x] / - [ ]` 渲染为复选框 |
| 代码块 | `## 3.3 引用与代码` 中的 TypeScript 代码块 |
| 链接 / 引用 / 列表 | 第 3、5、6 节展示 |

## 关键代码片段

### agent.yaml 中的 configMd

```yaml
"configMd": {
  "mdPath": "config.md",
  "parserPath": "ui/parser.js",
  "stylesPath": "ui/styles.css",
  "displayMode": "side",
  "defaultView": "split",
  "editable": true,
  "sandboxLevel": "standard",
  "autoShow": true,
  "syncDebounceMs": 300,
  "capabilities": [
    "md.read", "md.write",
    "chat.send", "chat.history",
    "agent.status", "notification"
  ]
}
```

### Model 通过补丁修改进度

回复中输出：

````markdown
```configmd-patch
{
  "op": "replace-bind",
  "anchor": "progress",
  "content": "78%"
}
```
````

→ Host 解析后会把 MD 中 `<!-- agent-bind:progress -->45%<!-- /agent-bind:progress -->` 替换为 `<!-- agent-bind:progress -->78%<!-- /agent-bind:progress -->`，并在 0.3 秒内推送新 HTML 到 webview。

### Model 通过补丁更新任务清单

````markdown
```configmd-patch
{
  "op": "replace-anchor",
  "anchor": "tasks",
  "content": "- [x] 收集行业研究报告（10 份）\n- [x] 整理关键数据指标\n- [x] 撰写竞品分析章节\n- [ ] 输出最终报告 PDF\n- [ ] 提交评审会议"
}
```
````

## 自定义解析器约定

`ui/parser.js` 必须导出：

```javascript
{
  parse: (markdown, ctx) => string,           // 必需
  applyHtmlPatch: (md, patch, ctx) => string, // 可选
  directives: ['agent-state', 'agent-bind'],  // 可选
}
```

支持以下导出方式之一即可：

- `module.exports = { parse, ... }`
- `module.exports.default = { parse, ... }`
- IIFE 中给 `self.module.exports` 赋值（浏览器风格）

如果 `parse` 缺失或抛出错误，host 会自动回退到内置解析器。

## 复用到其他 Agent

把 `config.md`、`ui/parser.js`、`ui/styles.css` 复制到目标 agent 目录，
并在该 agent 的 `agent.yaml` 中加入 `configMd` 配置块即可。
