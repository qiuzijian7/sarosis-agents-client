# 工作流测试使用指南

> 三层设施，覆盖「逻辑 → 执行 → 渲染」。先看这张表决定该跑哪个。

## 零、统一入口（一个命令进所有面板）

```bash
npm run test-agentstudio-panel
# 或
node src/vs/sessions/contrib/agentStudio/test/browser/test-server.mjs

# → http://127.0.0.1:5600/
```

导航页列出三个面板，点进去即可。**visual harness 会作为子进程自动拉起**，无需再单独起服务。

| 路由 | 面板 | 内容 |
|---|---|---|
| `/` | 导航页 | 两个入口 + 选型建议 |
| `/node` | **测试面板** | 179 个用例，**按功能模块分组**，可单独执行 |
| `/visual/?panel=1` | 节点执行面板 | 223 个节点，勾选后**真跑**执行器 |
| `/visual/canvas/` | **画布沙箱** | 手拖节点 / 拉连线 / 点运行 → 验证新节点的 UI、功能、输入输出、**上下游联动** |

> 节点渲染画廊（892 场景截图基线）已从面板入口移除——它是基线设施而非「用例执行」。
> 命令行仍可跑：`cd src/vs/sessions/contrib/agentStudio/webview && npm run visual:dom`

`/visual/*` 走**反向代理**到 5599（保持同源，harness 的相对路径资源才正常）。
端口可用 `TEST_PANEL_PORT` / `VISUAL_PORT` 覆盖。

## 一、该用哪个？

| 我想验证… | 用什么 | 耗时 |
|---|---|---|
| 纯函数 / 数据契约（JSON 解析、序列化） | **Node 单测** `run-browser-test.mjs` | ~30ms |
| 节点**执行**结果（status / entries / 错误文案） | **沙箱** `createSandbox({mode:'node'})` 或 `--run` | 90ms（全量 223 节点） |
| 节点卡片**长相**（布局、溢出、塌陷） | **画廊** `visual:test` / `visual:dom` | 分钟级（892 场景） |
| 执行后 **UI 是否正确变化** | **执行模式** `visual.spec.mjs --run=fake` | 分钟级（223 节点） |
| 某个节点白屏 / 塌陷，要定位 | **单节点诊断** `--dump=<type>` | 秒级 |

---

## 二、Layer 1：Node 侧逻辑测试

### 跑现有测试

```bash
# 单个文件
node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
     src/vs/sessions/contrib/agentStudio/test/browser/workflowStoryboardExecutor.test.ts

# 换文件即可，路径必须给全（runner 只接一个参数）
```

目录下现有 **179 个** `*.test.ts`（其中 `workflow*.test.ts` 约 62 个），覆盖：数据契约、执行器、resolveBinding、fountain 解析、zipWriter 等。

### ★ 测试面板（按功能模块分类 + 可单独执行）

命令行一次只能跑一个文件，面板解决这个：

```bash
npm run test-agentstudio-panel
# → http://127.0.0.1:5600/node
```

**自动分类**：扫描 `test/browser/*.test.ts`，按文件名关键词归纳到功能模块（**有序**匹配，第一个命中即归类）：

| 模块 | 数量 | 匹配关键词（举例） |
|---|---|---|
| 工作流 | 66 | `workflow*` `comfy*` `dag*` `stage*` |
| 聊天框 | 18 | `chat*` `stream*` `minieditor*` `slashCommands` |
| Agent | 15 | `agent*` `delegation*` `concurrent*` |
| 知识库 | 14 | `kb*` `wiki*` `frontmatter` `pageMerge` |
| 执行 / 终端 | 12 | `exec*` `terminal*` `shell*` `task*` |
| Bridge / LLM | 11 | `bridge*` `llm*` `mcp*` `tof*` |
| 代码库索引 | 11 | `codebase*` `search*` `repoOverview*` |
| 安全 / 沙箱 | 7 | `sandbox*` `*Guard*` `worktree*` `workspace*` |
| 技能 | 7 | `skill*` `newAgentTool` |
| 工具 | 6 | `toolCard*` `toolArgs*` `toolExecution*` |
| 上下文 / 记忆 | 5 | `context*` `memory*` `dedup*` |
| 基础设施 | 5 | `plugin*` `mermaid*` `publish*` |
| 调度 / 定时 | 2 | `cron*` `schedule*` |

