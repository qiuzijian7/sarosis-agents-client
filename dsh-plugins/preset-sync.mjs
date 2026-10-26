// "我们的 agent preset"（R13）生成器 / 检查器。
//
// 为什么要生成而不是手写：preset 就是**一整行**（`- id: preset-standard` + `config.plugins: [完整行列表]` ✓），
// 而 `--patch` 打 preset 是**整份替换 config** ✗（2026-10-12 实测：只写一行我们的模块 ⇒ 官方那些行全没了 ✗）。
// ⇒ 想给会话加"官方能力 + 我们的能力"，只能**把官方 preset 逐字复制一份再追加我们的行** ✓。
//
// 为什么是**文本**复制而不是"解析成 JS 再生成" ✗：官方 preset 里有 `disabled: !!js process.platform === 'win32'`
// 这类 **`!!js` 标签** ✓ —— 它们只能由 Cordis loader 承载/求值，任何"解析成数据再写回去"的做法都会把它们变成
// 普通字符串 ✗（语义静默变掉）。所以本脚本只做**行级文本变换**：换掉 preset 的 id/order 头，其余逐字保留 ✓。
//
// 用法：
//   node dsh-plugins/preset-sync.mjs --write   # ① 从 runtime 抓官方 standard preset ⇒ baseline；② 重新生成我们的 preset
//   node dsh-plugins/preset-sync.mjs           # check（默认）：baseline 是否还等于 runtime；我们的 preset 是否 == baseline + 我们的行
//
// 产物（都在 `dsh-plugins/vssaros-agents/` 下）：
//   `preset-standard.baseline.yml`  ← 官方 `dsh-web-app/presets/standard.patch.yml` 的**逐字副本**（改动可见 ✓）
//   `preset-vssaros.rows.yml`       ← **手工维护**：追加到副本后面的"我们的行"（不在生成范围内 ✓）
//   `cordis.presets.yml`            ← **生成物**：`- insert: [preset-vssaros-standard]`，plugins = baseline 行 + 我们的行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'vssaros-agents');
export const BASELINE_PATH = path.join(DIR, 'preset-standard.baseline.yml');
export const ROWS_PATH = path.join(DIR, 'preset-vssaros.rows.yml');
export const PRESET_PATH = path.join(DIR, 'cordis.presets.yml');
/**
 * ★ 2026-10-25：**每个 agent preset 的共享基座**（生成物，JS 数据模块）。
 *
 * 为什么要它：agent preset 由 `vssaros-agents/lib/core/agents.js` 的 `toPresetDefinition` 在运行时合成，
 * 之前只放 persona / model / compaction / subagent 几行 —— 官方 standard 里的 `tool-fs` / `tool-pwsh` /
 * `skill-filesystem` / `tool-skill` / `agent-instructions` … 一行都没有 ⇒ agent 会话**没有任何文件/命令/技能能力**。
 * 而且每次发现缺一类就手抄一类（compaction 10-21、subagent 10-19~21 都是这么补的）⇒ 必然再漏。
 * ⇒ 改成**从同一份 baseline 生成**：agent preset = 基座 ⊕ 本 agent 的差量（按行 id 覆盖）。
 *
 * 基座 = baseline 的全部行（去掉官方 persona 行，由 agent 自己的人设行顶替）
 *      + rows 文件里**官方包**（`@deepseek-ai/*`）的补充行（如 `tool-working-directory`）。
 * ⚠ **不含 `@vssaros/*` 行**：它们已在 profile bundles 里（host 层总是加载），preset 再挂一次会重复注册服务
 *   （真机 2026-10-24：`service 'vssarosMediaStore' has been registered` / `vssaros-skills: never started`）。
 * `!!js` 表达式保留成 loader 的 JsExpr 形态 `{ __jsExpr }`（`cordis-plugin-loader` 的 `interpolate` 原样求值）。
 */
export const BASE_ROWS_PATH = path.join(DIR, 'lib', 'core', 'presetBase.generated.js');

/** 我们的 preset 标识（`config.id`，会话保存的就是它 ✓）。 */
export const OUR_PRESET_ID = 'vssaros-standard';
/** 行 id（Loader 编辑地址 ✓）。 */
export const OUR_PRESET_ROW_ID = 'preset-vssaros-standard';
/**
 * `order`：官方 standard=1 / ptc=2 / minimal=3 / cordis=4 ⇒ 我们的排 **100**（只影响列表顺序 ✓）。
 *
 * ★ 2026-10-21 原来这里是 **3** ⇒ 与官方 minimal(3)/cordis(4) **同 order** ⇒ 官方 seat 菜单里
 *   "极简模式 → standard → 创造模式" **交错穿插**（用户截图现场 ✗）⇒ 观感上像"重复项"。
 *   沉到 100 之后：官方 4 模式(1..4) → agent → 我们的 3 档(100/101/102) ⇒ **三层清晰可辨** ✓。
 *   ⚠ 只改排序，不改 id/内容 ⇒ 会话 id 语义与功能零影响 ✓。
 */
