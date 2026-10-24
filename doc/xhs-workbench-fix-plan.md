# 小红书笔记工作台 · 三个硬伤的解法

**对象**：`sara2398/xiaohongshu-note-workbench@0.1.1`（源码分析见 `doc/xhs-note-workbench-source-analysis.md`）
**前提**：这是**第三方包**（不在本仓）⇒ 两条路：**(A) fork 成我们自己的包**（`@vssaros/dsh-xhs-note`）或 **(B) 只把它当参考，在自研创作台里照此实现**。下面所有落点都按 A/B 通用写。
**时间**：2026-10-24

---

## 硬伤 1：草稿只在 `localStorage`，换机即丢

### 现状

```js
const STORAGE_KEY = 'dsh-xhs-note-workbench.drafts.v1'
localStorage.setItem(STORAGE_KEY, JSON.stringify(next))   // 上限 20 条，超出静默丢
```

问题：不落数据根、不随插件卸载保留、超限无提示、`savedAt` 用本地化字符串（不可比较）。

### 目标

- 草稿落 `<数据根>/xiaohongshu-note-workbench/drafts/<id>.json`；**卸载插件不删数据**；
- `localStorage` 只留 UI 偏好（上次选的风格、面板开合），不再存内容；
- 旧数据**一次性迁移**，不丢。

### 落点

| 文件 | 改动 |
|---|---|
| `dsh/index.js`（现在 3 行空壳） | 加 3 条路由 + store |
| **新增 `lib/store.js`** | 读写/上限/原子替换/乐观锁 |
| `lib/client.js` | `readSaved/saveDraft/deleteDraft` 改走 `/api/drafts`；首次加载做迁移 |

### 数据根怎么取（第三方包的坑）

本仓的权威实现是 `vssaros-foundation/lib/paths.js::dataRootOf(config)`（回落链：`config.dataRoot` → `$VSSAROS_DATA_ROOT` → `~/.vssaros`）。

第三方包**不建议 peer 依赖 foundation**（装到没有它的宿主会炸），内联这 12 行更稳：

```js
// 与 @vssaros/dsh-foundation 的 paths.js 同口径（那边是权威实现）
function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) { return configured; }
	const env = String(process.env.VSSAROS_DATA_ROOT || '').trim();
	if (env) { return env; }
	return path.join(os.homedir(), '.vssaros');
}
```

### store 的关键选择

| 选择 | 建议 | 理由 |
|---|---|---|
| 一稿一文件 vs 单表 | **一稿一文件** `drafts/<id>.json` | 单表每次保存要重写全部，20 篇还行、200 篇会卡；一稿一文件还能只改一篇 |
| 写入方式 | `writeFile(tmp)` → `rename(tmp, final)` | 断电不会留下半个 JSON（原子替换） |
| 权限 | `mode: 0o600` | 草稿是私有内容 |
| 上限 | **200 篇**（元数据列表分页） | 原实现 20 条太紧；列表只读 `drafts/index.json` 的元数据 |
| 时间 | `savedAt: new Date().toISOString()` | 可排序、可跨时区 |
| 并发 | 每条带 `rev`，写入校验 `rev`，冲突返回 **409** | 两个窗口同时改同一篇不会互相覆盖 |

### 路由（4 条）

```js
GET    /x/<id>/api/drafts           → { drafts: [{ id, title, savedAt, rev }] }   // 只要元数据
GET    /x/<id>/api/drafts/:id       → 单篇全文
POST   /x/<id>/api/drafts           → 新建 / 更新（body 带 rev）
DELETE /x/<id>/api/drafts/:id
```

### 迁移（只跑一次）

```js
// lib/store.js
export async function migrateFromLocalStorage(rawList, dir) {
	const marker = path.join(dir, '.migrated-localstorage');
	if (await exists(marker)) { return { skipped: true }; }
	// rawList 来自页面：localStorage.getItem(STORAGE_KEY) 解析后的数组（本机存的旧草稿）
	for (const item of rawList.slice(0, 20)) { await writeDraft(dir, normalizeOld(item)); }
	await writeFile(marker, new Date().toISOString(), 'utf8');
	return { imported: rawList.length };
}
```

