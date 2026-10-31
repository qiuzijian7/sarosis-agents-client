// @vssaros/dsh-scheduler — 任务持久化（自建调度）。
//
// ★ 与官方 `@deepseek-ai/dsh-schedule` 的关键差别：官方把任务**存在会话里**，我们存在
//   `<数据根>/scheduler/tasks.json`。理由：任务要能被 work item 账本引用、要能跨会话存在、
//   要能整体导出迁移——寄生在会话里这三点都做不到。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { foundation } from './foundationRef.js';

export const TASKS_FILE = 'tasks.json';
/** 读入口径自卫（与群/模板同款）：超过这个尺寸就不读，避免把日志之类当任务文件。 */
const FILE_MAX = 4 * 1024 * 1024;

export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（唯一真源），与 siblings 同口径。
	return foundation().dataRootOf(config);
}

export function tasksPathOf(config) {
	return join(dataRootOf(config), 'scheduler', TASKS_FILE);
}

/** 空库。 */
export const emptyTasks = () => ({ version: 1, tasks: [], history: [] });
/** 投递历史保留条数（封顶裁最旧，与群 transcript 同一条纪律）。 */
export const HISTORY_KEEP = 200;

/**
 * 读。坏文件 ⇒ 空库 + 说明（**不抛**：读不懂任务库不该让 Host 起不来，
 * 但必须如实报告，否则表现成"定时任务突然全没了"——那是最坏的一种静默）。
 */
export function readTasks(config) {
	const file = tasksPathOf(config);
	if (!existsSync(file)) {
		return { tasks: emptyTasks(), note: '' };
	}
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		return { tasks: emptyTasks(), note: `读取失败：${String(error?.message ?? error)}` };
	}
	if (raw.length > FILE_MAX) {
		return { tasks: emptyTasks(), note: `${TASKS_FILE} 超过 ${FILE_MAX} 字节，已按空库处理` };
	}
	try {
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed?.tasks) ? parsed.tasks.filter(t => t && typeof t === 'object' && t.id) : [];
		const history = Array.isArray(parsed?.history)
			? parsed.history.filter(h => h && typeof h === 'object').slice(-HISTORY_KEEP)
			: [];
		return { tasks: { version: 1, tasks: list, history }, note: '' };
	} catch (error) {
		return { tasks: emptyTasks(), note: `解析失败：${String(error?.message ?? error)}` };
	}
}

/**
 * 原子写：tmp → rename。
 * 为什么必须原子：任务库里存着 `next.target` 与 `lastRun.seq` —— 半截 JSON 会让
 * "这条已经跑过了"的事实丢失，后果是**同一个任务重复投递**。
 */
export function writeTasks(config, tasks) {
	const file = tasksPathOf(config);
	mkdirSync(join(dataRootOf(config), 'scheduler'), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(tasks ?? emptyTasks(), null, 2)}\n`, 'utf8');
	renameSync(tmp, file);
	return file;
}