export const OUR_PRESET_ORDER = 100;
/**
 * `config.name`（**显示名**，2026-10-13 加）：官方 `standard` preset 自己**没有** `name` ⇒ dsh 与我们的
 * 页面都退回显示 **id** ✗，而这个 id 是 `vssaros-standard` ⇒ 用户界面上会冒出这个内部串（本次报障现场 ✗✗）。
 * `description` 级的友好名 = `standard`（与官方那条"没有 name 时显示 `standard`"的观感一致 ✓）。
 * ⚠ 这是我们与官方 preset 的**又一处差异**，所以下面 `expectedPresetText` 的差异清单也要列上 ✓。
 *
 * ★ 2026-10-21 改名 `standard` → `标准档（VsSaros）`：官方 seat 菜单是**全部 roster**（官方 4 个内置
 *   模式 + 我们的档 + 22 个 agent 一股脑列出来，官方 `presetOptions()` 只过滤 `broken`、**没有按 kind 过滤**
 *   ⇒ agent 必然在里面，这是官方语义）⇒ 我们这条若还叫 `standard`，在菜单里就是"标准模式"旁边一条
 *   顶着内部串的 `standard`，**看着像重复项** ✗。改成"档"的自解释名后，一眼能分清"官方模式"与"我们的档" ✓。
 *   ⚠ 只改**显示名**，不改 `config.id` ⇒ 会话 id 后缀（= preset id）语义不动 ✓（`isModePreset` 判据也按 id 推导 ✓）。
 */
export const OUR_PRESET_NAME = '标准模式（VsSaros）';
/**
 * `config.description`（**2026-10-21 加**）：官方 seat 菜单里每条会显示"名称 + 一行描述" ⇒
 * 我们这三条若不写描述，就是官方那三条的「暂无描述。」⇒ 看着像**重复的模式** ✗。
 * `AgentPreset.Config` 支持 `description`（`dsh-agent-preset/lib/index.js:16`）⇒ 直接写上 ✓。
 * ⚠ 描述里**不能有半角冒号+空格**（YAML 键值分隔符）⇒ 统一用全角「：」✓；整体加双引号防意外 ✓。
 */
export const OUR_PRESET_DESCRIPTION = '带 VsSaros 能力模块的默认档：知识库 / 记忆 / 看板 / 代码库 / 工作流等已挂载，工具面按预算收敛（省 token）。';

// ── 第二个 preset：`vssaros-ptc`（2 档实验，2026-10-20）──────────────────────────────────────
/**
 * 为什么再造一个 preset 而不是把默认那个改成 ptc：PTC 下**模型只能调 `run_code`**
 * （`dsh-tools` README："Under `ptc` alone, a model-direct call naming any other visible tool resolves to
 * `UNKNOWN_TOOL`"）⇒ 直接切默认等于把所有会话的调用习惯一次性换掉 ✗。做成**可选 preset**才能 A/B：
 * 同一批任务在 native / ptc 两个 preset 上跑，比 token、步数与成功率 ✓。
 *
 * 与 `vssaros-standard` 的**唯一差别** = plugins 末尾一行 `tool-presentation: { mode: ptc }`
 * （官方 ptc preset 用的也是同一行：`dsh-web-app/presets/ptc.patch.yml:123`）。
 * ⚠ `ctx.ptcRuntime` **不用我们挂** —— host 层 `dsh-base/cordis.patch.yml:397` 的 `ptc-runtime` 行已经在，
 *   所以本生成器**不**往 `cordis.patch.yml` 里加任何 host 行（少一处真机风险 ✓）。
 */
export const PTC_PRESET_ID = 'vssaros-ptc';
export const PTC_PRESET_ROW_ID = 'preset-vssaros-ptc';
/** `order` 101：与另外两档一起沉到官方模式与 agent 之后（只影响列表顺序 ✓）。 */
export const PTC_PRESET_ORDER = 101;
/** 显示名：带 VsSaros 前缀，免得和官方那个 `ptc` 在 UI 里分不清 ✓。
 *  ★ 2026-10-21：`PTC (VsSaros)` → `PTC 档（VsSaros）`（"档"字点明它是我们的档位、不是官方那个模式 ✓）。 */
