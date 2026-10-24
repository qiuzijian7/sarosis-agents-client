# 内置工作台 × 「制作模板」符合度评估

**标准来源**：技能 `dsh-workbench-authoring`（`SKILL.md` 15 条坑 + `references/manifest-and-registration.md` 的激活三件套 + 共享层/令牌/容器查询/锚点/零 iframe 纪律）
**样本**：声明了 `vssaros.workbench` 的 **15 个包**（9 个已注册 + 6 个 SSR/站点型）
**时间**：2026-10-24 · **脚本**：`%TEMP%\wb-standard-audit2.mjs`（结果 `%TEMP%\wb-standard-audit2.json`）

---

## 0. 判定口径（先说清，避免误读）

| 编号 | 条款 | 判定为 ✓ 的条件 |
|---|---|---|
| S1 | **bundle patch 激活** | 包内有 `cordis.patch.yml` 且含 `- insert:` |
| S2 | **清单 patch 字段** | `dsh.bundle.patch` 存在且 `files` 含该文件 |
| S3 | **描述符 repository** | 源码里有 `repository: 'vssaros:<模块>'` 或 `https://github.com/<o>/<r>` |
| S4 | **入口不写 `chunk:`** | `lib/client.js` 无 `chunk:` 字段 |
| S5 | **注册式** | 客户端出现 `*.register(`（`desktopWorkbenches` / `dw` / `c` 三种写法都算） |
| S6 | **共享层** | 客户端组件里 ≥10 个不同 `wb-*` 类 |
| S7 | **无裸色** | 组件里没有「不含 `var(--`」的 `#hex` / `rgba()` / `hsl()` 行（**canvas 的 `fillStyle/strokeStyle` 豁免**） |
| S8 | **surface 标记** | 根节点 `data-vssaros-surface="workbench"` |
| S9 | **容器查询** | 组件用 `@container` |
| S10 | **不按窗口判宽** | 不出现 `@media (max-width…)` |
| S11 | **机器锚点** | 组件里 ≥3 个不同 `data-*` |
| S12 | **零 iframe** | 组件里没有 `<iframe>` / `createElement('iframe')` |
| S13 | **数据落盘** | 服务端用 `dataRootOf`/`foundation()`，且组件不写 `localStorage.setItem` |
| S14 | **契约一致** | 清单 `title` 以字符串出现在组件源码里 |
| S15 | **包内自检** | `test/*.mjs` 或 `scripts/check*.mjs` |

**三条「不适用（N/A）」**——不能算缺陷，只能在文档里标注：

1. **未注册的 SSR/站点型包**（sessions / media / skills / parallel / imagegen / marketplace）本来就不是注册式 ⇒ S5–S12 天然不适用；
2. **不持有业务数据的包**（studio 只载站点、imagegen 只生图落盘到别处）⇒ S13 可能 N/A；
3. **画布绘制的颜色**（`ctx.fillStyle = '#dcb67a'`）走不了 CSS 变量 ⇒ 已在 S7 里豁免。

---

## 1. 总表（分数越高 = 越接近模板）

> **这是修复前的基线快照**。2026-10-24 当天已把 S9/S11/S12 并进守卫并修掉 4 个包的 `@container`（见 §6），
> 因此 workflow / memory / codebase 现在是 14/15、agents 13/15。

| 工作台 | 分 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 | S11 | S12 | S13 | S14 | S15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **xhs-note** | **15/15** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| kanban | 14/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| scheduler | 14/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| codebase | 13/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| kb | 13/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| memory | 13/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| workflow | 13/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| agents | 11/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ |
| sessions | 8/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| studio | 8/15 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| marketplace | 7/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| media | 7/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ |
| skills | 7/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ |
| imagegen | 5/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| parallel | 5/15 | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |

---

## 2. 结论：三档

### 第一档 · 可直接当模板（15/15）

**`xhs-note`** —— 唯一全过。它的价值不是功能，而是**每一步都有对照**：激活三件套齐全、描述符带 `repository`、入口无 `chunk:`、注册在组件文件里、21 个 `wb-*`、0 裸色、容器查询、锚点齐全、零 iframe、草稿落数据根、自检 39 条 + 真机 13/13。

### 第二档 · 组织级样板（13–14/15）

| 包 | 缺什么 | 说明 |
|---|---|---|
| **kanban / scheduler** | 仅 S15（包内自检） | 二者的 UI 已经全过 15 条里的其余 14 条，**缺的只是"把验证放进包里"** |
| **codebase / memory / workflow** | S9 容器查询 + S15 | 窗口变窄时靠宿主兜，组件自己不响应 |
| **kb** | S9 + S7（3 处裸色：内联 `rgba()` 背景） | kb 有最全的自检（S15 ✓），但 UI 条款差两条 |

### 第三档 · 未注册 / 站点型（5–8/15）

