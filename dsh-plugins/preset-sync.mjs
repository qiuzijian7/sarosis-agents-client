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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'vssaros-agents');
export const BASELINE_PATH = path.join(DIR, 'preset-standard.baseline.yml');
export const ROWS_PATH = path.join(DIR, 'preset-vssaros.rows.yml');
export const PRESET_PATH = path.join(DIR, 'cordis.presets.yml');

/** 我们的 preset 标识（`config.id`，会话保存的就是它 ✓）。 */
export const OUR_PRESET_ID = 'vssaros-standard';
/** 行 id（Loader 编辑地址 ✓）。 */
export const OUR_PRESET_ROW_ID = 'preset-vssaros-standard';
/** `order`：官方 standard=1 / ptc=2 ⇒ 我们排 3（只影响列表显示顺序 ✓）。 */
export const OUR_PRESET_ORDER = 3;
/**
 * `config.name`（**显示名**，2026-10-13 加）：官方 `standard` preset 自己**没有** `name` ⇒ dsh 与我们的
 * 页面都退回显示 **id** ✗，而这个 id 是 `vssaros-standard` ⇒ 用户界面上会冒出这个内部串（本次报障现场 ✗✗）。
 * `description` 级的友好名 = `standard`（与官方那条"没有 name 时显示 `standard`"的观感一致 ✓）。
 * ⚠ 这是我们与官方 preset 的**又一处差异**，所以下面 `expectedPresetText` 的差异清单也要列上 ✓。
 */
export const OUR_PRESET_NAME = 'standard';

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

/** 把官方 preset 文本改造成"我们的 preset"：换 id / order 头 + 追加我们的行（其余**逐字**保留 ✓）。 */
export function buildOurPreset(baselineText, ourRowsText) {
	const lines = baselineText.split(/\r?\n/);
	const out = [];
	// ★ 2026-10-15（用户报 "This turn failed: unknown prompt variable {{cwd}}…"，修法 B）：
	//   **删掉 persona 行** —— 官方 standard 的 persona suffix 带 `{{cwd}}`，而子代理（deployment）
	//   作用域的变量表里没有 cwd ⇒ 挂着本 preset 的会话一派子代理，子代理每一轮都被插值器抛错
	//   中止 ✗（dsh-system-prompt/lib/index.js:169；dsh-persona 是按作用域**遮蔽**全局段的 ✓，
	//   所以只修全局层救不了挂本 preset 的会话 ✗）。
	//   删掉后由**全局层** persona 生效：我们每次运行的桥补丁已把全局 personaSuffix 烘焙成
	//   无变量的字面量（见 dshCli.ts renderBridgeOverlay 的 system-prompt 行 ✓）⇒ 根会话文案
	//   与今天**逐字一致** ✓、子代理作用域也能渲 ✓✓。
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

/** 期望的 `cordis.presets.yml` 内容（生成器与守卫**共用这一份**，免得两边各算一遍漂移 ✓）。 */
export function expectedPresetText(baselineText, ourRowsText) {
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
		buildOurPreset(baselineText, ourRowsText).replace(/\s+$/, ''),
		'',
	].join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	const write = process.argv.includes('--write');
	const ourRows = fs.existsSync(ROWS_PATH) ? fs.readFileSync(ROWS_PATH, 'utf8') : '';
	if (!ourRows.trim()) { console.error(`✗ 缺少我们的行源文件：${path.relative(process.cwd(), ROWS_PATH)}`); process.exit(1); }

	if (write) {
		const runtime = runtimeStandardPresetPath();
		if (!runtime) { console.error('✗ 找不到 runtime 里的官方 standard preset（先装 poc/dsh-p0/.runtime）'); process.exit(1); }
		const baseline = fs.readFileSync(runtime, 'utf8');
		fs.writeFileSync(BASELINE_PATH, baseline, 'utf8');
		fs.writeFileSync(PRESET_PATH, expectedPresetText(baseline, ourRows), 'utf8');
		console.log(`已写入（baseline 来自 ${path.relative(process.cwd(), runtime)}）：`);
		console.log(`  ${path.relative(process.cwd(), BASELINE_PATH)}（${baseline.split(/\r?\n/).length} 行）`);
		console.log(`  ${path.relative(process.cwd(), PRESET_PATH)}（${expectedPresetText(baseline, ourRows).split(/\r?\n/).length} 行）`);
	} else {
		const problems = [];
		if (!fs.existsSync(BASELINE_PATH)) { problems.push('缺 baseline 文件（跑 --write）'); }
		if (!fs.existsSync(PRESET_PATH)) { problems.push('缺 cordis.presets.yml（跑 --write）'); }
		if (!problems.length) {
			const baseline = fs.readFileSync(BASELINE_PATH, 'utf8');
			const runtime = runtimeStandardPresetPath();
			if (!runtime) {
				console.log('ℹ 找不到 runtime ⇒ 跳过"baseline 是否还等于官方"那一半检查（离线可跑的部分仍然会查 ✓）');
			} else if (fs.readFileSync(runtime, 'utf8') !== baseline) {
				problems.push(`baseline 与 runtime 里的官方 standard preset 不一致（官方改了 ⇒ 跑 --write 并审 diff）：${path.relative(process.cwd(), runtime)}`);
			}
			const expected = expectedPresetText(baseline, ourRows);
			if (fs.readFileSync(PRESET_PATH, 'utf8') !== expected) {
				problems.push('cordis.presets.yml 与"baseline + 我们的行"不一致（手改过？或 rows 文件改了没重生成？）⇒ 跑 --write');
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