export const PTC_PRESET_NAME = 'PTC 模式（VsSaros）';
/** 说明：与标准档的差别只有"工具以批量执行方式呈现"这一条 ⇒ 写清楚才不会被当成重复项 ✓。 */
export const PTC_PRESET_DESCRIPTION = '与标准档同一套能力，但工具以批量执行（PTC）方式呈现：模型只看到 run_code 与自动生成的 SDK。';
/** 追加进 plugins 末尾那一行（缩进 10/12 与官方 `ptc.patch.yml:123-126` 逐字同形 ✓）。 */
// ── 第三个 preset：`vssaros-full`（"全能力"档，2026-10-21）──────────────────────────────
// 与 `vssaros-standard` **逐字相同**，**只差 `vssaros-agents` 行的 `denyTools` 清单**：
// 标准档藏掉"场景类"工具（省 token），本档**放开**它们 ⇒ 能力不丢（按需切档即可 ✓）。
// ⚠ 单变量纪律：两份 preset 的**行集合必须完全相同** ⇒ 这样"切档后工具面差多少"才可归因 ✓（守卫会盯 ✓）。
export const FULL_PRESET_ID = 'vssaros-full';
export const FULL_PRESET_ROW_ID = 'preset-vssaros-full';
/** `order` 102：与另外两档一起沉到官方模式与 agent 之后（只影响列表顺序 ✓）。 */
export const FULL_PRESET_ORDER = 102;
/**
 * 显示名：与「标准档（VsSaros）」成对 ⇒ 用户一眼知道这是**同一个底座的两档**（差别只在工具面宽窄），
 * 而不是一个"另一件事"。
 * ★ 2026-10-21：`Full (VsSaros)` → `全能力档（VsSaros）` → **`标准档 · 全工具（VsSaros）`**。
 */
export const FULL_PRESET_NAME = '标准档 · 全工具（VsSaros）';
/** 说明：与标准档的差别只有"工具面宽窄" ⇒ 说清"更全但更贵"，用户才知道什么时候切它 ✓。 */
export const FULL_PRESET_DESCRIPTION = '与标准档同一套能力，但放开被收敛掉的场景类工具（媒体 / 看板 / MCP / Web / Unreal 等）：能力最全，token 也最贵。';

export const PTC_PRESENTATION_ROWS = [
	'          - id: tool-presentation',
	'            name: \'@deepseek-ai/dsh-agent-tool-presentation\'',
	'            config:',
	'              mode: ptc',
].join('\n');

/** runtime 里官方 standard preset 的路径（找不到 ⇒ 只能跳过"与 runtime 比对"那一半 ✓）。 */
export function runtimeStandardPresetPath(env = process.env) {
	const home = env.DSH_TEST_RUNTIME_ROOT || null;
	const bases = [home, path.join(HERE, '..', 'poc', 'dsh-p0', '.runtime')].filter(Boolean);
	for (const base of bases) {
		if (!base || !fs.existsSync(base)) { continue; }
		// ⚠ **必须与宿主选同一个版本** ✗：`.runtime/` 下可能同时躺着多个版本（本机就有
		// `0.1.7-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.1` ✓），而探针与宿主用的是 `resolveRuntime()` 选出来的
		// 那个 ✓（`poc/dsh-p0/scripts/lib.mjs:243-253`）。第一版取"目录里第一个" ⇒ baseline 抓成
		// `0.1.7-rc.2` 的 preset ✗（好在它与 0.2.0 逐字相同，才没出事 ✓）；第二版取"最新"又可能不是宿主那版 ✗。
		// ⇒ 这里**照抄 lib.mjs 的两条规则**：环境变量 `DSH_VERSION` → `state.json` 的 `current` → 字典序最大 ✓。
		const versions = fs.readdirSync(base).filter(v => /^\d/.test(v)).sort();
		let pointer;
		try { pointer = JSON.parse(fs.readFileSync(path.join(base, 'state.json'), 'utf8'))?.current; } catch { /* 没有 pointer */ }
		const wanted = env.DSH_VERSION || pointer || versions.at(-1);
		for (const version of [wanted, versions.at(-1)]) {
			if (!version) { continue; }
			const p = path.join(base, version, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
			if (fs.existsSync(p)) { return p; }
		}
	}
	return undefined;
}

/**
 * 从 preset patch 文本里抽出 `plugins:` 这一段的**每一行原文**（不含 `plugins:` 那一行 ✓）。
 * ⚠ 缩进口径（实测，不是猜的 ✗）：`- insert:` 在 0 空格、`- id: preset-standard` 在 **4**、
 * `config:`/`id:`/`order:`/`plugins:` 在 **8**、每个 preset 行在 **10** 空格 ✓
 * （第一版按 6/8 写 ⇒ 直接报"找不到 plugins 段" ✗）。
 */
export function pluginsBlockOf(text) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex(l => /^ {8}plugins:\s*$/.test(l));
	if (start < 0) { return undefined; }
	// 段尾：出现"缩进 < 10 空格的非空行"即结束（preset 的行都在 10 空格缩进 ✓）
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') { continue; }
		if (!/^ {10}/.test(line)) { end = i; break; }
	}
	return lines.slice(start + 1, end).join('\n').replace(/\s+$/, '');
}

