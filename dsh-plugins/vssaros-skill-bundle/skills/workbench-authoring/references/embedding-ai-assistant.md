# 工作台内嵌 AI 助手

## 一句话

**助手不是"调模型"，而是宿主注入的一个 React 节点 `props.conversation`**（官方 chat-surface 本体：会话列表、输入框、流式回复、工具卡片全在里面）。
查 `ctx.models` / `ctx.chat` 查不到，不代表做不到 —— 那是方向错了。

## 三个前置条件

1. 描述符 `customFrame: true` —— 只有它为真，宿主才注入 `props.conversation`。
2. 渲染它的代码必须在**客户端子块**里（`lib/client.<name>.js`）；SSR 页脚本不在 chunk 装载器里，拿不到 `require` / `ctx`。
3. 使用统一的收起/展开契约（见 `assistant-collapse.md`），不要自创交互。

## 宿主给的是什么

`dsh-plugins/vssaros-workbenches/lib/client.js` 的 `ConversationMount`（约 L436）：

- 结构：一个 `div[data-vssaros-wb-conversation=<id>]` + 内部的 `div[data-vssaros-wb-dock]`（portal 目标）。
- 还没有会话 ⇒ 里面显示「开始对话 / 选择文件夹」；有会话 ⇒ 官方对话 portal 进来。
- 会话绑定用 `service.registerDock(entry.id, element)` 完成，**你只管把它渲染到布局里**。

## 布局

```js
h('div', { style: { display: 'flex', height: '100%' } },
  h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, site or businessUI),
  h('div', { style: { flex: '0 0 auto', width: '6px', cursor: 'col-resize' } }),  // 拖拽条
  h('aside', { style: { flex: '0 0 auto', width: 'min(560px, 52vw)', minWidth: '320px', maxWidth: '70%',
                         display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    conversation),
);
```

`props.conversation` 只能在**一处**渲染（React 同一实例不能重复挂）。

## 让"新建会话"默认选中某个 agent（坑最多）

后端 `agentPresets` 服务只能**动态 inject** 拿到（`ctx.get` 往往返回 `undefined`）：

```js
for (const key of ['agentPresets', 'remote.agentPresets']) {
	try {
		ctx.inject([key], (scope) => {
			const svc = scope[key] || (scope.get && scope.get(key));
			if (svc) { PRESET_API = svc; /* 服务到齐后再切 */ }
		});
	} catch { /* 该服务名不存在，试下一个 */ }
}
```

四个必备点：

1. **服务到齐后再切**：inject 是异步的，面板可能已经在前台 ⇒ 在回调里补一次，别只在挂载时试。
2. **等会话真的建出来再切**：`newSession()` 返回后会话可能还没 ready，用短轮询等 `currentSessionId`，别写死 `setTimeout(300)`。
3. `.agent.md` **不要写 `tools` 白名单**（否则新建的会话工具面可能被收窄到空）。
4. 预设 id 规则：`vssaros-` + slugify(agentId)，例如 `saroasis-studio` → `vssaros-saroasis-studio`。

## 千万不要这样做

| 错误做法 | 后果 |
|---|---|
| 自绘浮层 iframe 当助手 | 两套助手；浮层里的第二份客户端拿不到会话上下文 |
| 把 `document.body` 当挂载点 | 全窗级，切到别的工作台也显示（踩过，用户明确否过） |
| 用定时器轮询"面板在不在屏"来显隐 | 切走后有残留、卸载不同步 |
| 收起时卸载对话节点 | 会话状态 / 滚动位置 / 流式回复全丢 |
| 自己写输入框调模型 | 与官方会话割裂，用户在别处看不到这段对话 |

## 验证清单

- [ ] `data-vssaros-surface="workbench"` 根节点还在
- [ ] 助手栏在展开态能看到输入框；收起后能再展开（状态刷新仍保持）
- [ ] 新建会话后 bot chip 显示的是你期望的 agent
- [ ] 切到别的工作台，右侧不会残留任何助手按钮
- [ ] 拖动分隔条能改宽度，松手后刷新仍是这个宽度
