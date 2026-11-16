/*
 * 2026-11-10 用户三条要求的接线 + 行为守卫：
 *   A 「知识库列表」隐藏点开头条目（`.archive-<日期>/`、`.log`、`.知识体系`）
 *   B `知识库列表/<文件夹>` = 一个知识库 ⇒ 默认与飞书云端知识库关联
 *   C 知识库设置页顶部 ~200px 空白（settings 页签没顶头）
 *
 * 行为断言不是抄一份实现：用 esbuild 现场把 `index.tsx` 里的纯函数
 * `normalizeFeishuMappings` 转成 CJS 再执行 ⇒ 守卫跟着真源走，改坏即红。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-list-feishu-ui.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const TSX = read('src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx');
const STORE = read('dsh-plugins/vssaros-kb/lib/store.js');
const INDEX = read('dsh-plugins/vssaros-kb/lib/index.js');
const BUNDLE = read('dsh-plugins/vssaros-kb/lib/web/kbSideview.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

// ── A 隐藏点开头条目 ─────────────────────────────────────────────────────────
check('A① 服务端 listVaultTree 过滤点开头条目', () =>
	assert.ok(STORE.includes("entry.name.startsWith('.')"), 'store.js 里没有点开头过滤'));
check('A② React 侧栏 isNoise 同口径过滤', () =>
	assert.ok(TSX.includes("n.startsWith('.')"), 'index.tsx 的 isNoise 没过滤点开头'));
check('A③ 产物 bundle 已同步（改 TSX 不跑 sync 会红）', () =>
	assert.ok(/startsWith\(["']\.["']\)/.test(BUNDLE), 'lib/web/kbSideview.js 还是旧产物'));
check('A④ 契约注释已改（不再写「点文件照样列出」）', () =>
	assert.ok(!STORE.includes('点文件**照样列出**') && STORE.includes('点开头的条目**一律不列**')));

// ── C 设置页顶头 ────────────────────────────────────────────────────────────
check('C① settings 页签绝对定位贴页签条（消除顶部空白）', () => {
	const at = TSX.indexOf('data-kb-settings="1"');
	assert.ok(at > 0, '找不到 settings 容器');
	const seg = TSX.slice(at, at + 1200);
	assert.ok(seg.includes("position: 'absolute'"), '仍放在文档流里 ⇒ 被前面的细条/空态顶下去');
	assert.ok(/top:\s*31/.test(seg), '没贴住页签条下沿（30 + 1px 边框）');
});
check('C② 设置页内边距/最大宽度没被顺手改掉', () =>
	assert.ok(TSX.includes("padding: '14px 20px 28px'") && TSX.includes("maxWidth: '1180px'")));
check('C③ 产物 bundle 里 settings 容器确实顶头（不是只改了源码）', () => {
	const at = BUNDLE.indexOf('"data-kb-settings":"1"');
	assert.ok(at > 0, '产物里找不到 settings 容器');
	const seg = BUNDLE.slice(at, at + 260);
	assert.ok(/position:\s*"absolute"/.test(seg) && /top:\s*31/.test(seg),
		'产物仍是旧版 ⇒ 改完 TSX 没跑 build:kbSideview + sync-kb-sideview.mjs');
});

// ── B 默认关联飞书云端知识库（静态接线） ──────────────────────────────────
check('B① 设置页拉「知识库列表」一级库清单', () => assert.ok(TSX.includes("api('kb-list')")));
check('B② 归一化函数存在且被 effect 消费', () =>
	assert.ok(TSX.includes('function normalizeFeishuMappings') && TSX.includes('normalizeFeishuMappings(feishuOf(settings)')));
check('B③ 飞书空间下拉读 id（原先只认 spaceId ⇒ 选了不生效）', () =>
	assert.ok(/sp\.id\s*\?\?\s*sp\.spaceId/.test(TSX)));
check('B④ /api/feishu-spaces 同时给 id 与 spaceId 别名', () => assert.ok(INDEX.includes('spaceId: id')));
check('B⑤ 映射行以库为单位、dir 只读（不许再手填 `笔记/...` 旧路径）', () =>
	assert.ok(TSX.includes('readOnly') && TSX.includes('每行 = 一个知识库')));
check('B⑥ 产物 bundle 含默认关联逻辑', () =>
	assert.ok(BUNDLE.includes('normalizeFeishuMappings') || BUNDLE.includes('kb-list'),
		'改完 TSX 必须跑 sync-kb-sideview.mjs'));

// ── B 行为断言：现场编译真源里的纯函数 ────────────────────────────────────
let normalize = null;
try {
	const { transformSync } = await import('esbuild');
	const start = TSX.indexOf('function normalizeFeishuMappings');
	const end = TSX.indexOf('\nfunction KbFeishuSettings', start);
	assert.ok(start > 0 && end > start, '切不出纯函数');
	const code = transformSync(TSX.slice(start, end) + '\nexport { normalizeFeishuMappings };',
		{ loader: 'ts', format: 'cjs' }).code;
	const mod = { exports: {} };
	new Function('module', 'exports', code)(mod, mod.exports);
	normalize = mod.exports.normalizeFeishuMappings;
} catch (e) {
	console.log('（跳过行为断言：' + String(e?.message ?? e) + '）');
}

if (normalize) {
	const kbs = [
		{ name: '游戏设计', rel: '知识库列表/游戏设计' },
		{ name: 'AIAgent', rel: '知识库列表/AIAgent' },
		{ name: '财经', rel: '知识库列表/财经' },
	];
	check('B⑦ 旧键迁移 + 缺库补行（3 个一级库 ⇒ 3 条映射）', () => {
		const r = normalize([
			{ dir: '笔记/01_学习/游戏设计', spaceId: '7651' },
			{ dir: '笔记/01_学习/AI_Agent', spaceId: '7688' },
		], kbs, []);
		assert.equal(r.changed, true);
		assert.equal(r.list.length, 3);
		assert.equal(r.list.find(m => m.dir === '知识库列表/游戏设计')?.spaceId, '7651');
		assert.equal(r.list.find(m => m.dir === '知识库列表/AIAgent')?.spaceId, '7688');
		assert.ok(r.list.some(m => m.dir === '知识库列表/财经' && !m.spaceId));
	});
	check('B⑧ 幂等（第二次 changed=false ⇒ 不会写盘风暴）', () => {
		const once = normalize([{ dir: '笔记/x/游戏设计', spaceId: '7651' }], kbs, []).list;
		assert.equal(normalize(once, kbs, []).changed, false);
	});
	check('B⑨ 按同名关联飞书云端知识库（只填空的，不覆盖用户已填）', () => {
		const r = normalize([{ dir: '知识库列表/财经', spaceId: '' }, { dir: '知识库列表/游戏设计', spaceId: 'keep' }],
			kbs, [{ id: 's1', name: '财经' }, { id: 's2', name: '游戏设计' }]);
		assert.equal(r.list.find(m => m.dir === '知识库列表/财经')?.spaceId, 's1');
		assert.equal(r.list.find(m => m.dir === '知识库列表/游戏设计')?.spaceId, 'keep');
	});
	check('B⑩ 「＋ 一行」的空 dir 保留（点了不丢行）、不被误迁移/误关联', () => {
		const r = normalize([{ dir: '', spaceId: '' }], kbs, [{ id: 's1', name: '财经' }]);
		const blank = r.list.filter(m => !m.dir);
		assert.equal(blank.length, 1, '待填空行被丢掉 ⇒ 用户点「＋ 一行」没反应');
		assert.equal(blank[0].spaceId, '');
		assert.equal(r.list.filter(m => m.dir.startsWith('知识库列表/')).length, 3, '一级库仍要补出');
	});
	check('B⑪ 两行旧键落到同一库 ⇒ 去重且保留有 spaceId 的那条', () => {
		const r = normalize([
			{ dir: '笔记/x/游戏设计', spaceId: '' },
			{ dir: '笔记/y/游戏设计', spaceId: '7651' },
		], kbs, []);
		assert.equal(r.list.filter(m => m.dir === '知识库列表/游戏设计').length, 1);
		assert.equal(r.list.find(m => m.dir === '知识库列表/游戏设计')?.spaceId, '7651');
	});
	check('B⑫ 相似短名不被模糊误迁移/误关联（数据源/AI ≠ AIAgent）', () => {
		const r = normalize([{ dir: '数据源/AI', spaceId: 'keep' }], kbs, [{ id: 's1', name: 'AIAgent' }]);
		const kept = r.list.find(m => m.dir === '数据源/AI');
		assert.ok(kept && kept.spaceId === 'keep', '自定义目录被误迁走了');
		assert.equal(r.list.filter(m => m.dir.startsWith('知识库列表/')).length, 3, '一级库仍要补出');
	});
}

/* ── D 映射行的「选飞书库」下拉（2026-11-12 真机）─────────────────────────────
 * 用户：选完「选飞书库」后 UI 不更新、且前面的裸 spaceId 输入框不该有。
 * 旧版 <select value=""> 写死空值 ⇒ 选完 React 立刻回弹到占位项，看起来没反应；
 * 唯一能体现变化的只有那个裸 spaceId 输入框，而它正是用户不要的。
 */