/** 行级文本归一化：CRLF → LF（比对只看内容，不看换行风格 ✓）。 */
export function normEol(text) {
	return String(text).replace(/\r\n/g, '\n');
}

/**
 * 两份 preset 文本是否"内容相同"（**EOL 无关**）。
 * ⚠ 2026-10-21：逐字比对（`!==`）在**新克隆**里必红 —— git 的 autocrlf 把 checkout 的文本转成
 *   CRLF，而生成物是 LF ⇒ 同一份内容被判定为"手改过"✗（本机主树是 LF 才没暴露，干净 worktree 立刻复现）。
 */
export function samePresetContent(a, b) {
	return normEol(a) === normEol(b);
}

/** 把官方 preset 文本改造成"我们的 preset"：换 id / order 头 + 追加我们的行（其余**逐字**保留 ✓）。 */
export function buildOurPreset(baselineText, ourRowsText) {
	const lines = baselineText.split(/\r?\n/);
	const out = [];
	// ★ 2026-10-15（用户报 "This turn failed: unknown prompt variable {{cwd}}…"，修法 B）：
	//   **删掉 persona 行** —— 那时（官方 0.2.0-rc.2）的 standard preset 带 persona 行，其 suffix 含
	//   `{{cwd}}`，而子代理（deployment）作用域的变量表里没有 cwd ⇒ 挂着本 preset 的会话一派子代理，
	//   子代理每一轮都被插值器抛错中止 ✗（dsh-system-prompt/lib/index.js:169；dsh-persona 按作用域
	//   **遮蔽**全局段 ⇒ 只修全局层救不了挂本 preset 的会话 ✗）。
	//   删掉后由**全局层** persona 生效：桥补丁已把全局 personaSuffix 烘焙成无变量的字面量
	//   （见 dshCli.ts renderBridgeOverlay 的 system-prompt 行 ✓）⇒ 根会话文案一致 ✓、子代理也能渲 ✓✓。
	// ★ 2026-10-21（baseline 切到官方 0.2.1-rc.1 之后）：**官方 standard 自己已经没有 persona 行**
	//   ⇒ 这段"删 persona"在当前 baseline 上是**防御性空操作**（保留：万一官方再加回来仍要删 ✓）。
	let skippingPersona = false;
	for (const line of lines) {
		if (/^ {10}- id: persona\s*$/.test(line)) { skippingPersona = true; continue; }
		if (skippingPersona) {
			// 行内容（空行或 ≥12 空格缩进）都跳过；遇到下一个 ≤10 空格缩进的非空行 = 新行开始 ✓
			if (line.trim() === '' || /^ {12}/.test(line)) { continue; }
			skippingPersona = false;
		}
		if (/^ {4}- id: preset-standard\s*$/.test(line)) { out.push(`    - id: ${OUR_PRESET_ROW_ID}`); continue; }
		if (/^ {8}id: standard\s*$/.test(line)) {
			out.push(`        id: ${OUR_PRESET_ID}`);
			// 官方那条没有 `name`；我们补一个**显示名**（否则界面退回显示内部 id `vssaros-standard` ✗）。
			out.push(`        name: ${OUR_PRESET_NAME}`);
			// 官方 seat 的菜单项是"名称 + 一行描述" ⇒ 不写描述就显示「暂无描述。」⇒ 看着像重复项 ✗。
			out.push(`        description: "${OUR_PRESET_DESCRIPTION}"`);
			continue;
		}
		if (/^ {8}order: \d+\s*$/.test(line)) { out.push(`        order: ${OUR_PRESET_ORDER}`); continue; }
		out.push(line);
	}
	const text = out.join('\n').replace(/\s+$/, '');
	const block = pluginsBlockOf(text);
	if (block === undefined) { throw new Error('baseline 里找不到 `        plugins:` 段（官方 preset 结构变了 ⇒ 生成器要跟着改 ✗）'); }
	const rows = ourRowsText.replace(/\s+$/, '');
	const rebuilt = text.replace(block, `${block}\n${rows}`);
	return `${rebuilt}\n`;
}

/**
 * 从"我们的 native preset 文本"派生出 **PTC 实验 preset**：id/name/order 换掉 + plugins 末尾加展示行。
 *
 * 为什么要从**生成好的文本**派生而不是让 `buildOurPreset` 出两份：官方 preset 的文本变换（删 persona 行、
 * 换 id/order、`!!js` 逐字保留）已经在 `buildOurPreset` 里做对了；派生只做"改三行 + 追加一行"，
 * 两份 preset 的其余部分**结构上不可能漂移** ✓（这正是 A/B 的前提：只差 presentation 一个变量）。
 */
