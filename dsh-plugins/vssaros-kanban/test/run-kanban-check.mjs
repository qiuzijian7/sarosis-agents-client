// @vssaros/dsh-kanban — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-kanban/test/run-kanban-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）
//     ② 纯逻辑（board.js 的列定义 / 状态映射 / 计数）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_COLUMNS, COLUMN_LIMIT, PREVIEW_LIMIT, countsByStatus, statusIcon, statusLabel, STATUS_ICONS, STATUS_LABELS } from '../lib/board.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listLib = (dir = path.join(ROOT, 'lib'), out = []) => {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { listLib(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
};
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name + (detail ? '  — ' + String(detail).slice(0, 90) : '')); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

const pkg = JSON.parse(read('package.json'));

console.log('── 清单与激活 ──');
check('包名', pkg.name === '@vssaros/dsh-kanban', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('cordis.patch.yml 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-kanban'`), patch.split('\n').find((l) => l.includes('name:'))?.trim());

console.log('── 入口与组件 ──');
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const componentFile = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!componentFile, componentFile?.p.split(/[\\/]/).pop());
const src = componentFile?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:kanban'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*'/g) || []).map((s) => s.slice(1, -1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 列定义 ──');
check('6 列（含 triage / archived）', BOARD_COLUMNS.length === 6, BOARD_COLUMNS.map((c) => c.key).join(','));
check('列 key 唯一', new Set(BOARD_COLUMNS.map((c) => c.key)).size === BOARD_COLUMNS.length);
const running = BOARD_COLUMNS.find((c) => c.key === 'running');
check('「执行中」列不接受落卡（dropStatus=null）', running?.dropStatus === null, String(running?.dropStatus));
check('「执行中」列聚合 blocked（阻塞不单独占列）', (running?.statuses || []).includes('blocked'));
const archived = BOARD_COLUMNS.find((c) => c.key === 'archived');
check('归档列默认折叠但仍在（startCollapsed + dropStatus）', archived?.startCollapsed === true && archived?.dropStatus === 'archived');
const covered = new Set(BOARD_COLUMNS.flatMap((c) => c.statuses));
const allStatuses = Object.keys(STATUS_ICONS);
check('8 个状态都被某一列收着（防「卡片消失」）', allStatuses.every((s) => covered.has(s)), allStatuses.filter((s) => !covered.has(s)).join(',') || '全覆盖');
check('上限常量就位（列 100 / 预览 80）', COLUMN_LIMIT === 100 && PREVIEW_LIMIT === 80, `${COLUMN_LIMIT}/${PREVIEW_LIMIT}`);

console.log('── 状态映射与计数 ──');
check('statusIcon 已知状态', statusIcon('running') === STATUS_ICONS.running, statusIcon('running'));
check('statusIcon 未知状态回落 ⬜', statusIcon('nope') === '⬜', statusIcon('nope'));
check('statusLabel 已知状态给中文', statusLabel('triage') === '待分解', statusLabel('triage'));
check('statusLabel 未知状态原样返回（不吞掉）', statusLabel('weird') === 'weird', statusLabel('weird'));
check('STATUS_LABELS 覆盖全部状态', Object.keys(STATUS_ICONS).every((s) => !!STATUS_LABELS[s]));
{
	const counts = countsByStatus([{ status: 'todo' }, { status: 'todo' }, { status: 'done' }, null, {}, 'x']);
	check('countsByStatus 按状态计数', counts.todo === 2 && counts.done === 1, JSON.stringify(counts));
	// 已知语义（如实钉住，别当成 bug 又改回去）：
	//   · `null` / 字符串被忽略；
	//   · **空对象 `{}` 会被计入**（status 落空字符串桶）—— IDE 侧不会产出这种数据，暂不改实现。
	check('countsByStatus 的 total 只数对象（空对象也计入）', counts.total === 4, String(counts.total));
	check('countsByStatus 给空状态留了空桶（不丢数据）', counts[''] === 1, JSON.stringify(counts));
	check('countsByStatus 对非数组输入不崩', countsByStatus(null).total === 0);
}

console.log(`\n[kanban] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
