/**
 * @vssaros/dsh-plugins — SKILL.md 正文里的**相对脚本路径**检查器（2026-11-08 P2）。
 *
 * 事故缘由：官方 `resourceBase` 是技能目录的**绝对路径**，而进程 cwd 是会话工作区。
 * 技能正文里写 `python3 scripts/foo.py` 时模型照抄就会在当前工作区找 scripts/ ⇒ 必翻车。
 * 正确写法：用 `skill_search` 返回的 `skillDir`（绝对路径）拼，或写明 `<skillDir>/scripts/foo.py`。
 *
 * ⚠ 误伤面（实测 173 个技能里有 67 处历史写法）：
 *   · 仓库根相对：`node dsh-plugins/check-x.mjs` / `build/saros/x.mjs` / `src/vs/x` ⇒ 不是技能目录路径，不报；
 *   · 绝对路径 `/tmp/x.mjs`、变量 `$SKILL_DIR/...`、占位 `<skillDir>/...` ⇒ 不报；
 *   · 文档说明里刻意写的反例（"别写 `node scripts/x.js`"）⇒ 不报。
 * 所以守卫采用**基线 + 新增判红**：把现有 67 处登记为已知技术债，新增一处就红。
 */
import { createHash } from 'node:crypto';

/** 裸相对脚本调用：命令 + 不以 /、$、<、~、../ 开头的相对路径。 */
const SCRIPT_REF = /(?:^|[`\s(])(?:node|nodejs|python|python3|bash|sh|pwsh|ruby|perl)\s+((?!\/|\$|<|~|\.\.\/)(?:scripts|bin|tools|src)\/[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js|py|sh|ps1|rb|pl|ts))(?:\s|$|[`;])/gm;

/**
 * 仓库根相对写法：`src/...` 是仓库里常见的脚本入口（不是技能目录里的 scripts/）。
 * 注意别把 `scripts/` 列进来 —— 那正是要报的技能目录相对路径，
 * 而 `dsh-plugins/`、`build/` 根本不会被上面的正则命中（前缀只认 scripts|bin|tools|src）。
 */
const IGNORED_PREFIX = /^src\//;

/** 返回一个技能正文里所有裸相对脚本引用（去重、排序，便于做基线）。 */
export function scanScriptRefs(text) {
	const out = new Set();
	for (const match of String(text ?? '').matchAll(SCRIPT_REF)) {
		const path = match[1];
		if (IGNORED_PREFIX.test(path)) { continue; }
		out.add(path);
	}
	return [...out].sort();
}

/** 基线指纹：把「文件相对路径 → 引用列表」压成一个稳定 hash，新增/删除都会变。 */
export function baselineHash(rows) {
	const list = (Array.isArray(rows) ? rows : []).map(r => `${r.file ?? ''}|${(r.refs ?? []).join(',')}`).sort();
	return createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 16);
}

/** 与基线比对：只把**新增**的引用报出来（已有技术债不刷屏）。 */
export function newScriptRefs(rows, baseline) {
	const known = new Set();
	for (const row of Array.isArray(baseline) ? baseline : []) {
		for (const ref of row?.refs ?? []) { known.add(`${row.file}|${ref}`); }
	}
	const added = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		for (const ref of row?.refs ?? []) {
			const key = `${row.file}|${ref}`;
			if (!known.has(key)) { added.push(key); }
		}
	}
	return added;
}