> 迁移标记写在**数据根**（不是 localStorage）⇒ 换机重新迁移也只会导一次。
> 迁移后**不要删** localStorage 里那份，留作最后一道保险。

### 验证

1. **Node 单测**：原子写（写一半断电模拟 → 文件仍可解析）、上限、`rev` 冲突 409、迁移幂等（跑两次只导一次）；
2. **沙箱探针**：存 3 篇 → 重启宿主 → 列表仍是 3 篇（证明落盘，不是内存）；
3. **重装验证**：卸载插件 + 重装 → 数据还在（证明"卸载不删"）。

**成本**：M（新增 1 个 store + 4 条路由 + 迁移 + 单测）。

---

## 硬伤 2：暗色不跟随（自造粉色变量 + 26 处裸色）

### 现状

```css
.xhswb{--ink:#271f24;--muted:#736970;--line:#eadfe4;--rose:#ff2e55;--rose2:#fff0f3;--paper:#fffdfc;
  background:linear-gradient(145deg,#fff9f7 0%,#fff 46%,#fff7f9 100%)}
```

`--paper/--ink` 写死 ⇒ 暗色下仍是亮底粉红；26 处裸色（含 `rgba(255,46,85,.18)` 这种阴影）也一样。

### 目标

- **颜色只走 `--dsw-alias-*`**；尺寸只走 `--wb-*`（没有就写 `var(--wb-f-sm, 13px)` 兜底）；
- **品牌色只有一个入口**，且默认跟随宿主：`data-brand='host'`（默认）→ `--wb-brand: var(--dsw-alias-brand-primary)`；`data-brand='xhs'` → `--wb-brand: #ff2e55`；
- 暗色下**肉眼可见**地变（根背景、正文色、边框三处都要变）。

### 三步改法

**① 自造变量 → 令牌别名（一次性替换，不动结构）**

| 现在 | 改成 |
|---|---|
| `--ink:#271f24` | `--ink:var(--dsw-alias-label-primary,#271f24)` |
| `--muted:#736970` | `--muted:var(--dsw-alias-label-caption,#736970)` |
| `--line:#eadfe4` | `--line:var(--dsw-alias-border-l1,#eadfe4)` |
| `--paper:#fffdfc` | `--paper:var(--dsw-alias-bg-base,#fffdfc)` |
| `--rose2:#fff0f3` | `--rose2:var(--dsw-alias-bg-layer-1,#fff0f3)` |
| `--rose:#ff2e55` | `--brand:var(--wb-brand,var(--dsw-alias-brand-primary,#ff2e55))` |

**② 26 处裸色按类替换**

| 类别 | 例子 | 替换成 |
|---|---|---|
| 背景 | `background:#fff` | `var(--dsw-alias-bg-layer-1,#fff)` |
| 文字 | `color:#2e272b` | `var(--dsw-alias-label-primary,#2e272b)` |
| 边框/分隔 | `border-color:#f2e9ed` | `var(--dsw-alias-border-l1,#f2e9ed)` |
| 悬停/选中 | `background:#fffafa` / `#fff0f3` | `var(--dsw-alias-interactive-bg-hover, …)` |
| 阴影（品牌） | `box-shadow:0 8px 24px rgba(255,46,85,.22)` | `box-shadow:0 8px 24px color-mix(in srgb, var(--brand) 22%, transparent)`（旧浏览器回落 `rgba(0,0,0,.12)`） |
| 状态 | `#ac1733`（错误文案） | `var(--dsw-alias-state-error-primary,#ac1733)` |

**③ 渐变底只在品牌模式启用**

```css
.xhswb{background:var(--dsw-alias-bg-base,#fff)}                 /* 默认干净 */
.xhswb[data-brand='xhs']{background:linear-gradient(145deg,#fff9f7 0%,#fff 46%,#fff7f9 100%)}
```

