/*---------------------------------------------------------------------------------------------
 *  check-kv-symmetry.mjs — 存储口径对称性守卫（2026-10-21）
 *
 * ## 为什么要有它（两次同源的血泪）
 *  ① **技能页长期"总技能 0"**：技能写进 `mem:skills:<agent>`（key='data' 的数组），
 *     而 provider 只读 `mem:procedural:<agent>` ⇒ **数据在，但读的那份是空的** ✗✗
 *     （用户看到的是"从没提取过技能"—— 典型"哑巴失败"）。
 *  ② **审计页长期空白**：审计写在**落盘账本**（`<数据根>/memory-audit/audit.jsonl`），
 *     而页面读的是引擎**内存** AuditLog ⇒ 同病。
 *  ⇒ 共性：**"写在哪"与"读在哪"分家了** ⇒ 历史数据静默不可见，且**没有任何报错**。
 *
 * ## 本守卫抓什么
 * 扫引擎源码里每个 `KV.<scope>(agentId)` 的用法，分类成 **写**（set/delete/clearScope）
 * 与 **读**（get/list/listKeys）⇒ 报出 **"有写无读"** 的 scope：
 *   —— 那是"数据落在这个 scope，但引擎里没有任何地方读它"⇒ **极可能**是口径分家（①②的形态）。
 * ⚠ 判据是**启发式**（静态扫源码）⇒ 只报"有写无读"这一类（噪音可控）；
 *   "有读无写"不在本守卫范围（可能由别处写、也可能本来就是只读配置）⇒ 只在报告里提示。
 *
 * 用法：node extensions/agentmemory-memory/scripts/check-kv-symmetry.mjs
 *   退出码 0 = 通过；1 = 有"有写无读"的 scope（需人工确认或补读侧）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/**
 * **关键 scope 清单**：这些 scope 的**数据是别的进程写、引擎读**的（网关 / dsh 记忆插件），
 * ⇒ 引擎里一旦**没有读侧**，那份数据就**静默不可见**（用户看到的是"没有"而不是"读不到"）✗✗。
 *
 * 这正是两次血泪的形态：
 *   · `mem:skills:<agent>` —— 写方是网关（key='data' 的数组），引擎只读 `mem:procedural`
 *     ⇒ 技能页长期"总技能 0"（2026-10-21 修：读时兼容旧口径）。
 *   · `mem:audit:<agent>` —— 审计的真源是**落盘账本**（`memory-audit/audit.jsonl`），
 *     引擎内存 AuditLog 恒空 ⇒ 审计页长期空白（2026-10-21 修：新增 getAuditLedger）。
 * ⇒ 下面的清单就是"这些 scope 必须有人读"的**显式约定** ⇒ 读侧被删 ⇒ 本守卫立刻红 ✓
 */
const CRITICAL_SCOPE_READERS = {
	skillStore: '技能（写方=网关/插件，读方=provider 的 _readSkills）',
	slots: '固定槽位（写方=引擎 setSlot，读方=provider 的 getSlots）',
	sessions: '会话清单（写方=引擎/插件，读方=provider 的 listSessions）',
	summaries: '会话摘要（写方=引擎，读方=provider 的 listSummaries）',
	observations: '观测（写方=引擎/插件，读方=provider 的 observeList）',
	memories: '长期记忆（写方=引擎，读方=provider 的 searchMemory）',
	semantic: '语义记忆（写方=引擎，读方=provider 的 semanticList）',
	coreMemory: 'working 记忆（写方=引擎，读方=provider 的 coreMemoryList）',
	procedural: '程序化记忆/技能新口径（写方=provider 的 addSkill，读方=_readSkills）',
};
/** 允许"有写无读"的 scope（它们的读者在**引擎之外**：网关/插件/运维脚本）。 */
const WRITE_ONLY_ALLOWED = new Set([
	'config',       // 引擎配置（外部可写、引擎只按需读）
	'profiles',
	'state',
	'access',
	'retention',
	'actions',
	'signals',
	'checkpoints',
]);