> 179 个文件**全部自动归类，「其他」为 0**。新增测试文件无需登记——命名符合上述关键词即自动归位。
> 分类表在 `test-server.mjs` 的 `CATEGORIES`；改关键词时注意**顺序**（特殊模块须在通用模块之前，
> 否则 `agentChatPanel` 会被 `agent` 抢走、`workflowSandbox` 会被 `sandbox` 抢走）。

### 用例级粒度（执行后展开文件行）

执行完点文件行左侧的 **▸** 展开，能看到该文件里**每一条 test** 的名称、状态、耗时；
点**失败用例**会内联展开「错误消息 + diff（红/绿着色）+ 堆栈」。
**有失败时该文件会自动展开**，不用手动点。

| 控件 | 作用 |
|---|---|
| 分组标题 | 折叠 / 展开模块 |
| 文件行 **▸** | 展开该文件的用例列表（每条 test 一行，含 suite 路径 tooltip） |
| 失败用例行 | 点击展开错误详情（diff 红/绿 + 灰化堆栈） |
| 本组全选 / 清空 | 只作用于该模块 |
| 行尾 **▶** | **单独执行这一个文件** |
| 跨组勾选 + 执行选中 | 批量跑（可跨模块，**并发**执行） |
| **并发滑块** | 1–8，默认 4 |
| 进度显示 | 执行中显示 `已完成/总数` |
| 结果筛选 | 全部 / 仅通过 / 仅失败 / 仅未跑 |
| 统计栏 | `文件数 · ✓ 通过 · ✗ 失败 · 用例总数` |

结果通过 **SSE 流式**回传，执行中实时更新。mocha 输出的结构化解析在服务端完成（`parseMocha`）。

**并发实测**（8 个 workflow 文件样本，95 条用例）：

| 并发度 | 耗时 | 加速 |
|---|---|---|
| 1（串行） | 2485ms | — |
| 4 | 869ms | **2.9x** |
| 8 | 540ms | **4.6x** |

> **并发为什么安全**：`execOne` 对每个文件**独立 spawn、独立缓冲** stdout/stderr，
> 多进程同时跑也不会输出交错；结果按**完成顺序**推送，前端按 `file` 定位行更新，与顺序无关。
> 三种并发度下 pass/fail 完全一致（95/0）。

> **解析规则**（`test-server.mjs`）：`✔/✓` = pass、`N)` = fail、`-/◦` = pending；
> 缩进栈维护 suite 层级（支持嵌套，用 `›` 连接）；`N failing` 之后是失败详情区，**按编号**与用例行关联。
> ⚠ suite 行要求 `indent ≥ 2` 且不以 `[` 开头——否则被测代码打到 stdout 的诊断日志（如 `[runStageWorkflow] …`）会被误当成 suite。

### 历史与 flaky

每次执行后并入 `test/browser/.test-history.json`（本地文件，已加入 `.gitignore`）：

- **flaky 判定**：同一用例**最近 5 次**里既有 pass 又有 fail → 标记 ⚡
- **呈现**：顶栏显示 `⚡ N flaky · M 用例已记录`；文件行显示 `⚡N`；用例行显示 `⚡`；筛选支持「⚡ 仅 flaky」
- **清空**：`curl http://127.0.0.1:5600/api/history/clear`（或等 20 次后自动滚动淘汰）

> flaky 与平均耗时是**派生数据**，不落盘（每次请求现算）。每个用例保留最近 20 次、执行汇总保留最近 50 次。
> 这是「无外部依赖的轻量版 Allure 趋势」——不做图表，只回答一个高频问题：**哪些用例不稳定**。

> **为什么串行**：`run-browser-test.mjs` 每次 esbuild 打包 + mocha 执行，并发会抢 CPU 且输出交错；单文件通常 <1s。
> 端口用 `TEST_PANEL_PORT` 环境变量可改（默认 5600，避开 visual 的 5599）。

### 写新测试

用 mocha 的 **tdd UI**（`suite` / `test` 全局可用，无需 import）：

```ts
import * as assert from 'assert';

suite('我的用例', () => {
	test('...', async () => {
		assert.strictEqual(1, 1);
	});
});
```

