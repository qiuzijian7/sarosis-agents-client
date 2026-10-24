// @vssaros/dsh-scheduler — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-scheduler/test/run-scheduler-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）—— 与 check-workbench-style.mjs 同口径
//     ② 纯逻辑（migrate.toOfficialRequest：cron / one-shot / interval 的规范化与拒绝理由）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toOfficialRequest } from '../lib/migrate.js';

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
check('包名', pkg.name === '@vssaros/dsh-scheduler', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('cordis.patch.yml 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-scheduler'`), patch.split('\n').find((l) => l.includes('name:'))?.trim());

console.log('── 入口与组件 ──');
const entry = strip(read('lib/client.js'));
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(entry));
const componentFile = listLib().map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!componentFile, componentFile?.p.split(/[\\/]/).pop());
const src = componentFile?.text || '';
check('描述符带 repository（vssaros:<模块>）', /repository:\s*'vssaros:scheduler'/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*/g) || []).map((s) => s.slice(1)));
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 迁移逻辑：toOfficialRequest ──');
const TZ = 'Asia/Shanghai';
{
	const r = toOfficialRequest({ type: 'cron', name: '每日', prompt: '跑一下', cron: '0 9 * * *' }, TZ);
	check('cron 五字段 ⇒ 生成 request', !!r.request && r.request.cron?.expression === '0 9 * * *', JSON.stringify(r.request?.cron));
	check('cron 带时区', r.request?.cron?.time_zone === TZ);
	check('缺 name 时用「未命名任务」', toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 9 * * *' }, TZ).request?.title === '未命名任务');
}
check('cron 六字段 ⇒ 拒绝并说明「五字段」', /五字段/.test(toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 0 9 * * *' }, TZ).unsupported || ''));
check('cron 方言（L/W/#/@）⇒ 拒绝', /方言/.test(toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 9 L * *' }, TZ).unsupported || ''));
check('缺 prompt ⇒ 拒绝', /没有 prompt/.test(toOfficialRequest({ type: 'cron', cron: '0 9 * * *' }, TZ).unsupported || ''));
{
	const r = toOfficialRequest({ type: 'one-shot', prompt: 'x', at: '2026-11-01T09:30:00' }, TZ);
	check('one-shot ISO ⇒ 拆成 date + time', r.request?.at?.date === '2026-11-01' && r.request?.at?.time === '09:30:00', JSON.stringify(r.request?.at));
	check('one-shot 非 ISO ⇒ 拒绝', /不是 ISO/.test(toOfficialRequest({ type: 'one-shot', prompt: 'x', at: '明天早上' }, TZ).unsupported || ''));
}
check('interval <60s ⇒ 拒绝（官方下限）', /下限 60s/.test(toOfficialRequest({ type: 'interval', prompt: 'x', intervalSeconds: 30 }, TZ).unsupported || ''));
check('interval 90.7s ⇒ 取整 90', toOfficialRequest({ type: 'interval', prompt: 'x', intervalSeconds: 90.7 }, TZ).request?.every_seconds === 90);
check('未知 type ⇒ 拒绝并列出支持的三种', /只收 cron \/ one-shot \/ interval/.test(toOfficialRequest({ type: 'weekly', prompt: 'x' }, TZ).unsupported || ''));

console.log(`\n[scheduler] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
