# 新节点模板（两处同步清单）

复制下面两段，替换 `<...>`，并确保 **a 与 b 的 inputs/outputs/widgets 三项完全一致**。

## a) registry.ts — registerSarosNodes() 末尾

```ts
// ── 新增节点：<一句话用途> ──
registerNodeSpec({
  type: 'Saros.<MyNode>',                 // 必须含 "."（validateNodeSpec 要求）
  kind: 'native',                         // Saros 自研统一 native；schema 节点另走 registerSchemaLiteGraphNode
  title: '<我的节点>',
  category: 'saros',
  inputs:  [{ name: 'in',  type: 'SAROS_JSON' }],
  outputs: [{ name: 'out', type: 'SAROS_JSON' }],
  widgets: [{ name: 'myParam', type: 'STRING', default: '' }],
  color: SAROS_NODE_COLORS.<myNode>,
});
```

并在同文件 `SAROS_NODE_COLORS` 对象加一项（单一真源）：
```ts
export const SAROS_NODE_COLORS = {
  // …既有
  <myNode>: '#4f9dff',   // 选一个未占用的色值
};
```

## b) sarosLiteGraphNodes.ts — NODE_CONFIGS（在注释块之前追加）

```ts
{
  type: 'Saros.<MyNode>', title: '<我的节点>', color: SAROS_COLORS.<myNode>,
  inputs:  [{ name: 'in',  type: 'SAROS_JSON' }],
  outputs: [{ name: 'out', type: 'SAROS_JSON' }],
  widgets: [{ type: 'text', name: 'myParam', value: '' }],  // type 仅 text|toggle|button
},
```

> **widget 初值字段名差异（重要）**：a 段 spec 用 `default`（如 `default: ''`），b 段
> LiteGraph 端用 `value`（如 `value: ''`）。两者是**不同字段**，不是同一字段。
> 端内运行时取值逻辑（`sarosLiteGraphNodes.ts` ~132 行）：
> `const current = this.properties?.[w.name] ?? w.value;`
> 即 **优先 `properties[name]`，回退 `w.value`**。所以"预填初值"应走
> `properties`（运行时态），`value` 只是 spec 端静态回退值；聊天卡预览若要预填，
> 也通过 `node.properties[w.name] = v`（`mountNodePreview` 的 `initialProps` 正是这么做的）。

## 一致性自检表（提交前逐条勾）

- [ ] a 的 `inputs[].name/type` 与 b 的 `inputs[].name/type` 逐项相同
- [ ] a 的 `outputs[].name/type` 与 b 的 `outputs[].name/type` 逐项相同
- [ ] a 的 `widgets[].name` 与 b 的 `widgets[].name` 逐项相同（a 用 `type:'STRING'`，b 用 `type:'text'`）
- [ ] 未改 `Saros.IfElse`/`Saros.Switch` 的分支端口名（true/false/case-*/default）
- [ ] 颜色只来自 `SAROS_COLORS`（未在 b 硬编码十六进制）
- [ ] 若该节点是 schema 节点（kind:'schema'）：**不要**在 b 重复声明，避免 `registerNodeType` 后写覆盖
- [ ] `npx tsc --noEmit` 通过