runner 自动处理：esbuild 打包（`.js` → `.ts`）、注入 `__vssarosBridge` stub、mocha 执行。

**★ 一条硬约束**：动态 `import` 必须写**字面量路径**。

```ts
// ✅ 可以
await import('../webview/src/features/workflowEditor/comfyHost/workflowRun.js');
// ❌ 不行 —— esbuild 静态解析不了，运行时会 ERR_MODULE_NOT_FOUND
const P = '../webview/.../workflowRun.js';
await import(P);
```

---

## 三、Layer 2：沙箱（渲染 + 执行的统一内核）

`webview/visual/runtime.ts` 是**宿主无关**的内核，Node 与浏览器共用同一份。

### Node 侧（只执行，无 DOM）

```ts
import { createSandbox } from '../../webview/visual/runtime.js';

const sb = await createSandbox({ mode: 'node' });

sb.specs          // 223 个节点 spec（registry.getAllSpecs()）
sb.getSpec(type)  // 单个 spec
sb.run(type, values, nodeId?)   // ← 真跑 runNodeOrStage，返回 { status, error, entries }
```

`run()` 会顺带把结果写回 `sb.cardState`（`runState` + `errorMsg`）——浏览器侧据此自动重渲染。

**现成回归**：`test/browser/workflowSandbox.test.ts`（6 tests，全量 223 节点扫描仅 50ms）

```bash
node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
     src/vs/sessions/contrib/agentStudio/test/browser/workflowSandbox.test.ts
```

### 浏览器侧（渲染 + 执行）

```ts
import { createSandbox } from './runtime';
import { mountCard } from './runtimeDom';

const sb = await createSandbox({ mode: 'browser', mountImpl: mountCard });
await sb.mount(host, 'ComfyTV.ImageStage', 'n1');   // 渲染 idle 态
const res = await sb.run('ComfyTV.ImageStage', {}, 'n1');  // 真跑 → UI 自动切 success
```

### 沙箱选项

| 选项 | 作用 |
|---|---|
| `mode` | `'node'`（fetch 返 404）/ `'browser'`（返内联 SVG 假图，截图才稳） |
| `mountImpl` | 浏览器渲染实现；不传则 `sandbox.mount` 不可用 |
| `invoke` | 自定义 `runner.invoke`（假后端就靠它） |
| `strictThrow` | `true` → runner 异常原样抛出；默认收敛为 `status:'error'` |

### ★ 画布沙箱（可手拖节点）

> 🎬 **端到端场景入口**：测试面板（`/node`）顶部有「端到端场景」分组，点「▶ 打开」会在新窗口
> 打开画布并**预置好节点**（如表情包：`?scenario=emoji&backend=comfyui`），用户只需
> 传参考图 → ▶ 运行。场景不参与 mocha 统计；新增场景改 `test-server.mjs` 的 `/api/scenarios`
> + `canvasHost.tsx` 的场景 seed。



开发新节点时最该验证的是「**上下游联动对不对**」。打开一个独立页面，像在 app 里一样拖节点、拉连线、点运行：

```bash
node visual/build.mjs --serve --port=5599
# → http://localhost:5599/canvas/
```

- 双击空白处搜节点；从端口拖出连线；`Ctrl+Enter` 运行全部；卡片 ▶ 单跑
- 工具栏：新建 / 运行全部 / **导出 fixture** / 重置视图 / 清空 / 假后端开关
- 「假后端」勾上才有 OUTPUT 缩略图（无后端时 223 个节点只有 3 个纯文本节点能 success）

**★ 手拖一次 → 录制 → 秒级回归**（这套设施的核心价值）：

```
① 人在浏览器里手拖出一张图
② 点「导出 fixture」→ sandbox-graph.json
③ node visual/canvas.spec.mjs --fixture=sandbox-graph.json   ← 浏览器验收 + 报告
④ Node 侧 runGraph(fixture)                                  ← 秒级回归，无浏览器
```

**自动验收与报告**（LLM 判定链）：

```bash
node visual/canvas.spec.mjs [--fixture=x.json] [--type=ComfyTV.ImageStage] [--values='{...}']
# → visual/dist/canvas/report.json + report.md + screenshot.png
```

`report.json` 结构：

