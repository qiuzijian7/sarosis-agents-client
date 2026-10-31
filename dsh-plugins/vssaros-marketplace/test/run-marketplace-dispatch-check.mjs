#!/usr/bin/env node
// @vssaros/dsh-marketplace — **动作分派**守卫（★ 2026-10-23）
//
// 为什么单开一套：分派原先是 `apply()` 里的 **6 层 if 嵌套**（self-check → LOCAL_OPS →
// LOCAL_WRITE_KINDS → updatePackage → reviewStatus → publishIsLocal → callIde 兜底），
// 而"哪个 op 去哪"这条**最容易错**的契约，此前**一个测试都没有** ✗
//   · 加一个 op 忘改某层 ⇒ 静默走到 IDE 兜底，报"不认识的商城动作"
//   · `OPS` 手写清单与真实分派漂移 ⇒ `/api/meta` 声明不全（已有 5 个 op 漂了）
//
// 抽到 `lib/dispatch.js`（纯函数）后，这里把**整张表**钉住 ✓
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-dispatch-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const dispatch = await import(pathToFileURL(path.join(LIB, 'dispatch.js')).href);
const {
	resolveOp, isKnownOp, ALL_OPS, WRITE_OPS,
	LOCAL_READ_OPS, LOCAL_WRITE_OPS, LOCAL_WRITE_KINDS, LOCAL_HTTP_OPS, LOCAL_PUBLISH_OPS,
} = dispatch;

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('★ 商城动作分派\n');

// ── ① 只读 / 写 / HTTP / 发布 四类：逐 op 钉住去向 ────────────────
{
	for (const op of LOCAL_READ_OPS) {
		check(`① ${op} ⇒ local-read`, resolveOp(op, {}) === 'local-read', resolveOp(op, {}));
	}
	for (const kind of LOCAL_WRITE_KINDS) {
		for (const op of LOCAL_WRITE_OPS) {
			check(`① ${op}(${kind}) ⇒ local-write`, resolveOp(op, { kind }) === 'local-write', resolveOp(op, { kind }));
		}
	}
	for (const op of LOCAL_HTTP_OPS) {
		check(`① ${op} ⇒ local-http`, resolveOp(op, {}) === 'local-http', resolveOp(op, {}));
	}
	for (const op of LOCAL_PUBLISH_OPS) {
		// delete* 是纯 HTTP，**不分 kind** ⇒ 传任何 kind 都应走本地
		check(`① ${op} ⇒ local-publish（不分 kind）`,
			resolveOp(op, {}) === 'local-publish' && resolveOp(op, { kind: 'workbench' }) === 'local-publish');
	}
}

// ── ② `publish` 的**唯一例外**：agent 必须交 IDE（包格式 agent.json）────
{
	check('② publish(skill) ⇒ local-publish', resolveOp('publish', { kind: 'skill' }) === 'local-publish');
	check('② publish(workflow) ⇒ local-publish', resolveOp('publish', { kind: 'workflow' }) === 'local-publish');
	// ★ 2026-10-23：agent **已能**由 dsh 打包发布 —— 因为 IDE 侧安装器现在也认目录镜像包
	//   （`agentInstaller.installFromAgentMd`）⇒ 当年"包格式只有 IDE 会组装"的限制已消失 ✓
	//   （历史：一度把 agent 的发布留在 IDE，别走回头路）
	check('② publish(agent) ⇒ local-publish（IDE 侧也认目录镜像包了）',
		resolveOp('publish', { kind: 'agent' }) === 'local-publish', resolveOp('publish', { kind: 'agent' }));
	check('② publish(workbench) ⇒ ide（要 dsh plugin add + 重启）',
		resolveOp('publish', { kind: 'workbench' }) === 'ide');
	check('② publish(缺 kind) ⇒ ide（不猜）', resolveOp('publish', {}) === 'ide');
}

