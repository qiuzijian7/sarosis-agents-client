// @vssaros/dsh-marketplace — 启动时「已安装台账」本机自对账（★ 2026-11-24）
//
// 背景与边界（调研结论）：
//   · `installed-packages.json` 是**本机**台账，dsh 与 IDE 双写同一份文件；
//   · `seed.json` 是构建期 profile 种子 marker（内置插件名单），运行时不读它；
//   · 服务端 `packages` 表**不保存任何机器/用户的安装状态**，也没有 install 上报 API。
//   ⇒ 不存在「服务端真源」可拉，能做的只有**本机自对账**。
//
// ★ 刻意只读：不删条目、不修坏 JSON、不重建目录。
//   删条目会同时破坏 installedState 的磁盘判据、Bot 组合包 owner 级联、
//   plugin/workbench 的唯一判据；坏文件策略由 installedLedger.strict 统一负责。
//   报告只用于诊断，由 Host 启动时跑一次并挂到 /api/meta。

import { readdir } from 'node:fs/promises';
import { resolveEntryVersion, hasDiskPresence, installedKey } from './installedState.js';
import { targetRootOf } from './installers.js';

/** 报告里每类明细最多列几条（真机曾有 100+ 幽灵条目，不能把整个响应撑爆）。 */
const LIMIT = 20;

/**
 * 只读扫描：台账 ↔ 磁盘落地物 ↔（可选）profile bundles。
 *
 * @param {{
 *   dataRoot?: string,
 *   entries?: Array<{kind?:string,storeId?:string,version?:string,packageName?:string,format?:string,owner?:string}>,
 *   bundles?: Array<{name:string,installed:boolean,version?:string}> | null,
 *   mcpJson?: {servers?:Record<string,unknown>} | null,
 * }} args
 * @returns {Promise<{
 *   scanned:number, installed:number,
 *   ghostCount:number, ghosts:string[],
 *   duplicateCount:number, duplicateKeys:string[],
 *   fieldDriftCount:number, fieldDrift:Array<{key:string,issues:string[]}>,
 *   orphanOwnerCount:number, orphanOwners:string[],
 *   orphanDirCount:number, orphanDirs:string[],
 *   checkedAt:string,
 * }>}
 */
export async function reconcileInstalled({ dataRoot, entries = [], bundles = null, mcpJson = null } = {}) {
	const report = {
		scanned: 0,
		installed: 0,
		ghostCount: 0, ghosts: [],
		duplicateCount: 0, duplicateKeys: [],
		fieldDriftCount: 0, fieldDrift: [],
		orphanOwnerCount: 0, orphanOwners: [],
		orphanDirCount: 0, orphanDirs: [],
		checkedAt: new Date().toISOString(),
	};
	if (!dataRoot || !Array.isArray(entries)) { return report; }

	const valid = entries.filter(e => e && typeof e.kind === 'string' && typeof e.storeId === 'string');
	const ledgerKeys = new Set(valid.map(e => installedKey(e.kind, e.storeId)));
	const storeIds = new Set(valid.map(e => e.storeId));
	const seen = new Set();

	for (const e of valid) {
		report.scanned++;
		const key = installedKey(e.kind, e.storeId);
		if (seen.has(key)) {
			report.duplicateCount++;
			if (report.duplicateKeys.length < LIMIT) { report.duplicateKeys.push(key); }
		}
		seen.add(key);

		// 字段漂移：这些字段是卸载/级联/冲突检测的真判据，缺了会静默失效
		const issues = [];
		if ((e.kind === 'plugin' || e.kind === 'workbench') && !e.packageName) {
			issues.push('missing:packageName');
		}
		if (!e.version) { issues.push('missing:version'); }
		if (e.owner && !storeIds.has(String(e.owner))) {
			report.orphanOwnerCount++;
			if (report.orphanOwners.length < LIMIT) { report.orphanOwners.push(key); }
		}
		if (issues.length) {
			report.fieldDriftCount++;
			if (report.fieldDrift.length < LIMIT) { report.fieldDrift.push({ key, issues }); }
		}

		// 磁盘判据复用唯一真源 installedState.resolveEntryVersion（不另写一套）
		let version = '';
		try {
			version = await resolveEntryVersion(dataRoot, e, { bundles: bundles ?? undefined, mcpJson });
		} catch { version = ''; }
		if (version) {
			report.installed++;
		} else if (hasDiskPresence(e.kind)) {
			// plugin/workbench 没有可查落地物 ⇒ 不报 ghost（只能信台账）
			report.ghostCount++;
			if (report.ghosts.length < LIMIT) { report.ghosts.push(key); }
		}
	}

	// 磁盘有目录但台账没记（只读列出，供用户手动判断；绝不自动登记/删除）
	for (const kind of ['skill', 'agent', 'mcp', 'knowledge']) {
		let names;
		try {
			names = (await readdir(targetRootOf(dataRoot, kind), { withFileTypes: true }))
				.filter(d => d.isDirectory()).map(d => d.name);
		} catch { continue; }
		for (const name of names) {
			if (ledgerKeys.has(installedKey(kind, name))) { continue; }
			report.orphanDirCount++;
			if (report.orphanDirs.length < LIMIT) { report.orphanDirs.push(`${kind}:${name}`); }
		}
	}
	return report;
}
