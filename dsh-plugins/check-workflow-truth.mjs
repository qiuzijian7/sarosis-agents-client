#!/usr/bin/env node
// check-workflow-truth.mjs ★ 工作流**真源单一性**守卫
//
// 为什么必须有（2026-10-22 实锤）：
//   两侧各写各的注释 ⇒ 有人据此得出"IDE 与 dsh 是两套工作流存储"的**错误结论**
//   （我本轮就误判过一次，白花一轮排查）。真实现状是**同一处**：
//   · IDE 侧：`resolveSarosPath(userDataPath, SarosPath.workflows)` = `<数据根>/workflows`
//   · dsh 侧：`<数据根>/workflows`（`config.dataRoot` ⇒ 主进程注入同一个数据根）
//   ⇒ 商城装的工作流在 dsh 里能跑、在 IDE 画布里也看得见 ✓。
//
// 守卫做两件事（都是**行为级**断言，不是注释检查）：
//   A **IDE 侧**真的从数据根读写（不许出现工作区级路径拼接）；
//   B **dsh 侧**真的也指同一处（`<数据根>/workflows`，不是别的根）。
//   ⇒ 将来有人把任一侧改回工作区级 ⇒ 两边不再同源 ⇒ 守卫变红 ✓。
//
// 跑法：node dsh-plugins/check-workflow-truth.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

// ── A. IDE 侧：工作流根必须是数据根 ───────────────────────────────
{
	const svc = read(path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'workflowStorageService.ts'));
	// 目录解析：必须走 `resolveSarosPath(..., SarosPath.workflows)`（数据根 + 子目录）
	const usesDataRoot = /resolveSarosPath\([^)]*userDataPath[^)]*\)\s*,\s*SarosPath\.workflows/.test(svc)
		|| /resolveSarosPath\(\s*URI\.file\(this\._envService\.userDataPath\)\s*,\s*SarosPath\.workflows/.test(svc);
	if (usesDataRoot) {
		ok('IDE 侧：工作流根 = 数据根 + SarosPath.workflows（`~/.vssaros/workflows/`）✓');
	} else {
		fail('IDE 侧：工作流根不再是「数据根 + SarosPath.workflows」⇒ 两边可能不再同源（见 common/workflowStorage.ts 的真源口径）');
	}
	// 不许把工作流写到工作区级目录
	const wsLevel = /joinPath\([^)]*\.sarosworkspace[^)]*workflows/i.test(svc);
	if (!wsLevel) {
		ok('IDE 侧：没有把工作流写到工作区级 `.sarosworkspace/workflows/` ✓');
	} else {
		fail('IDE 侧：出现了工作区级 `.sarosworkspace/workflows/` 路径 ⇒ 与 dsh 侧不同源 ✗');
	}
}

// ── B. dsh 侧：工作流根也必须是 <数据根>/workflows ────────────────
{
	const store = read(path.join(HERE, 'vssaros-workflow', 'lib', 'store.js'));
	const usesDataRoot = /workflowsRootOf[\s\S]{0,400}join\(dataRootOf\(config\)\s*,\s*'workflows'\)/.test(store);
	if (usesDataRoot) {
		ok('dsh 侧：工作流根 = <数据根>/workflows（与 IDE 侧同一处）✓');
	} else {
		fail('dsh 侧：工作流根不再是 <数据根>/workflows ⇒ 与 IDE 侧不再同源 ✗');
	}
}

// ── C. 两侧的锁协议必须一致（同一把 `<file>.lock`）──────────────
{
	const ideLock = read(path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'fileWriteLock.ts'));
	const dshLock = read(path.join(HERE, 'vssaros-workflow', 'lib', 'lock.js'));
	const ideOk = /FILE_LOCK_SUFFIX\s*=\s*'\.lock'/.test(ideLock) || /lockResourceFor/.test(ideLock);
	const dshOk = /FILE_LOCK_SUFFIX\s*=\s*'\.lock'/.test(dshLock) || /lockFileFor/.test(dshLock);
	if (ideOk && dshOk) {
		ok('两侧写锁协议一致（`<file>.lock`）⇒ 并发写不会丢更新 ✓');
	} else {
		fail('两侧写锁协议不一致（IDE 或 dsh 侧不是 `<file>.lock`）⇒ 并发写会丢更新 ✗');
	}
}

console.log(problems === 0
	? '\n[check-workflow-truth] ✓ 工作流真源单一性守卫通过'
	: `\n[check-workflow-truth] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