/** 从 amSchema.ts 提取 scope 函数名 → 模板。 */
function readScopes() {
	const schema = fs.readFileSync(path.join(SRC, 'amSchema.ts'), 'utf8');
	const scopes = new Map();
	for (const line of schema.split('\n')) {
		// ⚠ 参数**不止一个**的 scope 也要认（`observations(agentId, sessionId)`）⇒ 只认一参会漏掉它 ✗
		const m = line.match(/(\w+):\s*\([^)]*\)\s*=>\s*`([^`]+)`/);
		if (m) { scopes.set(m[1], m[2]); }
	}
	return scopes;
}

function main() {
	const scopes = readScopes();
	if (!scopes.size) {
		console.error('✗ 没能从 amSchema.ts 解析出 scope 定义（格式变了？）⇒ 守卫自身失效');
		process.exit(1);
	}
	const writes = new Map();   // scope → Set("file:line")
	const reads = new Map();
	const files = fs.readdirSync(SRC).filter(f => f.endsWith('.ts'));
	// ⚠ 判据要覆盖三种写法（第一版只认"同一行"⇒ 18 个**误报** ✗）：
	//   ① `kv.list(KV.memories(a))`      —— 同��内联
	//   ② `kv.list<any>(KV.memories(a))`  —— **带泛型参数**
	//   ③ `const scope = KV.memories(a);` + 下一行 `kv.list(scope)` —— **跨行变量绑定**
	// ⇒ 先收集"变量 → scope"绑定，再扫读/写调用。
	const callRe = (names) => new RegExp(`\\.(?:${names.join('|')})(?:<[^>]*>)?\\s*\\(`);
	const readRe = callRe(['get', 'list', 'listKeys']);
	const writeRe = callRe(['set', 'delete', 'clearScope']);
	for (const f of files) {
		const rawLines = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n');
		// ⚠⚠ **必须去掉注释**（第四个误报源！）：注释里写着 `KV.skillStore(agentId)` 的说明文字
		//   会被当成"读侧"⇒ 于是"把读侧全删掉"这个突变**守卫也不红**（假绿 ⇒ 守卫不可信 ✗✗）。
		//   ⇒ 用**块注释状态机**逐行剔除（`/* … */` 区间 + `//` 行尾）；
		//     逐行正则（`^\s*\*`）在 **CRLF** 与各种缩进下不可靠（实测漏判）✗。
		const lines = [];
		let inBlock = false;
		for (const raw of rawLines) {
			let s = raw.replace(/\r$/, '');
			if (inBlock) {
				const end = s.indexOf('*/');
				if (end < 0) { lines.push(''); continue; }
				s = s.slice(end + 2);
				inBlock = false;
			}
			const blockStart = s.indexOf('/*');
			if (blockStart >= 0) {
				const end = s.indexOf('*/', blockStart + 2);
				if (end < 0) { s = s.slice(0, blockStart); inBlock = true; }
				else { s = s.slice(0, blockStart) + s.slice(end + 2); }
			}
			const lineComment = s.indexOf('//');
			if (lineComment >= 0) { s = s.slice(0, lineComment); }
			lines.push(s.trim());
		}
		// ① 变量绑定：`const|let|var <name> = KV.<scope>(...)`
		const bound = new Map();   // 变量名 → scope 名
		lines.forEach(line => {
			const m = line.match(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*KV\.(\w+)\(/);
			if (m && scopes.has(m[2])) { bound.set(m[1], m[2]); }
		});
		lines.forEach((line, i) => {
			const where = `${f}:${i + 1}`;
			// ② 写：`kv.set(KV.x(...))` / `kv.set(scopeVar)` / `kv.delete(...)`
			if (writeRe.test(line)) {
				for (const name of scopes.keys()) {
					if (!new RegExp(`KV\\.${name}\\(`).test(line)) { continue; }
					if (!writes.has(name)) { writes.set(name, new Set()); }
					writes.get(name).add(where);
				}
				for (const [varName, scopeName] of bound) {
					if (new RegExp(`\\.\\w+(?:<[^>]*>)?\\s*\\([^)]*\\b${varName}\\b`).test(line)) {
						if (!writes.has(scopeName)) { writes.set(scopeName, new Set()); }
						writes.get(scopeName).add(where);
					}
				}
			}
			// ③ 读：同上，但认 get/list/listKeys
			if (readRe.test(line)) {
				for (const name of scopes.keys()) {
					if (!new RegExp(`KV\\.${name}\\(`).test(line)) { continue; }
					if (!reads.has(name)) { reads.set(name, new Set()); }
					reads.get(name).add(where);
				}
				for (const [varName, scopeName] of bound) {
					if (new RegExp(`\\.\\w+(?:<[^>]*>)?\\s*\\([^)]*\\b${varName}\\b`).test(line)) {
						if (!reads.has(scopeName)) { reads.set(scopeName, new Set()); }
						reads.get(scopeName).add(where);
					}
				}
			}
		});
	}
	const problems = [];
	const notes = [];
	// ★ 关键 scope 必须有读侧（跨边界口径的显式约定 ⇒ 读侧被删就红 ✓）
	for (const [name, why] of Object.entries(CRITICAL_SCOPE_READERS)) {
		if (!scopes.has(name)) { problems.push(`关键 scope 清单里的 ${name} 在 amSchema.ts 里已不存在 ⇒ 清单要更新（${why}）`); continue; }
		const r = reads.get(name) || new Set();
		if (r.size === 0) {
			problems.push(`关键 scope ${name}（${scopes.get(name)}）在引擎里**没有读侧** ⇒ `
				+ `它的数据（写方在引擎之外）就**静默不可见**（用户看到"没有"而不是"读不到"）✗ —— ${why}`);
		}
	}
	for (const [name, tpl] of scopes) {
		const w = writes.get(name) || new Set();
		const r = reads.get(name) || new Set();
		if (w.size > 0 && r.size === 0) {
			const where = [...w].slice(0, 3).join(', ');
			if (WRITE_ONLY_ALLOWED.has(name)) {
				notes.push(`${name}（${tpl}）有写无读（白名单内：读者在引擎之外）—— 写点 ${where}`);
			} else {
				problems.push(`${name}（${tpl}）有写无读：写到这里的 ${where}，但引擎里**没有任何地方读它** ⇒ `
					+ `数据落在这个 scope、读侧却读不到 ⇒ “写/读口径分家”（技能页与审计页都是这个病根）✗`);
			}
		}
	}
	for (const n of notes) { console.log(`  ℹ ${n}`); }
	if (problems.length) {
		console.error(`\n✗ 存储口径对称性检查失败（${problems.length} 项）：`);
		for (const p of problems) { console.error(`  · ${p}`); }
		console.error('\n  处置：① 确认这个 scope 的读者是否在引擎之外（网关/插件）；'
			+ '② 若数据真的没人读，要么补读侧（页面/provider），要么别再写它（写它只是为了“留痕”而没人看 = 误导）✗');
		process.exit(1);
	}
	console.log(`✓ 存储口径对称性通过（${scopes.size} 个 scope，${files.length} 个源文件）`);
}

main();