- **sessions / media / skills / parallel / imagegen / marketplace**：仍是 SSR 或自带 bundle，S3/S5/S6/S8–S11 大多数天然 N/A —— **分数低不代表质量差，代表"离注册式模板远"**；
- **studio**：A 类注册 + 内嵌官方对话，但 **自造变量（2 处裸色）+ iframe 载站点 + 无共享层**，是"形态对、皮肤没跟上"的典型。

---

## 3. 共性问题（跨包统计，这才是该批量修的）

| 问题 | 命中 | 建议 |
|---|---|---|
| **缺 `@container`** | 基线 **12/15**（只有 kanban / scheduler / xhs-note 有）→ **修复后 8/15**（workflow / memory / codebase / agents 已补，见 §6） | 工作台会被塞进 320–420px 的 sideview/右栏 ⇒ 一律补容器查询（每条 3–8 行 CSS） |
| **包内没有自检** | **11/15**（只有 xhs-note / kb / sessions / marketplace 有） | 家族探针（`poc/dsh-p0/scripts/p3-*`）不等于包内自检：装出去就没有了 ⇒ 至少给 `test/run-*.mjs` |
| **`@media` 判宽** | **2**（agents / parallel） | 同窗不同宽判不出来 ⇒ 换 `@container` 或 `ResizeObserver` + `data-narrow` |
| **裸色** | **5**（**parallel 26 处** · kb 3 · studio 2 · marketplace 1 · imagegen 5） | 换成 `var(--dsw-alias-*, 兜底)`；canvas 的 `fillStyle/strokeStyle` 已豁免。parallel 的多是终端 ANSI 配色（`--ok: #3fb950`），属"终端类豁免"范畴，但**要么豁免、要么令牌化**，不能两不靠 |
| **未注册** | **6** | 列表型按「形态 → 注册式」迁（media 优先）；终端/站点型在规范里写明豁免 |
| **无机器锚点（<3 个 `data-*`）** | **5**（imagegen / marketplace / media / sessions / skills） | 探针只能靠锚点；类名会被 UI 统一改掉 |

---

## 4. 修复清单（按性价比）

| 顺序 | 动作 | 涉及 | 成本 |
|---|---|---|---|
| 1 | 给 7 个注册式包补 `@container` 断点（860/560 两档即可） | codebase / memory / workflow / kb / scheduler / agents / studio | **S**（每个 3–8 行） |
| 2 | 清裸色：kb 3、studio 2、marketplace 1、imagegen 5 | 4 个包 | **S** |
| 3 | 把 `@media` 换成容器查询 | agents / parallel / imagegen | **S–M** |
| 4 | 每包加 `test/run-<模块>.mjs`（哪怕只断言 5 条静态契约） | 11 个包 | **M**（可复用 xhs-note 的模板） |
| 5 | `media` 迁注册式（列表型里结构最匹配 `wb-*`） | media | **M** |
| 6 | 规范补两条豁免：终端类（parallel）免共享 UI 层；站点承载（studio）免零 iframe | 文档 | **S** |

---

## 5. 方法学与已知局限（如实）

1. **跑了两轮才对**：v1 把全部 lib 文件 `join` 后整体剥注释 ⇒ 一个未闭合的 `/*` 会把后面的文件一起吞掉（scheduler 因此被误判 8/15）。v2 改成**逐文件剥**并只评客户端组件；
2. **口径**：有 `lib/client*.js` 的只看这些文件；没有的（imagegen/parallel 等）退化为"排除服务端入口后的 lib"，结果里标 `fallbackUi`；
3. **S14 只做字符串出现判定**，是弱检查（真正的一致性由 IDE 侧 `dshPluginPackages.test.ts` 覆盖）；
4. **S13 对"不持久化"的包应判 N/A**（studio/imagegen），表里记 ✗ 只是为了不打散矩阵；
5. **hex/裸色计数不含 SSR 页面**（那些是旧页，另一条线）。

---

## 6. 已落地：三条并进守卫（2026-10-24）

`dsh-plugins/check-workbench-style.mjs` 现在**机器守着 8 条**（原 4 条 + 新 3 条 + S15）：

| 守卫条款 | 对应本文 | 现状 |
|---|---|---|
| 无裸色 / surface 标记 / ≥10 个 `wb-*` / toolbar 唯一 | S7 / S8 / S6 / — | 原有 |
| **有 `@container`** | **S9** | 新增；workflow · memory · codebase · agents 已补（agents 同时把 2 条 `@media` 换成 `@container`） |
| **≥3 个 `data-*` 锚点** | **S11** | 新增；白名单 8 个包全部达标（最少的也 ≥5 个） |
| **零 iframe** | **S12** | 新增；8 个包全过（studio 载站点，本来就不在白名单） |
| **包内自检** | **S15** | 新增；`test/*.mjs` **或** `scripts/check-*.mjs` 都算（kb 的自检一直放在 scripts/ 下）。已有：kb / scheduler / kanban / xhs-note（**本轮给 scheduler、kanban 各写了一个**：28 条 / 33 条） |

同时加了 `PENDING`（**不是白名单**）：登记在里面的包照样跑检查，但失败不计入退出码，且必须写明原因与摘除条件。当前只有一条：