> 顺带：**尺寸也换刻度** —— `9/11/12/15/18px` → `var(--wb-f-xs,12px)` / `var(--wb-f-sm,13px)` / `var(--wb-f-lg,16px)`；圆角 `18px` → `var(--wb-r-md,10px)`。

### 还能直接吃共享层

`vssaros-workbenches` 的 `client.ui.js` 会**全局注入 `<style id="vssaros-wb-ui">`**（`STYLE_ID`），所以即便是第三方包，只要注册进我们的宿主，**同一文档里就能用 `wb-btn` / `wb-card` / `wb-input` / `wb-empty`**。头部、卡片、按钮换成原语后，自写 CSS 只剩品牌渐变那几行。

### 验证

1. **探针**（3 个取样点）：

```js
const read = el => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, fg: cs.color, bd: cs.borderTopColor }; };
const a = read(root);
document.body.setAttribute('data-ds-dark-theme', '');
const b = read(root);
document.body.removeAttribute('data-ds-dark-theme');
// 断言 a.bg !== b.bg && a.fg !== b.fg
```

2. **守卫**：把包纳入 `check-workbench-style.mjs` 的 `UNIFIED` 白名单（该项已有"无裸色 / 有 surface 标记 / ≥10 个 wb-*"）；
3. **变异**：把 `--ink` 改回写死的 `#271f24` ⇒ 探针的 `fg` 断言必须红。

**成本**：S（纯 CSS + 一次探针）。

---

## 硬伤 3：AI 不知道你在写什么

### 现状

`openAi()` 只做了"开会话 + 显示对话"，**草稿一个字都没带过去** ⇒ 想润色得手工复制粘贴。

### 目标

点「AI 协助」时，把当前草稿变成**预填在 composer 里的一段指令**（**不自动发送**，用户可改可弃）。

### 现成参考：门店选址的 `fillDraft()`

```167:177:lib/client.js   （site-selection）
function fillDraft(sessionId, prompt) {
	if (!sessionId || ownedSession() !== sessionId) throw new Error('会话已切换…')
	const actx = bridge.sessions.scope?.(sessionId)
	const conversation = actx?.get?.('conversation')
	if (!conversation) throw new Error('对话输入不可用')
	const input = conversation.input.for(actx)
	const snapshot = input.state.getSnapshot()
	if (snapshot.occurrences?.length || (snapshot.phase && snapshot.phase !== 'plain')) {
		throw new Error('当前草稿含引用或特殊输入，请先在原生会话中处理')
	}
	const current = snapshot.draft || ''
	input.setDraft(current.trim() ? `${current}\n\n${prompt}` : prompt)
}
```

三个细节都值得照抄：**只在 own session 写**、**composer 不是 plain 就不覆盖**、**已有内容就追加**。

### 我们的落点

工作台的 Panel 拿到的是 `conversation` **DOM 节点**（宿主 portal 官方对话进来），拿不到 `setDraft`。两条路：

**(a) 宿主加一个方法（推荐）** —— `vssaros-workbenches/lib/client.js`：

```js
// register() 时把 prefill 能力挂到 service 上（工作台通过 props.service.prefillComposer 调）
prefillComposer(text) {
	const conversation = this.ctx.get?.('conversation');
	const input = conversation?.input?.for?.(this.ctx);
	if (!input) { return false; }
	const snap = input.state?.getSnapshot?.() || {};
	if (snap.occurrences?.length || (snap.phase && snap.phase !== 'plain')) { return false; }   // 不覆盖用户正在编辑的内容
	const cur = String(snap.draft || '');
	input.setDraft(cur.trim() ? `${cur}\n\n${text}` : text);
	return true;
}
```

**(b) 零契约退路** —— 工作台派发事件，chat-surface 里监听：

```js
window.dispatchEvent(new CustomEvent('vssaros:composer-prefill', { detail: { text } }));
```

