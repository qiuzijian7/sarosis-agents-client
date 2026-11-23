#!/usr/bin/env node
// @vssaros/dsh-marketplace — 升级回滚守卫（★ 2026-11-23）
//
// 守什么：备份点「列得出、选得对、恢复得回、失败不留半个目录」。
//   · 带连字符的 slug 不能被时间戳正则切错；
//   · 回滚留下的 pre-restore 目录不许被当成新的备份点；
//   · 恢复后目标内容真的回到旧版，且当前版本被留档（可再切回去）；
//   · 路径越界 / 没有备份 / 脏投影都要如实拒绝，不能假装成功。
//
// 全程真临时目录，不联网、不启 Host。
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-rollback-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const {
	parseBackupDirName, listRollbackPoints, planRollback, restoreRollbackPoint,
	validateRollbackPoint, BACKUP_DIR,
} = await import(pathToFileURL(path.join(LIB, 'upgradeBackup.js')).href);

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-rollback-'));
console.log('★ 升级备份点 / 回滚守卫\n');

// ── ① 目录名解析 ────────────────────────────────────────────────────
{
	const ok = parseBackupDirName('vssaros-release-pipeline-2026-11-23T12-34-56-789Z');
	check('① 带连字符的 slug 解析正确', ok?.id === 'vssaros-release-pipeline' && ok?.ts === '2026-11-23T12-34-56-789Z', JSON.stringify(ok));
	check('① 简单 slug 解析正确', parseBackupDirName('demo-skill-2026-11-23T10-00-00-000Z')?.id === 'demo-skill');
	for (const bad of ['', 'random-dir', '.upgrade-backup', 'demo-skill-2026-11-23T10-00-00-000Z-pre-restore', 'demo-skill-2026-11-23']) {
		check(`① 脏目录名被拒：${bad || '(空)'}`, parseBackupDirName(bad) === undefined);
	}
}

// ── ② 造一个真实升级现场：旧版备份 + 目标被改成新版 ──────────────────
const skillDir = path.join(dataRoot, 'skills', 'demo-skill');
const backupRoot = path.join(dataRoot, BACKUP_DIR);
const backupDir = path.join(backupRoot, 'demo-skill-2026-11-23T10-00-00-000Z');
fs.mkdirSync(skillDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '新版正文 v2');
fs.writeFileSync(path.join(backupDir, 'SKILL.md'), '旧版正文 v1');
fs.mkdirSync(path.join(backupRoot, 'not-a-backup'), { recursive: true });

{
	const points = await listRollbackPoints({ dataRoot, kind: 'skill' });
	check('② 只列出合法备份点', points.length === 1 && points[0].id === 'demo-skill', JSON.stringify(points.map(p => p.name)));
	const filtered = await listRollbackPoints({ dataRoot, kind: 'skill', storeId: 'other-skill' });
	check('② storeId 过滤生效', filtered.length === 0);
	const plan = await planRollback({ dataRoot, kind: 'skill', storeId: 'demo-skill' });
	check('② 计划选中最近备份', plan.ok === true && plan.ts === '2026-11-23T10-00-00-000Z' && plan.currentExists === true, JSON.stringify(plan));
	const missing = await planRollback({ dataRoot, kind: 'skill', storeId: 'never-installed' });
	check('② 没有备份时如实说明', missing.ok === false && /没有可回滚/.test(missing.reason), JSON.stringify(missing));
}

// ── ③ 恢复：内容回到旧版，当前版本留档，备份点仍可再用 ────────────────
{
	const res = await restoreRollbackPoint({ dataRoot, kind: 'skill', storeId: 'demo-skill' });
	check('③ 恢复成功', res.ok === true, JSON.stringify(res));
	check('③ 目标内容回到旧版', fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') === '旧版正文 v1');
	check('③ 当前版本留档可查', !!res.currentSavedTo && fs.existsSync(res.currentSavedTo), String(res.currentSavedTo));
	check('③ 留档内容是新版', fs.readFileSync(path.join(res.currentSavedTo, 'SKILL.md'), 'utf8') === '新版正文 v2');
	check('③ 原备份点保留（可重复回滚）', fs.existsSync(path.join(backupDir, 'SKILL.md')));
	const again = await listRollbackPoints({ dataRoot, kind: 'skill', storeId: 'demo-skill' });
	check('③ pre-restore 没被误当成备份点', again.length === 1, JSON.stringify(again.map(p => p.name)));
	const repeat = await restoreRollbackPoint({ dataRoot, kind: 'skill', storeId: 'demo-skill' });
	check('③ 同一备份点可重复恢复', repeat.ok === true && fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') === '旧版正文 v1');
}

// ── ④ 失败与越界：不许假装成功 ───────────────────────────────────────
{
	const r = await restoreRollbackPoint({ dataRoot, kind: 'skill', storeId: '../evil' }).catch(e => ({ ok: false, error: String(e?.message ?? e) }));
	check('④ 路径越界被拒（不抛 500）', r.ok === false, JSON.stringify(r));
	const noBackup = await restoreRollbackPoint({ dataRoot, kind: 'mcp', storeId: 'never-installed' });
	check('④ 无备份返回 ok:false + 原因', noBackup.ok === false && !!noBackup.error, JSON.stringify(noBackup));
	const badKind = await planRollback({ dataRoot, kind: 'unknown', storeId: 'demo-skill' });
	check('④ 不认识的 kind 被拒', badKind.ok === false && /不支持/.test(badKind.reason), JSON.stringify(badKind));
}

// ── ⑤ 页面投影：只留展示字段，磁盘路径不下发 ─────────────────────────
{
	const raw = (await listRollbackPoints({ dataRoot, kind: 'skill' }))[0];
	const clean = validateRollbackPoint({ ...raw, injected: 'evil' });
	check('⑤ 投影含 id/ts/kind', clean?.id === 'demo-skill' && !!clean?.ts && clean?.kind === 'skill');
	check('⑤ 投影不含 dir / 注入字段', clean && !('dir' in clean) && !('injected' in clean) && !('name' in clean), JSON.stringify(clean));
	check('⑤ 脏投影被拒', validateRollbackPoint(null) === undefined && validateRollbackPoint({ id: 'x' }) === undefined);
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n★ 回滚守卫：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { console.log('失败项：' + fails.join('、')); process.exit(1); }