```json
{ "ok": true,
  "graph": { "nodes": [], "edges": [] },
  "run":   { "ok": true, "order": ["n1","n2"],
             "nodes": [{ "id":"n2", "status":"success", "upstreams":["f231…"], "error":null }] },
  "ui":    { "canvasRendered": true, "consoleErrors": [], "pageErrors": [], "screenshot": "…" } }
```

判定：**`run.ok === false` 或 `ui.pageErrors.length > 0` → 有错 → 回改 → 重跑**。
`run.nodes[].upstreams` 非空 = 上下游联动接通（值是上游的 **stageUid**）。

**脚本里操作图**（`window.__canvasSandbox`，供 Playwright / 自动化）：

```js
window.__canvasSandbox.addNode('Saros.Prompt', 200, 150)  // → nodeId
window.__canvasSandbox.connect(a, b, 'output', 'input')   // 与手拖走同一条 store 路径
window.__canvasSandbox.seed(fixture)                      // 载入整张图
window.__canvasSandbox.runAll()                           // 拓扑序执行
window.__canvasSandbox.exportFixture()                    // 导出
window.__canvasReady                                      // 就绪标志（Playwright 等它）
```

**三种后端模式**（URL 参数 `?backend=`，工具栏徽标显示当前模式）：

| 模式 | 行为 | 用途 |
|---|---|---|
| `fake`（默认） | fakeRunner 确定性假图 | UI / 联动 / 截图，离线可跑 |
| `comfyui` | **真后端**：真实 fetch 直连本地 ComfyUI（`?comfyBase=` 默认 8188），POST /prompt + 轮询 /history，与真实 app **同一条 HTTP 通道** | 真出图验证（需 ComfyUI 运行中 + 模型就绪） |
| `provider` | provider 渠道走 `sendImageGen` **录制回放** | 独立页面无 VS Code 主进程，bridge 不可用；能核对请求体 + 回放下游链路 |

**参考图注入**（走 AssetReferences 的 override 语义：`values['comfytv_image_refs']`，
钉住的资产**优先于**同 slot 的上游连线）：

- 工具栏「📎 参考图」文件选择器 —— 人工点选；Playwright `setInputFiles` 即「本地文件路径加载」
- 图片文件直接**拖进画布** → 注入当前选中节点
- API：`window.__canvasSandbox.injectImage(nodeId, dataUrl, slot=0, kind='image')`
- 同 slot+kind 为**替换**语义（重复注入覆盖上一张）

**provider 渠道**：`sendImageGen` **始终注入**（走不走由节点 `values.backend` 决定，与 URL 模式无关）。
每次实际调用记录在 `window.__providerCalls`，工具栏「导出调用」→ `provider-calls.json`——
用它可以核对「选了 provider/model 之后请求体拼装是否正确」。回放命中 → 用录制结果继续走下游
（抠像 / 拼贴 / GIF 化）；未命中 → 节点报「未返回图片」，**根因（没载录制）打在控制台**。

表情包节点真后端验证示例：

```
# 1) 打开 http://127.0.0.1:5600/visual/canvas/?backend=comfyui
# 2) 双击搜「静态表情包」建节点 → 📎 传参考图 → 填 prompt → backend 选 comfyui
# 3) ▶ 运行全部 —— 真实提交到 ComfyUI 8188 并轮询出图
```

> ⚠ 两个易错点：
> 1. **读卡片状态要用 `canvas.stageUidOf(nodeId)`** —— 运行链路上快照归档键是 **stageUid**，
>    拿 nodeId 读会得到 `idle`。「写 stageUid、读 nodeId」正是历史上「跑成功但 OUTPUT 不刷新」的根因。
> 2. **新建节点的 `data` 只是 `defaultDataForType`**，多数节点要先 `updateNodeData` 填输入
>    （如 Prompt 节点要 `prompt`），否则一跑就报「缺少文本」。

---

## 四、Layer 3：visual 可视化测试

先 `cd src/vs/sessions/contrib/agentStudio/webview`。

### 画廊模式（看长相）

```bash
npm run visual:dom        # 只跑 DOM 断言（R1–R16），跳过截图 —— 快，改代码后首选
npm run visual:test       # 断言 + 与基线比对（要 baseline 已生成）
npm run visual:baseline   # （重新）生成基线
npm run visual            # 起服务手动浏览 → http://localhost:5599/
```