export function buildPtcPreset(standardPresetText) {
	const lines = standardPresetText.replace(/\s+$/, '').split(/\r?\n/);
	// ⚠ 丢掉 baseline 开头那几行 **0 缩进** 的注释（"Agent preset standard: …"）：它们描述的是
	//   native 那份，原样拷到第二份里既是**误导**，又会让 `dshPresetPlane` 的"plugins 段缩进 < 10"扫描
	//   把它们当成块内浅缩进行而判红 ✗（2026-10-20 实测）。文件头已经有第二个 preset 的说明 ✓。
	while (lines.length > 0 && (lines[0].trim() === '' || lines[0].startsWith('#'))) {
		lines.shift();
	}
	const renamed = lines.map(line => {
		if (line === `    - id: ${OUR_PRESET_ROW_ID}`) { return `    - id: ${PTC_PRESET_ROW_ID}`; }
		if (line === `        id: ${OUR_PRESET_ID}`) { return `        id: ${PTC_PRESET_ID}`; }
		if (line === `        name: ${OUR_PRESET_NAME}`) { return `        name: ${PTC_PRESET_NAME}`; }
		if (line === `        description: "${OUR_PRESET_DESCRIPTION}"`) { return `        description: "${PTC_PRESET_DESCRIPTION}"`; }
		if (line === `        order: ${OUR_PRESET_ORDER}`) { return `        order: ${PTC_PRESET_ORDER}`; }
		return line;
	});
	const text = renamed.join('\n');
	const block = pluginsBlockOf(text);
	if (block === undefined) { throw new Error('派生 PTC preset 时找不到 `        plugins:` 段（结构变了 ⇒ 生成器要跟着改 ✗）'); }
	return `${text.replace(block, `${block}\n${PTC_PRESENTATION_ROWS}`)}\n`;
}

/** 期望的 `cordis.presets.yml` 内容（生成器与守卫**共用这一份**，免得两边各算一遍漂移 ✓）。 */
/**
 * 从"我们的 native preset 文本"派生 **Full 档**：换 id/name/order + **把 `denyTools` 换成 `denyToolsFull`**。
 *
 * 为什么要"换清单"而不是"换行集合"：host plane 的工具注册是**全局可见**的 ⇒ preset 里少挂某插件，
 * 那些工具**照样**进模型目录 ⇒ 靠"不挂"是藏不住的 ⇒ 唯一能藏的是 **mask（denyTools）** ✓。
 * ⇒ "轻/全"两档必须是**同一批行 + 不同 mask**（顺带满足"单一变量 ⇒ 可归因" ✓）。
 */
