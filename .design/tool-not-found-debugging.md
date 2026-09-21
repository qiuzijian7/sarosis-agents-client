# 「某工具找不到」五层排查手册

> 适用症状：模型说"没有 X 工具"、调用报 `Tool not found` / `Tool "x" not found`、
> 或某工具"明明实现了却永远不被调用"。
>
> 动机（2026-09-21，unreal_* 事故）：这类问题最毒的地方是**静默**——实现、注册都在，
> 但链条中间某一层断了，全程零报错。本手册按调用链从上往下排查，**每层一条判据**，
> 定位到层即定位到修法。目标是把定位时间从"翻日志"压到"看一眼"。

## 调用链总览

```
① 实现     providers/tool/<x>Tools.ts          有 handler 吗？（没有 = 半成品）
② 注册     builtinToolProvider._register*()     注册函数被调用吗？
③ 归类     toolsetConfig.getToolsetForTool()    落进哪个 toolset？（落 utility = 高危）
④ 收窄     focus 模式 / enabledToolsets          当前工作区/agent 配置会裁掉它吗？
⑤ 桥接目录  assembleToolDefs → deferredDefs      被裁的 deferrable 工具进目录了吗？
   （UI 分发  agentChatPanel.toolCards.ts        渲染问题，不影响模型可见性）
```

---

## ① 实现层 —— "这工具有 handler 吗"

**判据**：`providers/tool/` 下有 `<x>Tools.ts` 且导出 `register*Tools`，且注册时不是 stub
（stub = bundled 表里有定义但无 handler，`listTools` 会跳过 stub ⇒ 模型看不到）。

**信号**：日志 `[BuiltinTools] getAllToolDefinitions: N tools (skipped M stubs …)` ——
M>0 且你想找的工具在 stub 里 ⇒ 半成品（只有定义没有 handler）。

**修法**：补 `register*Tools` 真实实现，并放在 `_registerBundledTools()` **之前**调用
（否则 bundled 先注册成 stub；历史半成品：image_generate / drawio / vision_analyze /
video_generate / text_to_speech / cronjob / session_search —— 都是这个模式，见
`builtinToolProvider.ts` 构造函数里的一串 ★ 注释）。

## ② 注册层 —— "注册函数被调用了吗"

**判据**：`builtinToolProvider` 构造函数里有 `this._register*Tools()` 的调用点。

**信号**：没有。这是静默的 —— 没调用就什么都没发生。（unreal_* 曾在此断裂：
`unrealTools.ts` 实现了两年没人调用。）

**修法**：加一行 `this._register*Tools()`（注意与 `_registerBundledTools()` 的先后，
见①的 stub 说明）。

**守卫**：`test/browser/toolRegistrationWiring.test.ts` ④（注册入口漏接会被拦）。

## ③ 归类层 —— "落进了哪个 toolset"（**unreal 事故的断点**）

**判据**：`getToolsetForTool('x')` 的结果。落进 **`utility`**（兜底桶）≈ 高危 ——
`utility` 不在 focus 推荐集里，下一步会被整条裁掉。

**信号**（★ 2026-09-21 新增，之前是**零信号**）：
启动时 `[BuiltinTools] ⚠ 归类自检：N 个已注册工具落进 utility 兜底桶 … [名字列表]`（warn）。
看到它 ⇒ 某个工具"注册了但不可见"几乎必然是它。

**修法**：在 `toolsetConfig.ts` 给它登记**独立 toolset**（前缀或 exactNames），
priority 视场景：
- 用户显式意图（生成媒体/驱动编辑器）→ **Always**（focus 豁免）；
- 代码类 → Medium/deferrable（进桥接目录）；
- **不要**靠加进 `UTILITY_BUCKET_WHITELIST` 掩盖（白名单只给"本就不想直发"的工具用，
  如 `transfer_to_agent`）。

**守卫**：`toolRegistrationWiring.test.ts` ①（utility 桶钉）+ `toolsetClassification.test.ts`。

## ④ 收窄层 —— "focus 模式 / enabledToolsets 会裁掉它吗"

**判据**：focus 模式（代码工作区几乎必触发）的 Step3a 只保留「推荐 toolset ∪ 桥接 ∪
CORE_TOOLS ∪ **Always** toolset」。`enabledToolsets`（agent 配置）同理是白名单收窄。

**信号**：日志 `[AgentOS] _getEnabledTools: focus mode auto-applied […] -> N/M tools`
—— N<M 说明发生了裁切；看你想要的工具的 toolset 在不在 `[…]` 里。

**关键机制**（反直觉）：focus 过滤发生在 assembly **之前** ⇒ 被裁的 deferrable 工具
**连桥接目录都进不去**（≈真不可见，不只是"要搜一下"）。

**修法**：把它的 toolset 加进 `focusMode.ts` 的 `CODING_FOCUS_TOOLSETS`，或提为 Always；
若 agent 配了 `enabledToolsets`，往白名单里加该 toolset。

**守卫**：`toolRegistrationWiring.test.ts` ②（「真不可见」= 被裁 ∧ 不可折叠 ∧ 非 Always）。

## ⑤ 桥接目录层 —— "tool_search 能找到它吗"

**判据**：`assembleToolDefs` 的 `deferredDefs` 里有它（catalog 由它构建）。

**信号**：日志 `[AgentOS] _getEnabledTools: Tool Search activated — N deferred …`；
`tool_describe "x"` 返回 schema（而非 `not found`）⇒ 在目录里。

**注意**：`tool_describe` 对**直发**（core/Always）工具有兜底（`toolSearchDispatcher.ts:258`），
所以"describe 找不到"≠"工具不存在"——先看①-④。

## UI 分发层（渲染问题，不影响模型可见性）

症状：工具**能被调用**但卡片是通用形态/难看。这不是"找不到"。

**判据**：`agentChatPanel.base.ts` 的 `TOOL_*_TOOLS` 集合里有没有这个名字
（分发 key 是**小写归一**的 —— `toolCards.ts:608`）。

**修法**：把名字加进对应集合。**名单必须与注册名单逐一对齐**（unreal 的第二层 bug：
UI 名单与注册名单脱节）。守卫：`unrealToolCard.test.ts` ③（名单一致性）。

---

## 一句话速查

| 症状 | 先怀疑哪层 |
|---|---|
| 日志有 `⚠ 归类自检` warn | ③（拿到名字直接改 toolsetConfig） |
| `focus mode auto-applied -> N/M` 且 N<M | ④（看 toolset 在不在推荐集） |
| `tool_describe` 报 not found | ③ 或 ④（先看归类，再看 focus） |
| 工具能被调但卡片是通用形态 | UI 分发层（TOOL_*_TOOLS 名单） |
| `getAllToolDefinitions` 里 stubs>0 且含它 | ①（半成品：只有定义没有 handler） |
| 完全无迹 | ②（注册函数没被调用 —— 静默） |