// ── ③ 装升卸的 kind 边界 ────────────────────────────────────────
//   ★ 2026-10-23（用户「都转移到 dsh 侧实现」）：**mcp 已搬 dsh 侧**
//   ★ 2026-10-27：**workbench 也已被 `LOCAL_PLUGIN_KINDS` 收进 dsh 侧**
//     （装/升/卸 ⇒ `local-plugin`：有 pluginManager 就自己装，没有则调用方兜底回 IDE）
//   ★ 2026-10-31：**knowledge 也搬 dsh 侧** —— 它的本体就是 <数据根>/knowledge/<id>/ 那个目录
//     （publisher 会打、installers 会落 ⇒ 装/升/卸全部 local-write，不再推给 IDE）✓
//     ⇒ 现在**没有** kind 再纯交 IDE ✓
{
for (const kind of ['knowledge']) {
	check(`③ install(${kind}) ⇒ local-write`, resolveOp('install', { kind }) === 'local-write', resolveOp('install', { kind }));
	check(`③ upgrade(${kind}) ⇒ local-write`, resolveOp('upgrade', { kind }) === 'local-write');
	check(`③ uninstall(${kind}) ⇒ local-write`, resolveOp('uninstall', { kind }) === 'local-write');
}
	// workbench：装/升/卸走 **local-plugin**（不是 ide —— 那会让它默默绕回 IDE）
	for (const op of ['install', 'upgrade', 'uninstall']) {
		check(`③ ${op}(workbench) ⇒ local-plugin`, resolveOp(op, { kind: 'workbench' }) === 'local-plugin', resolveOp(op, { kind: 'workbench' }));
	}
	// mcp 必须走本地（否则又会默默绕回 IDE）
	check('③ install(mcp) ⇒ local-write（已搬 dsh 侧）', resolveOp('install', { kind: 'mcp' }) === 'local-write', resolveOp('install', { kind: 'mcp' }));
	check('③ upgrade(mcp) ⇒ local-write', resolveOp('upgrade', { kind: 'mcp' }) === 'local-write');
	check('③ uninstall(mcp) ⇒ local-write', resolveOp('uninstall', { kind: 'mcp' }) === 'local-write');
	check('③ install(缺 kind) ⇒ ide（不猜）', resolveOp('install', {}) === 'ide');
}

// ── ④ 未知 op / 空 op ⇒ ide 兜底，但 `isKnownOp` 必须否决 ─────────
{
	for (const op of ['', 'not-an-op', '../../etc/passwd', 'constructor', '__proto__']) {
		check(`④ ${JSON.stringify(op)} ⇒ ide 兜底`, resolveOp(op, {}) === 'ide');
		check(`④ ${JSON.stringify(op)} 不被 isKnownOp 认可`, isKnownOp(op) === false);
	}
	// 每个已知 op 都必须被认可（否则 callIde 会回"不认识的商城动作"）
	const notKnown = ALL_OPS.filter(op => !isKnownOp(op));
	check('④ ALL_OPS 里每个 op 都被 isKnownOp 认可', notKnown.length === 0, notKnown.join(', '));
	// 反过来：能被分派到本地的 op，必须在 ALL_OPS 里（否则外面对不上）
	const localOnly = [
		...LOCAL_READ_OPS, ...LOCAL_WRITE_OPS, ...LOCAL_HTTP_OPS, ...LOCAL_PUBLISH_OPS, 'publish',
	].filter(op => !ALL_OPS.includes(op));
	check('④ 所有本地 op 都在 ALL_OPS 里（对外声明不漏）', localOnly.length === 0, localOnly.join(', '));
}