```js
// 按**条款**登记（只有列出的条款失败才不计入退出码 —— 整包放水会把真回归也吞掉）
'vssaros-kb':       { rules: ['S9'],  reason: '另一条会话正在重构 kb（面板合并进 client.js），等落地后补 @container' },
'vssaros-workflow': { rules: ['S15'], reason: '包内自检待补' },
'vssaros-memory':   { rules: ['S15'], reason: '包内自检待补' },
'vssaros-codebase': { rules: ['S15'], reason: '包内自检待补' },
'vssaros-agents':   { rules: ['S15'], reason: '包内自检待补' },
```

**修完后的分数变化**：workflow / memory / codebase 13 → **14/15**（只剩 S15 包内自检）；agents 11 → **13/15**（仍缺 S13 数据根与 S15）。kb 仍 13/15（PENDING 未计入）。

> 教训一条：**守卫的"选哪个文件当组件"不能取第一个匹配**。kb 把面板合并进 `client.js` 后，入口也含 `register`，取第一个就会去查一个没有 UI 的文件。现在按「候选里 `wb-*` 用得最多」挑。

**变异验证（证明三条不是空转）**：分别制造 ① 去掉一个包的 `@container` ② 把某包的 `data-*` 全改名（锚点归零）③ 往组件里塞一个真实 `<iframe>` —— 守卫精确报红（`没有 @container` / `只有 0 个 data-* 锚点` / `组件里有 iframe`），还原后立即恢复绿。
⚠ 第一次做 iframe 变异时插的是 `/* <iframe> */`，守卫会**剥注释** ⇒ 没红；变异必须造**真实代码**，否则会误以为守卫在空转。

---

## 6.1 一次「查死代码」的事故（2026-10-24 21:20 查明）

`vssaros-kb` 早先被判「只差 `@container`」，结论是**错的**——守卫查的是死文件：

| 事实 | 证据 |
|---|---|
| `client.kb.js`（47KB）已被整段并进 `client.js` | `client.js:3`「为什么把 `client.kb.js` 整段并进来（不再用子块 + require.async）」 |
| 入口只 `require.async('./client.kbview.js')` | 全包无人引用 `client.kb.js` ⇒ 死代码 |
| 守卫当时按「候选里 `wb-*` 最多」挑 ⇒ 选中死文件 | 死文件 29 个 `wb-*` / 0 裸色 / 有 surface ⇒ 一片绿 |
| 活组件（`client.js` 的 `KbWorkbenchPanel`）实际缺 4 项 | 21 行内联 style 裸色 · **无 `data-vssaros-surface`** · **无 toolbar 锚点** · 无 `@container` |

**修法（已落地）**：组件选择改成 ①入口自己有 `register(` ⇒ 用入口；②否则用入口 `require.async('./client.X.js')` 装载的子块；③都没有才退回 `wb-*` 最多。
kb 的 4 项登记为欠账（`--strict` 下仍红），修好后删条目并顺手删死文件。

> 教训：**守卫选错文件比没有守卫更危险**——它会给出"已达标"的假结论。凡是"取最 X 的那个"的启发式，都要问一句：最 X 的会不会是死代码。

---

## 7. 工具链（2026-10-24 收口）

| 工具 | 作用 | 现状 |
|---|---|---|
| `dsh-plugins/check-workbench-style.mjs` | 对**已入库**工作台跑 8 条硬规则 | 绿（kb 的 S9 按欠账登记） |
| `.codebuddy/.../scripts/scaffold_workbench.mjs` | 生成工作台骨架（7 个文件） | **生成即 13/13 达标**（自带 `@container` + 包内自检） |
| `.codebuddy/.../scripts/audit_workbench.mjs` | 对**任意目录**跑 13 条静态体检 | 新包 / 第三方包入库前先过它 |
| 各包 `test/run-*.mjs` | 包内自检（S15） | 7 份：xhs 39 · agents 35 · kanban 33 · codebase 32 · workflow 31 · scheduler 28 · memory 27（合计 225 条） |

**两个口径坑（都已修，别再犯）**：

1. **`wb-*` 计数要扫 token**：`className: 'vss wb wb-toolbar'` 这类多类名串里也有原语，只数「独立成串」会把 scheduler 误判成 9 个（真实 11）；
2. **剥注释要逐文件**：整个 `lib` 先 `join` 再剥，一个未闭合的 `/*` 会把后面文件吞掉（scheduler 曾因此被判 8/15）。

---

## 8. 复现

```bash
node %TEMP%\wb-standard-audit2.mjs        # 打印矩阵 → %TEMP%\wb-standard-audit2.json
```

脚本不入库（一次性体检工具）。要长期守住，建议把 S6/S7/S8/S9/S11/S12 这 6 条并进 `dsh-plugins/check-workbench-style.mjs`（它已经覆盖 S6/S7/S8 与 toolbar 唯一性），再补 S9/S11/S12 三条即可。