export function buildFullPreset(standardPresetText) {
	const lines = standardPresetText.replace(/\s+$/, '').split(/\r?\n/);
	const renamed = lines.map(line => {
		if (line === `    - id: ${OUR_PRESET_ROW_ID}`) { return `    - id: ${FULL_PRESET_ROW_ID}`; }
		if (line === `        id: ${OUR_PRESET_ID}`) { return `        id: ${FULL_PRESET_ID}`; }
		if (line === `        name: ${OUR_PRESET_NAME}`) { return `        name: ${FULL_PRESET_NAME}`; }
		if (line === `        description: "${OUR_PRESET_DESCRIPTION}"`) { return `        description: "${FULL_PRESET_DESCRIPTION}"`; }
		if (line === `        order: ${OUR_PRESET_ORDER}`) { return `        order: ${FULL_PRESET_ORDER}`; }
		return line;
	});
	// 取出 `denyToolsFull:` 的条目（它紧跟在 `denyTools:` 之后，缩进更深 ✓）
	const fullStart = renamed.findIndex(line => /^\s+denyToolsFull:\s*$/.test(line));
	if (fullStart < 0) { throw new Error('派生 Full preset 时找不到 `denyToolsFull:`（rows 文件里要写它 ✓）'); }
	const indent = renamed[fullStart].match(/^\s*/)[0];
	const fullEntries = [];
	let cursor = fullStart + 1;
	const fullItem = new RegExp(`^ {${indent.length + 2}}-`);
	while (cursor < renamed.length && fullItem.test(renamed[cursor])) {
		fullEntries.push(renamed[cursor]);
		cursor += 1;
	}
	// 删掉 `denyToolsFull:` 整块（连它的注释行一起：往前吃掉连续的注释行 ✓）
	let blockStart = fullStart;
	while (blockStart > 0 && /^\s*#/.test(renamed[blockStart - 1]) && renamed[blockStart - 1].match(/^\s*/)[0].length >= indent.length) { blockStart -= 1; }
	const withoutFull = [...renamed.slice(0, blockStart), ...renamed.slice(cursor)];
	// 把 `denyTools:` 的条目替换成 full 的条目
	const denyStart = withoutFull.findIndex(line => /^\s+denyTools:\s*$/.test(line));
	if (denyStart < 0) { throw new Error('派生 Full preset 时找不到 `denyTools:`（rows 文件里要写它 ✓）'); }
	const denyIndent = withoutFull[denyStart].match(/^\s*/)[0];
	let denyEnd = denyStart + 1;
	// ⚠ 列表里**夹着注释行**（rows 里每段都写了"为什么"）⇒ 只删连续的 `- ` 行会把后面的条目留下 ✗
	//   ⇒ 这里要连**同缩进的注释**一起吞掉，直到遇到"既不是条目也不是注释"的行（下一个键）✓
	const denyItem = new RegExp(`^ {${denyIndent.length + 2}}(-|#)`);
	while (denyEnd < withoutFull.length && denyItem.test(withoutFull[denyEnd])) { denyEnd += 1; }
	const swapped = [
		...withoutFull.slice(0, denyStart + 1),
		...fullEntries,
		...withoutFull.slice(denyEnd),
	];
	return `${swapped.join('\n')}\n`;
}

export function expectedPresetText(baselineText, ourRowsText) {
	const standard = buildOurPreset(baselineText, ourRowsText).replace(/\s+$/, '');
	const ptc = buildPtcPreset(standard).replace(/\s+$/, '');
	const full = buildFullPreset(standard).replace(/\s+$/, '');
	return [
		'# ⚠ 本文件由 `dsh-plugins/preset-sync.mjs` 生成，**不要手改** ✗（改了守卫会红 ✓）：',
		'#   node dsh-plugins/preset-sync.mjs --write',
		'#',
		'# 它声明"我们的 agent preset"：官方 standard preset 的**逐字副本**（保留 `!!js` 标签 ✓，见 baseline 文件）',
		'# + `preset-vssaros.rows.yml` 里那几行我们的模块 ✓。',
		'# ⚠ 与官方 preset 的**关键差异只有这些**：',
		`#   · \`config.id\` = \`${OUR_PRESET_ID}\`（官方是 \`standard\`）、行 id = \`${OUR_PRESET_ROW_ID}\`、\`order\` = ${OUR_PRESET_ORDER}；`,
		`#   · \`config.name\` = \`${OUR_PRESET_NAME}\`（官方那条没有 name ⇒ 界面会退回显示内部 id \`${OUR_PRESET_ID}\` ✗，故补上 ✓）；`,
		'#   · plugins 里**删掉**了 persona 行（官方 suffix 带 {{cwd}}，子代理作用域必炸 ✗；',
		'#     删掉后由全局层生效 —— 我们已把全局 personaSuffix 烘焙成无变量字面量，文案一致 ✓）；',
		'#   · plugins 末尾追加了我们的行。',
		'# ⚠ 选中本 preset 的会话**会重复挂载**我们的模块（host plane 那几行也在 ✓）⇒',
		'#   真正把默认切过来之前，必须先让 host 行 `disabled: true`（见 doc/dsh-shell-contract.html §8 ① 第 ③ 步 ✓）。',
		'#',
		`# ★ 第二个 preset \`${PTC_PRESET_ID}\`（2 档实验，2026-10-20）：与上面那份**逐字相同**，只在 plugins 末尾多一行`,
		'#   `@deepseek-ai/dsh-agent-tool-presentation`（`mode: ptc`）⇒ 模型只看到 `run_code` + 自动生成的 SDK',
		'#   （默认 native 档是直接发 197 个 schema）。**不要**把它设成默认 —— 它是拿来做 A/B 的 ✓；',
		'#   `ctx.ptcRuntime` 由 host 层 `dsh-base` 的 `ptc-runtime` 行提供，本文件不需要挂 ✓。',
		'#',
		`# ★ 第三个 preset \`${FULL_PRESET_ID}\`（"全能力"档，2026-10-21）：与上面那份**逐字相同**，**只差** \`vssaros-agents\` 行的 \`denyTools\` 清单`,
		'#   （标准档藏掉"场景类"工具省 token；本档放开它们 ⇒ 能力不丢 ✓）。切档即可换轻重 ✓；',
		'#   ⚠ 两份的**行集合必须完全相同** ⇒ "切档后差多少"才可归因（守卫会盯 ✓）。',
		standard,
		'',
		ptc,
		'',
		full,
		'',
	].join('\n');
}

// ── agent preset 共享基座（2026-10-25）─────────────────────────────────────────────
/** 解析 YAML，`!!js` 转成 loader 的 JsExpr（`{ __jsExpr }`）—— 与 cordis-plugin-loader 读 YAML 的结果同形。 */
async function loadYamlWithJs(text) {
	const { default: yaml } = await import('js-yaml');
	const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: data => ({ __jsExpr: String(data) }) });
	return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) });
}