常用参数：

```bash
node visual/visual.spec.mjs --only=ComfyTV.ImageStage          # 只跑一个节点
node visual/visual.spec.mjs --no-shot --only=ComfyTV.ImageStage
```

**892 个场景** = 223 节点 × 4 状态（idle / running / success / error）。
注意：这些状态是「手工塞假图 + 设 runState」**模拟**的——测的是长相，不是行为。

### 单节点诊断（定位白屏最快）

```bash
node visual/visual.spec.mjs --dump=ComfyTV.MaterialStage:success
```

打印：DOM 树（带尺寸）、innerText、**textarea/input 的真实 value**（受控组件 dump 会漏这个，必须显式取）、iframe 参考卡、浏览器 console/pageerror。

### 执行模式（看行为）

```bash
node visual/visual.spec.mjs --run          # 无后端：3 success / 220 error
node visual/visual.spec.mjs --run=fake     # 假后端：182 success / 41 error
node visual/visual.spec.mjs --run=fake --only=ComfyTV.ImageStage
```

223 个节点逐个**真跑**执行器，断言：

| 规则 | 内容 |
|---|---|
| R17 | 执行能就绪（无 fatal） |
| R18 | `idle → status`（UI 确实被真执行驱动） |
| R19 | success → `entries > 0`（空产物 = OUTPUT 塌陷） |
| R20 | error → 错误文案非空（否则 UI 上一条空横幅） |
| R21 | 卡片高度 ≥ 24px（未塌陷） |
| R22 | 产出 image 快照 → OUTPUT 区必须有 `<img>` |

**为什么需要 `--run=fake`**：无后端时只有 3 个纯文本节点能 success，OUTPUT 区渲染根本测不到。假后端让 `runner.invoke` 返回确定性 outputs，success 覆盖率从 1.3% → **82%**。

### 手动在浏览器里看执行

```
http://localhost:5599/?run=1              # 无后端执行
http://localhost:5599/?run=fake           # 假后端执行
http://localhost:5599/?run=fake&only=ComfyTV.ImageStage
```

页面会渲染单卡片并执行，`<body>` 上带 `data-vt-run-*` 属性（F12 可查）。

### ★ 测试面板（可视化勾选 → 批量执行）

命令行只能「全量」或「单个」，想挑几个跑就得来回改参数。面板解决这个：

```
http://localhost:5599/?panel=1
```

界面能力：

| 控件 | 作用 |
|---|---|
| 搜索框 | 按节点名实时过滤（如输 `Storyboard` → 3 个） |
| 全选 / 全不选 | 批量勾选 |
| 假后端 checkbox | 勾选后 `runner.invoke` 返回确定性 outputs（让 success 路径可跑） |
| 执行选中 | 只跑勾选的节点，逐行实时更新状态 |
| 结果筛选 | 全部 / 仅成功 / 仅失败 / 仅未跑 |
| 统计栏 | `已跑 / 总数 · ✓ 成功 · ✗ 失败` |

每行显示：`节点名 | 状态徽章 | 条目数 · 耗时 · 错误文案`，左侧色条按结果着色
（绿=success / 红=error / 紫=FATAL / 灰=未跑）。

**典型用法**：搜 `Storyboard` → 勾 3 个 → 点执行 → 立刻看到哪个节点产出为空、哪个报什么错。

> 与 `--run=fake` 关系：面板是它的**交互式版本**，共用同一份 `runtime.ts`；
> 批量回归用命令行，临时挑几个排查用面板。

---

## 五、改了代码，该跑什么？

| 改动 | 最小验证 |
|---|---|
| 纯函数 / 数据契约 | 对应的 `workflow*.test.ts` |
| 某个执行器 | `workflowSandbox.test.ts` + `visual.spec.mjs --run --only=<该节点>` |
| 节点卡片 UI（nodeCard / stageCardRegistry） | `visual:dom`（892 场景断言） |
| registry 新增/改节点 | `visual:dom` + `visual:baseline`（场景数会变，需重生成基线） |
| 写回键 / snapshotKey 相关 | `--run=fake`（R22 专抓缩略图不显示） |
| **开发新节点**（UI + 功能 + 输入输出 + 联动） | 画布沙箱手拖验证 → 导出 fixture → `canvas.spec.mjs --fixture=…` |
| **上下游数据流**（联动通不通） | 画布沙箱连一条线跑一次，看 `report.json` 里 `run.nodes[].upstreams` |
| 不确定 | 先 `visual:dom`，再 `--run=fake` |