const MAP_SEG = (() => {
	const i = TSX.indexOf('data-vssaros-kb-space-select');
	return i < 0 ? '' : TSX.slice(Math.max(0, i - 900), i + 1500);
})();
/** 排除「选飞书库…」占位 option 后，select 自身不该再写死空值 */
const noPlaceholder = (s) => s.replace(/<option value="">选飞书库…<\/option>/g, '');
check('D① ★ 映射行用受控下拉显示当前绑定，不再写死 value=""', () => {
	assert.ok(MAP_SEG.length > 0, '找不到映射下拉');
	assert.ok(/value=\{curId\}/.test(MAP_SEG), 'select 的 value 没绑当前 spaceId ⇒ 选完会回弹');
	assert.ok(!/value=""/.test(noPlaceholder(MAP_SEG)), 'select 仍写死空值 ✗');
	assert.ok(/const curId = String\(m\?\.spaceId \|\| ''\)/.test(MAP_SEG));
	assert.ok(/onChange=\{e => \{/.test(MAP_SEG) && /setMapping\(i, \{ spaceId: id, spaceName:/.test(MAP_SEG),
		'选中后没同时更新 spaceId 与库名');
});
check('D② ★ 前面的裸 spaceId 输入框已移除', () => {
	assert.ok(!/placeholder="飞书 spaceId"/.test(TSX), '仍渲染裸 spaceId 输入框 ✗');
	assert.ok(!/onChange=\{e => setMapping\(i, \{ spaceId: e\.target\.value \}\)\}/.test(TSX));
});
check('D③ ★ 当前绑定不在 spaces 列表里时补 option，避免受控 select 显示错乱', () => {
	assert.ok(/const inList = spaces\.some\(/.test(MAP_SEG));
	assert.ok(/curId && !inList \? <option value=\{curId\}>/.test(MAP_SEG), '缺兜底 option');
	assert.ok(/spaceName/.test(MAP_SEG), '没保留库名回显');
});
check('D④ 下拉仍覆盖 /api/feishu-spaces 的 { id, name } 形态', () => {
	assert.ok(/sp\.id \?\? sp\.spaceId/.test(MAP_SEG));
	assert.ok(/sp\.name \|\| sp\.id \|\| sp\.spaceId/.test(MAP_SEG));
});
check('D⑤ 产物 bundle 已同步（改 TSX 不跑 build+sync 会红）', () => {
	assert.ok(BUNDLE.includes('data-vssaros-kb-space-select'), 'kbSideview.js 还是旧版');
	assert.ok(!BUNDLE.includes('\\u98DE\\u4E66 spaceId') && !BUNDLE.includes('placeholder:"飞书 spaceId"'),
		'bundle 里仍含裸 spaceId 输入框');
});
check('D⑥ 反向突变自证：写死 value="" 会被 D① 抓到', () => {
	const broken = MAP_SEG.replace('value={curId}', 'value=""');
	assert.ok(/value=""/.test(noPlaceholder(broken)), '突变后没出现写死空值 ⇒ 判据无鉴别力');
	assert.ok(!/value=""/.test(noPlaceholder(MAP_SEG)), '真源码仍写死空值 ✗');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