### 预填什么（这一段决定效果）

```js
const prompt = [
	'这是我正在写的小红书笔记，请不要改变事实，只做润色与结构优化：',
	'',
	`【主题】${topic}`,
	`【标题】${draft.title}`,
	`【正文】${body.length > 1200 ? body.slice(0, 600) + '…（后略，全文在工作台）' : body}`,
	`【标签】${draft.tags}`,
	'',
	'要求：保持第一人称与真实感；标题给 3 个更有点击欲的备选；正文控制在 600 字内；最后给出话题标签。',
].join('\n');
```

**要点**

- **截断**：正文超 1200 字只带前 600 字 + 说明（别把 4000 字灌进 composer）；
- **明确"不改事实"**：否则模型容易编造经历（小红书场景尤其敏感）；
- **不自动发送**：预填 ≠ 发送，用户仍可改（对齐"再生成 / 接受"两个动作要分开的原则）；
- **去重**：按 `(sessionId, draftRev)` 记一次，避免每次点 AI 都追加一遍。

### 验证

1. **探针**：点「AI 协助」→ 断言 composer 的 draft 以「这是我正在写的小红书笔记」开头且包含当前标题；
2. **边界用例**：composer 里已有用户输入 ⇒ 断言**追加**而不是覆盖；有 `@引用` ⇒ 断言**不写**且给出提示；
3. **变异**：把 `input.setDraft(text)` 注释掉 ⇒ 探针红。

**成本**：S–M（宿主 +30 行 / 工作台 +40 行 + 2 条探针）。

---

## 执行顺序与取舍

| 顺序 | 内容 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| **1** | 暗色令牌化（硬伤 2） | **S** | 肉眼可见、一致性立刻对齐 | 低（纯 CSS） |
| **2** | composer 预填（硬伤 3） | **S–M** | "AI 协助"从摆设变成真流程 | 低（有 plain 守卫） |
| **3** | 数据落盘（硬伤 1） | **M** | 数据不丢（不可逆损失） | 中（要动服务端 + 迁移） |

**如果只做一件**：做 **3**（数据丢失不可逆）；**如果只做一天**：先 **1** 再 **2**（两条都是纯前端，加起来不到一天，观感提升最大）。

---

## 两个前提要说清

1. **这是第三方包**：`localStorage` 迁移、store 改造都只在 **fork 后**的包里生效；原作者的包我们改不了。
2. **`dataRootOf` 的依赖策略**：内联回落链（12 行）比 peer 依赖 foundation 更稳 —— 第三方装到没有 foundation 的宿主时，peer 会直接缺依赖。

---

## 落地结果（2026-10-24，`@vssaros/dsh-xhs-note@0.1.0`）

三个硬伤已经做成**可运行的样板包**：`dsh-plugins/vssaros-xhs-note/`（自检 **39/39**）。

| 硬伤 | 落点 | 关键实现 |
|---|---|---|
| **1 数据落盘** | `lib/store.js` + `lib/index.js` | 一稿一文件、`tmp→rename` 原子写、`rev` 乐观锁（**HTTP 409**）、200 篇上限、`savedAt` ISO；`POST /api/migrate` 从 localStorage 一次性导入（标记 `<数据根>/xhs-note/drafts/.migrated-localstorage`，幂等） |
| **2 暗色跟随** | `lib/client.xhs-note.js` | 颜色只走 `var(--dsw-alias-*, 兜底)`（自检：**0 行裸色**）；品牌 `--wb-brand` 默认跟随宿主，`data-brand="xhs"` 才用粉；`@container` 1100/860 两档；21 个 `wb-*` 原语 |
| **3 AI 带上下文** | 工作台 `openAi()` + chat-surface 新事件 | `vssaros-composer-prefill`：`adapter.current → props.inputActions + hooks.input`，**plain 校验 + 追加而非覆盖 + `detail.result` 回执**；文案侧正文 >1200 字只带 600 字并注明「后略」 |