---

## 六、写测试的三条铁律

1. **动态 `import` 必须字面量路径**——变量/模板串 esbuild 解析不了，运行时 `ERR_MODULE_NOT_FOUND`。
2. **mock 必须先于 workflowEditor 模块 import**——`nodeCard.tsx` 顶层就解构 `globalThis.__vssarosBridge`，模块求值即抛。
3. **Node 侧绝不碰 `.tsx`**——runner 的 esbuild 插件只解析 `.js → .ts`。渲染能力走 `runtimeDom.ts` 单独隔离。

---

## 七、当前基线状态（2026-09-04）

`npm run visual:dom` → **876 / 892 通过，16 条失败**。全部是**既有失败**，非执行模式改动引入：

| 节点 | 规则 | 详情 |
|---|---|---|
| `ComfyTV.GridSplitStage`（4 态） | horizontal-overflow | 切片网格控件溢出 69px |
| `ComfyTV.StoryboardEditorStage`（4 态） | horizontal-overflow | 右侧字段面板 `width:260px` 溢出 6px |
| `ComfyTV.MultiPanelStoryboardStage`（4 态） | control-missing | meta 声明 `width,height` 但 DOM 缺失 |
| `ComfyTV.StatEmojiStage`（4 态） | horizontal-overflow | 8 个按钮溢出 178px |

**如何看待这 16 条**：

- `StatEmojiStage`（178px）/ `GridSplitStage`（69px）溢出量大，是**真实 UI 缺陷**。
- `StoryboardEditorStage`（导演台）只溢出 6px，且它是**弹窗内**使用的编辑器（画布 + 260px 字段面板），画廊把它塞进 280px 卡片宿主来测，属于**测试宿主与真实场景不匹配**——修不修取决于是否要让它在窄卡片里也能用。
- `MultiPanelStoryboardStage` 的 `control-missing` 是 meta 与 DOM 不一致，需确认 `width/height` 是否该登记进 `stageHiddenFields`。

`visual/report.md` 里还有 72 条**提示**（非失败）：大量 `editorKind=xxx` 节点的控件未见于 DOM——这些是专用编辑器接管字段的正常现象，提示文案已写明「若非编辑器接管则应登记进 stageHiddenFields」。

---

## 八、文件地图

```
test/browser/
├── run-browser-test.mjs           Node 测试 runner（esbuild + mocha tdd）
├── test-server.mjs                ★ 统一入口（导航页 + Node 面板 + /visual 代理 + 自动拉起 visual）
├── workflow*.test.ts              62 个既有逻辑测试（目录内共 179 个 *.test.ts）
└── workflowSandbox.test.ts        ★ 沙箱回归（10 tests：单节点 + runGraph + fixture 回放，223 节点全量）

webview/visual/
├── bridgeStub.mjs                 ★ 两套设施共用的 bridge 单一真源（.mjs 是硬约束）
├── bridgeStub.d.mts               配套类型声明
├── mocks.ts                       浏览器侧组装 + 网络守卫
├── runtime.ts                     ★ 宿主无关内核（createSandbox / runGraph）
├── runtimeDom.ts                  ★ 浏览器渲染实现（mountCard）
├── harness.tsx                    画廊模式 + 执行模式（?run=1 / ?run=fake）
├── fixtures.ts                    场景构建 + 假图
├── visual.spec.mjs                runner（画廊断言 R1–R16 / 执行断言 R17–R22）
├── canvas.spec.mjs                ★ 画布自动验收（Playwright → dist/canvas/report.json）
├── canvas/                        ★ 画布沙箱（手拖节点）
│   ├── index.html                 页面（height:100% 是硬要求，否则画布静默不渲染）
│   └── canvasHost.tsx             宿主：mock 先行 → 动态 import → 一次性 seeding → render
├── dist/canvas/                   ★ 产物：report.json + report.md + screenshot.png（dist/ 已 gitignore）
├── baseline/                      截图基线（入库）
└── report.md                      失败汇总
```
