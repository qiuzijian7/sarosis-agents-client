# 聊天卡 litegraph 预览组件骨架

目标：在聊天工具卡里渲染**真实节点类**的小画布，与工作流画布像素级一致。
复用 `registerSarosLiteGraphNodes()`（已注册的真实 `LGraphNode` 类）与
`comfyNodeStyle` 的 `drawNode`/`drawWidgets` 接管（同一套视觉代码 ⇒ 一致）。

## 组件（TS，放在聊天卡可 import 的位置；需能访问 webview 的 litegraph 包）

```ts
import { LiteGraph, LGraph, LGraphCanvas } from '@comfyorg/litegraph';
import { registerSarosLiteGraphNodes } from
  '../../../contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/sarosLiteGraphNodes.js';
import { applyComfyNodeStyle } from
  '../../../contrib/agentStudio/webview/src/features/workflowEditor/comfyNodeStyle.js';

/** 在 container 内渲染某 Saros 节点的真实 litegraph 预览，返回 dispose。 */
export function mountNodePreview(
  container: HTMLElement,
  nodeType: string,          // 例如 'Saros.MyNode'
  initialProps?: Record<string, unknown>,
): () => void {
  // 无需外层 registered 标志：registerSarosLiteGraphNodes() 内部已幂等
  //（if (registered) return），重复调用安全。
  registerSarosLiteGraphNodes();
  const NodeClass = LiteGraph.getNodeType(nodeType);
  if (!NodeClass) { throw new Error(`未注册的节点类型: ${nodeType}`); }

  const graph = new LGraph();
  const canvas = new LGraphCanvas(container.appendChild(document.createElement('canvas')), graph);
  applyComfyNodeStyle(canvas);              // 走 ComfyUI 风格标题栏/widget 绘制

  const node = new NodeClass();
  if (initialProps) { Object.assign(node.properties, initialProps); }
  graph.add(node);
  // 适配画布尺寸到节点 box，避免留白/裁切
  const [w, h] = node.size;
  canvas.canvas.width = Math.ceil(w);
  canvas.canvas.height = Math.ceil(h + 4);
  canvas.draw();

  return () => { canvas.destroy(); graph.clear(); container.innerHTML = ''; };
}
```

## 接入聊天工具卡 dispatch

在 `agentChatPanel.toolCards.ts` 的 `_createToolCallCardCore`（**private**，约 575 行；
公开的 `_createToolCallCard` 在 461 行只做 override + 追加审批区，真正的 key 分发在
core 内）的现有 `update_plan` / `workflow` 专用卡分支处增加：

```ts
if (key === 'my_node') {            // key 来自 (tc.name||'').toLowerCase()（576 行）
  return this._createMyNodePreviewCard(tc, key);
}
```

> 该 core 第一行即 `const key = (tc.name || '').toLowerCase()`（576 行），分支
> 条件须与工具名小写一致；同方法内各专用卡由 `TOOL_XXX_TOOLS` 这类 Set 持有 key 集合，
> 可仿照新增 `MY_NODE_TOOLS` Set。

`_createMyNodePreviewCard` 内部：`append` 卡片容器 → `this._register({ dispose: mountNodePreview(cardBody, 'Saros.MyNode', tc.args) })`。
用 `this._register` 让面板 `dispose()` 时自动释放 canvas（避免面板销毁后 `requestAnimationFrame` 回调访问已移除 DOM）。

## 测试断言（Playwright / component fixture）

- 聊天卡含 `<canvas>`；其 `width/height` ≈ 该节点 `size`（容差 ±2px）。
- 节点标题文字在画布标题栏渲染（用 `canvas.toDataURL` 或像素采样核对，或与画布截图 diff）。
- 断言 `LiteGraph.getNodeType('Saros.MyNode')` 存在（验证注册链路打通）。

## 注意

- fixture 固定尺寸（默认 900×600）与真实产品窄窗口差异见 `chat-customizations-editor`
  技能的 "Fixture vs real product gaps"；预览卡若在小屏下缩放需加窄尺寸 variant。
- 不要在聊天卡里手抄 DOM 伪节点——那无法随 `comfyNodeStyle` 同步，会漂移。