**配套改动**：

- `vssaros-chat-surface/lib/client.js`（0.2.242）：新增 `vssaros-composer-prefill` 监听（与既有 `vssaros-dsh-insert` 同一套取 `inputActions` 的路子）；
- `client.workbenchNav.js` 的 `DEFAULT_ITEMS` + `vssaros-dashboard/lib/catalog.js` 的 `WORKBENCH_MODULES`：两处同时登记 `/x/xhs-note/`（否则「打开」被 route 白名单静默拒掉）；
- `check-workbench-style.mjs` 的 `UNIFIED` 加 `vssaros-xhs-note`；
- `check-host-config.mjs` 的 `EXPECTED_FOUNDATIONREF_COPIES` 14 → 15（新消费插件必须同步这里）。

**踩到的两个坑（已写进代码注释）**：

1. **注册必须放子块**：`check-workbench-style.mjs` 用「含 `desktopWorkbenches.register` 的文件」当组件文件 ⇒ 放在入口会因「0 个 wb-* / 缺 surface」被判未迁移；
2. **同形文件别按自己的行尾归一**：`foundationRef.js` 要求 15 份**逐字节同形**（规范那份是 **LF**），我按仓库 CRLF 归一后立刻变红。

**验证状态**：包自检 39/39（含 store 原子性 / 冲突 409 / 上限 / 迁移幂等 / HTTP 路由 / 静态契约）；`check-chat-surface-chunks`、`check-workbench-style`、`check-workbench-catalog` 全绿；`check-host-config` 仅剩**既有的** `vssaros-marketplace/lib/marketClient.js` 第三份实现（不是本次引入）。
**真机已验（2026-10-24，沙箱 `%TEMP%\wb-xhs-probe`，13/13）**：注册表有 `vssaros/xhs-note`；面板渲染（root + toolbar + 生成按钮 + 对话停靠点 + `#vssaros-wb-ui`）；**切暗色**根背景 `rgb(255,255,255)→rgb(21,21,23)`、文字 `rgb(15,17,21)→rgb(249,250,251)`；点「生成」出标题；**保存后 `/api/drafts` 读回 1 篇**且磁盘上真有 `…/wb-xhs-data/xhs-note/drafts/<id>.json`（887B）；预填事件被 chat-surface 认领并回 `{applied:false, reason:'no-input'}`（该状态下没有会话/输入框 ⇒ 通道通、落笔条件不满足）；web boot 无失败条目。

**真机过程中挖出的两个真 bug（都已修，且写进技能）**：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| ① | 注册表里**根本没有**这个工作台，宿主也不报错 | **缺 `cordis.patch.yml` + `dsh.bundle.patch`** ⇒ 插件不进运行时（profile 里 deps/bundles 都登记了也没用） | 加 patch 文件 + 清单字段（脚手架已生成） |
| ② | 模块加载了，但注册被拒 | 客户端**描述符里漏了 `repository`** ⇒ 宿主 `normalize()` 抛 `Invalid workbench repository`（`identityOf()` 用它算 id） | 描述符补 `repository: 'vssaros:xhs-note'` |

> 诊断价值：①的失败**完全静默**（没有日志、没有 boot 失败）；②只有在页面 console 里能看到。现在包里留了 `globalThis.__vssarosXhsNote = { loaded, registered, failed }` 作为探针锚点。

---

## 复现

- 第三方源码：`%TEMP%\wb-market-src\sara2398__xiaohongshu-note-workbench\`
- 现成参考实现：`%TEMP%\wb-market-src\dataelement__dsh-site-selection\lib\client.js:167-177`（`fillDraft`）
- 共享层注入：`dsh-plugins/vssaros-workbenches/lib/client.ui.js:234`（`STYLE_ID = 'vssaros-wb-ui'`）
- 数据根权威实现：`dsh-plugins/vssaros-foundation/lib/paths.js:11`（`dataRootOf`）
