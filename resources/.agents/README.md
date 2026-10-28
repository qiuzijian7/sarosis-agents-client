# `resources/.agents/` 是**产物**，不要直接改

这里的 `agents/<id>/.agent.md` 由宿主在启动时**生成**（`agentMdFormat.ts` 的 `buildAgentMd()`），
数据来源是代码里的真源：

```
src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts
  └─ 每个条目：systemPrompt / tools / skills / suggestions / icon / …
```

## 为什么写这个说明

2026-10-27 重构内置 agent 提示词时，我直接改了这里的 `.agent.md`，跑守卫全绿、
报告数字也好看 —— 但**完全不生效**：下次启动就被真源重新生成覆盖了。
真源里那 19 个 `systemPrompt` 一字未动。

## 正确的改法

| 想改什么 | 改哪里 |
|---|---|
| 提示词正文 | `builtinAgents.ts` 的 `systemPrompt`（模板字符串：反斜杠 / 反引号 / `${` 都要转义） |
| 工具白名单 | `builtinAgents.ts` 的 `tools`（**必须是 dsh 真名**，写错 ⇒ allowlist 静默失效/agent 变哑巴） |
| 欢迎卡建议词 | `builtinAgents.ts` 的 `suggestions`（接口里已有该字段，`buildAgentMd` 会序列化） |
| 自定义 agent | `<数据根>/agents/<id>/.agent.md`（这个**是人写的**，不会被覆盖；`source: custom`） |

## 改完怎么验

```bash
# 一条命令全查（推荐）：结构守卫 + 产物一致性 + 工具名单 + 真源编译
npm run check:agents

# 只想重新生成产物（改了 builtinAgents.ts 就必须做，否则 singleSource ③ 会红）
node dsh-plugins/scripts/gen-builtin-agent-md.mjs          # 写盘
node dsh-plugins/scripts/gen-builtin-agent-md.mjs --check  # 只比对（退出码 1 = 有漂移）

# 单条守卫（都只读真源）
node dsh-plugins/check-agent-prompts.mjs   # 三段约束 / 建议词 / 判据 / 工具锚点 / 模糊词
node dsh-plugins/check-agent-tools.mjs     # tools/skills 是否都是 dsh 真名
```

> `npm run check:agents` 已挂进 `npm run check:dsh-plugins` 链尾（快检模式：结构守卫 + 产物一致性，约 0.5s）。
> 它存在的理由：2026-10-27 我三次踩坑都是"少跑一条检查"—— 忘了重生成产物、忘了 transpile、守卫自己写错比较字段。

> `gen-builtin-agent-md.mjs` 走的是**和宿主同一条路径**（esbuild 打包 `getBuiltinAgents()` + `buildAgentMd()`），
> 不是手写模板 —— 否则会多出第二份"生成规则"真源。
> 注意它只比 `name / description / systemPrompt / skills / tools` 五个字段：
> `createdAt/updatedAt` 每次生成都是当前时间，比整段文本会永远"漂移"。

两条守卫都**只读 `builtinAgents.ts`**，不读本目录 —— 这是有意的：
守产物等于守了个寂寞。