// ── ⑤ 防漂移：index.js 不许再手写 op 清单 ────────────────────────
//   教训：`OPS` 曾是手写的，加了 publishables/reviewList/updatePackage 等 5 个 op 后没跟着改
//   ⇒ `/api/meta` 声明不全、`callIde` 白名单也不全 ✗
{
	const idx = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	check('⑤ index.js 不再手写 `const OPS = [...]`（真源在 dispatch.js）',
		!/^const OPS = \[/m.test(idx));
	check('⑤ index.js 不再手写 LOCAL_OPS 集合', !/const LOCAL_OPS = new Set/.test(idx));
	check('⑤ index.js 不再手写 LOCAL_WRITE_KINDS（从 dispatch 取）',
		!/^const LOCAL_WRITE_KINDS = /m.test(idx) && idx.includes('LOCAL_WRITE_KINDS'));
	check('⑤ 路由改用 resolveOp 分派（不再 6 层 if）',
		/resolveOp\(op, params\)/.test(idx) && /runLocalByTarget\(/.test(idx));
	check('⑤ callIde 白名单来自 isKnownOp（与分派同源）', /if \(!isKnownOp\(op\)\)/.test(idx));
	check('⑤ /api/meta 用 ALL_OPS 声明', idx.includes('ops: ALL_OPS'));
}

// ── ⑥ 错误契约：**每条路径**都必须回 200 + { ok:false }，不许飙 500 ──
//   原因：前端只认 `ok === false`；500 会让第三方调用方（以及排障）误以为是服务崩了 ✗
{
	const idx = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	// 本地分支：resolveOp 之后必须有 try/catch 包住
	check('⑥ 本地分支包了 try/catch（错误统一成 200 + ok:false）',
		/try \{\s*json\(200, await runLocalByTarget\(target, op, params\)\);\s*\} catch \(e\) \{\s*json\(200, \{ ok: false/.test(idx));
	// IDE 兜底：原先**裸调用**，是唯一会返回 500 的分支
	check('⑥ IDE 兜底也包了 try/catch（原先是裸调用 ⇒ 唯一 500 分支）',
		/try \{\s*json\(200, await callIde\(op, params\)\);\s*\} catch \(e\)/.test(idx));
}

// ── ⑦ 打包能力**只能有一份清单**（防两份打架）────────────────────
//   教训：dispatch 曾手写 `PUBLISH_LOCAL_KINDS = ['skill','workflow']`，而
//   `publisher.PUBLISHABLE_KINDS` 已加回 `agent` ⇒ 分派把 publish(agent) 送去 IDE，
//   而 dsh 侧明明能打包 ✗（本条断言就是抓这个的）
{
	const publisher = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);
	const { PUBLISH_LOCAL_KINDS } = await import(pathToFileURL(path.join(LIB, 'dispatch.js')).href);
	check('⑦ agent 能安装（在 LOCAL_WRITE_KINDS 里）', LOCAL_WRITE_KINDS.has('agent'));
	check('⑦ agent 能打包发布（在 PUBLISHABLE_KINDS 里）',
		publisher.PUBLISHABLE_KINDS.includes('agent'), publisher.PUBLISHABLE_KINDS.join(','));
	check('⑦ 分派的 PUBLISH_LOCAL_KINDS 与 publisher 的清单**完全同源**（不是抄一份）',
		JSON.stringify(PUBLISH_LOCAL_KINDS) === JSON.stringify(publisher.PUBLISHABLE_KINDS),
		`dispatch=${PUBLISH_LOCAL_KINDS.join(',')} publisher=${publisher.PUBLISHABLE_KINDS.join(',')}`);
	check('⑦ dispatch.js 里**没有**手写 publish kind 数组（必须是引用）',
		!/const PUBLISH_LOCAL_KINDS = \[/.test(fs.readFileSync(path.join(LIB, 'dispatch.js'), 'utf8')));
}

// ── ⑧ WRITE_OPS：长超时的判定要和"确实是写"一致 ────────────────────
{
	const shouldBeWrite = [...LOCAL_WRITE_OPS, 'publish', ...LOCAL_PUBLISH_OPS];
	const missing = shouldBeWrite.filter(op => !WRITE_OPS.has(op));
	check('⑧ 所有写类 op 都在 WRITE_OPS 里（否则转 IDE 时会用读超时 ⇒ 大包超时 ✗）',
		missing.length === 0, missing.join(', '));
	const wrong = [...WRITE_OPS].filter(op => !shouldBeWrite.includes(op));
	check('⑧ WRITE_OPS 里没有混进只读 op', wrong.length === 0, wrong.join(', '));
}

console.log(`\n[marketplace dispatch] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
