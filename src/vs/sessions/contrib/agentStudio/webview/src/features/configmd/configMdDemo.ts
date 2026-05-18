/*---------------------------------------------------------------------------------------------
 *  ConfigMD demo — a self-contained Markdown sample that exercises every feature
 *  the built-in parser supports. Used by the "Demo" button in the ConfigMD toolbar
 *  to populate the editor with a fully-renderable sample.
 *--------------------------------------------------------------------------------------------*/

export const CONFIG_MD_DEMO = `# 🎯 ConfigMD 演示样例

> 这是一个内置的 Markdown 演示样例，可直接被默认解析器解析为 HTML。
> 修改任意内容，左右两侧将实时同步更新。

---

## 1. 进度概览

当前进度：<!-- agent-bind:progress -->45%<!-- /agent-bind:progress -->

> 上方 \`<!-- agent-bind:progress -->\` 是**内联绑定锚点**，  
> Model 可通过 \`replace-bind\` 操作直接更新数值。

---

## 2. 任务清单

<!-- agent-state:tasks -->
- [x] 收集行业研究报告
- [x] 整理关键数据指标
- [ ] 撰写竞品分析章节
- [ ] 输出最终报告 PDF
- [ ] 提交评审会议
<!-- /agent-state:tasks -->

> 上方任务清单使用 \`<!-- agent-state:tasks -->\` 锚点包裹，  
> Model 可通过 \`replace-anchor\` 整体替换其内容。

---

## 3. 关键发现

### 3.1 市场规模

- 全球 AI 编辑器市场规模：**约 38 亿美元**（2026）
- 年复合增长率：*27.5%*
- 主要驱动因素：\`生产力工具\` 与 \`代码生成\` 双轮驱动

### 3.2 主要竞品

1. GitHub Copilot
2. Cursor
3. Codeium
4. JetBrains AI Assistant

### 3.3 引用与代码

> "AI 辅助编程已成为开发者标配，未来 5 年渗透率将超过 80%。" —— Gartner 2026

\`\`\`typescript
// 调用研究 API 的示例
async function fetchMarketData(query: string) {
  const result = await researcher.search(query);
  return result.summarize({ format: 'markdown' });
}
\`\`\`

---

## 4. 互动控件

<!-- agent-state:controls -->
<div class="demo-controls">
  <button type="button" data-event="refresh-data">🔄 刷新数据</button>
  <button type="button" data-event="export-report">📤 导出报告</button>
  <button type="button" data-event="ask-model">💬 询问 Model</button>
</div>
<!-- /agent-state:controls -->

> HTML 中的按钮通过 SDK 把事件回传给 Agent，  
> Agent 在响应中以 \`configmd-patch\` 块更新本 MD 文件。

---

## 5. Agent 输出协议

Model 在回复中输出代码块即可控制本面板：

\`\`\`configmd-patch
{
  "op": "replace-bind",
  "anchor": "progress",
  "content": "78%"
}
\`\`\`

支持的操作：

- \`replace-anchor\` — 替换 \`agent-state:NAME\` 块内容
- \`replace-bind\` — 替换 \`agent-bind:NAME\` 内联值
- \`replace-section\` — 按标题替换章节
- \`append\` / \`prepend\` — 追加 / 前置文本
- \`replace-all\` — 整体覆盖（最后手段）

---

## 6. 资源链接

- [飞书项目](https://www.feishu.cn)
- [VSCode 文档](https://code.visualstudio.com/docs)

---

*本面板由 ConfigMD 渲染。修改 MD 即修改 UI。*
`;