/** 官方包前缀：rows 文件里只有这类行进基座（`@vssaros/*` 由 host 层提供，进 preset 会重复挂载）。 */
const OFFICIAL_ROW_PREFIX = '@deepseek-ai/';

/**
 * 算出 agent preset 的共享基座（行数组）。
 * @param baselineText 官方 standard preset（`preset-standard.baseline.yml`）
 * @param ourRowsText `preset-vssaros.rows.yml`（10 空格缩进的行片段）
 */
export async function buildAgentBaseRows(baselineText, ourRowsText) {
	const doc = await loadYamlWithJs(normEol(baselineText));
	const plugins = doc?.[0]?.insert?.[0]?.config?.plugins;
	if (!Array.isArray(plugins)) {
		throw new Error('baseline 里找不到 `insert[0].config.plugins`（官方 preset 结构变了 ⇒ 生成器要跟着改 ✗）');
	}
	// 官方 persona 行去掉：agent 自己的人设行用同一个 id（`persona`）顶替（与 vssaros-standard 删 persona 同理）
	const official = plugins.filter(row => row?.id !== 'persona');
	// rows 片段是 10 空格缩进的列表 ⇒ 去掉公共缩进再解析；缩进更浅的非注释行 = 结构变了，直接报错
	const lines = normEol(ourRowsText).split('\n').map((line, i) => {
		if (line.trim() === '' || line.trim().startsWith('#')) { return ''; }
		if (!line.startsWith(' '.repeat(10))) { throw new Error(`rows 文件第 ${i + 1} 行缩进不足 10 空格（结构变了？）：${line.trim().slice(0, 60)}`); }
		return line.slice(10);
	});
	const ours = (await loadYamlWithJs(lines.join('\n'))) ?? [];
	const supplements = (Array.isArray(ours) ? ours : []).filter(row => typeof row?.name === 'string' && row.name.startsWith(OFFICIAL_ROW_PREFIX));
	const ids = new Set();
	for (const row of [...official, ...supplements]) {
		if (ids.has(row.id)) { throw new Error(`基座行 id 重复：${row.id}`); }
		ids.add(row.id);
	}
	return [...official, ...supplements];
}

/** 基座模块的期望文本（生成器与守卫共用）。 */
export async function expectedBaseRowsText(baselineText, ourRowsText) {
	const rows = await buildAgentBaseRows(baselineText, ourRowsText);
	return [
		'// ⚠ 本文件由 `dsh-plugins/preset-sync.mjs --write-agent-base` 生成，**不要手改**（`node dsh-plugins/preset-sync.mjs` 会判红）。',
		'//',
		'// 每个 agent preset 的**共享基座**（`core/agents.js` 的 `toPresetDefinition` = 本基座 ⊕ 该 agent 的差量）：',
		'//   · 官方 standard preset（`preset-standard.baseline.yml`）的全部行，去掉官方 persona 行（由 agent 人设行顶替）；',
		'//   · `preset-vssaros.rows.yml` 里**官方包**（`@deepseek-ai/*`）的补充行；',
		'//   · **不含** `@vssaros/*` 行：它们在 profile bundles 里（host 层总是加载），preset 再挂会重复注册服务。',
		'// `!!js` 表达式保留为 loader 的 JsExpr 形态 `{ __jsExpr }`，由 cordis-plugin-loader 原样求值。',
		`export const STANDARD_BASE_ROWS = ${JSON.stringify(rows, null, '\t')};`,
		'',
	].join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	const write = process.argv.includes('--write');
	// 只重生成 agent 基座（不碰 baseline / cordis.presets.yml）：不需要 runtime，也不会顺手重写别的生成物
	const writeAgentBase = process.argv.includes('--write-agent-base');
	const ourRows = fs.existsSync(ROWS_PATH) ? fs.readFileSync(ROWS_PATH, 'utf8') : '';
	if (!ourRows.trim()) { console.error(`✗ 缺少我们的行源文件：${path.relative(process.cwd(), ROWS_PATH)}`); process.exit(1); }

	if (writeAgentBase) {
		const baseline = fs.readFileSync(BASELINE_PATH, 'utf8');
		const text = await expectedBaseRowsText(baseline, ourRows);
		fs.writeFileSync(BASE_ROWS_PATH, normEol(text), 'utf8');
		const rows = await buildAgentBaseRows(baseline, ourRows);
		console.log(`已写入 ${path.relative(process.cwd(), BASE_ROWS_PATH)}（${rows.length} 行：${rows.map(r => r.id).join(', ')}）`);
	} else if (write) {
		const runtime = runtimeStandardPresetPath();
		if (!runtime) { console.error('✗ 找不到 runtime 里的官方 standard preset（先装 poc/dsh-p0/.runtime）'); process.exit(1); }
		const baseline = fs.readFileSync(runtime, 'utf8');
		fs.writeFileSync(BASELINE_PATH, baseline, 'utf8');
		// ★ 统一写成 **LF**（2026-10-21）：rows 文件里可能混着 CRLF（多人/多工具编辑）⇒ 生成物
		//   跟着混 ⇒ 提交进 git 后 blob 混行、checkout 又被 autocrlf 统一转换 ⇒ 比对/diff 都难说清。
		//   归一化后生成物是纯 LF，git 负责按平台 checkout ✓。
		fs.writeFileSync(PRESET_PATH, normEol(expectedPresetText(baseline, ourRows)), 'utf8');
		fs.writeFileSync(BASE_ROWS_PATH, normEol(await expectedBaseRowsText(baseline, ourRows)), 'utf8');
		console.log(`已写入（baseline 来自 ${path.relative(process.cwd(), runtime)}）：`);
		console.log(`  ${path.relative(process.cwd(), BASELINE_PATH)}（${baseline.split(/\r?\n/).length} 行）`);
		console.log(`  ${path.relative(process.cwd(), PRESET_PATH)}（${expectedPresetText(baseline, ourRows).split(/\r?\n/).length} 行）`);
		console.log(`  ${path.relative(process.cwd(), BASE_ROWS_PATH)}`);
	} else {
		const problems = [];
		if (!fs.existsSync(BASELINE_PATH)) { problems.push('缺 baseline 文件（跑 --write）'); }
		if (!fs.existsSync(PRESET_PATH)) { problems.push('缺 cordis.presets.yml（跑 --write）'); }
		if (!problems.length) {
			const baseline = fs.readFileSync(BASELINE_PATH, 'utf8');
			const runtime = runtimeStandardPresetPath();
			if (!runtime) {
				console.log('ℹ 找不到 runtime ⇒ 跳过"baseline 是否还等于官方"那一半检查（离线可跑的部分仍然会查 ✓）');
			} else if (!samePresetContent(fs.readFileSync(runtime, 'utf8'), baseline)) {
				problems.push(`baseline 与 runtime 里的官方 standard preset 不一致（官方改了 ⇒ 跑 --write 并审 diff）：${path.relative(process.cwd(), runtime)}`);
			}
			const expected = expectedPresetText(baseline, ourRows);
			if (!samePresetContent(fs.readFileSync(PRESET_PATH, 'utf8'), expected)) {
				problems.push('cordis.presets.yml 与"baseline + 我们的行"不一致（手改过？或 rows 文件改了没重生成？）⇒ 跑 --write');
			}
			// agent 共享基座：必须等于"baseline + rows 里的官方行"（谁手改了基座、或 baseline 变了没重生成 ⇒ 红）
			if (!fs.existsSync(BASE_ROWS_PATH)) {
				problems.push(`缺 agent 共享基座 ${path.relative(process.cwd(), BASE_ROWS_PATH)}（跑 --write-agent-base）`);
			} else if (!samePresetContent(fs.readFileSync(BASE_ROWS_PATH, 'utf8'), await expectedBaseRowsText(baseline, ourRows))) {
				problems.push('agent 共享基座（presetBase.generated.js）与 baseline 不一致（手改过？或 baseline/rows 变了没重生成？）⇒ 跑 --write-agent-base');
			}
			// ★ 自检（2026-10-21）：拿一份**真的 CRLF 文件**走一遍比对 ⇒ 必须判一致。
			//   这条就是"逐字比对"回归的守卫：谁把比对改回 `!==`，这里立刻红（而不是等某个新克隆踩到）。
			{
				const tmp = path.join(os.tmpdir(), 'preset-sync-eol-selftest.yml');
				try {
					fs.writeFileSync(tmp, normEol(expected).replace(/\n/g, '\r\n'), 'utf8');
					const back = fs.readFileSync(tmp, 'utf8');
					if (!samePresetContent(back, expected)) {
						problems.push('EOL 不变性自检失败：CRLF 文件应判为与 LF 一致（比对必须 EOL 无关）');
					}
				} finally {
					try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉也不影响判定 */ }
				}
			}
		}
		if (problems.length) {
			console.error(`✗ preset 生成物有问题（${problems.length} 处）：`);
			for (const p of problems) { console.error(`   - ${p}`); }
			process.exitCode = 1;
		} else {
			console.log('✓ 我们的 preset 生成物自洽（baseline + 我们的行），且（若 runtime 在）baseline 仍等于官方 ✓');
		}
	}
}
