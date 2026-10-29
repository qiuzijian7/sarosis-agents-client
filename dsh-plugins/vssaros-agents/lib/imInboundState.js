// @vssaros/dsh-agents — 入站「上次是不是在跑」的持久化（2026-10-29）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 入站网关**不自动 start**（当初的理由：没凭据时反复重连只是噪音 —— 那条仍然成立）。
// 但那个决定漏了另一半：用户点了「启动入站」之后，**重启 Host 就悄悄回到未启动**，
// 界面只显示"未启动"，而用户以为"配好了" ⇒ 飞书里发消息永远没反应（2026-10-29 真机）。
// ⇒ 只记「用户点过启动」这一件事，重启时据此恢复；没点过仍然不自动连。
//
// ── 存储 ────────────────────────────────────────────────────────────────────
//   `<dataRoot>/agent-im-inbound.json`
//   { "version": 1, "enabled": { "feishu": true, "telegram": false } }
//   只记布尔，不记时间戳之外的任何东西（不涉及凭据）。
//
// ── 边界 ────────────────────────────────────────────────────────────────────
//   · 写入是**尽力而为**：start 成功之后才写；写失败只影响"下次不自动恢复"，绝不能反过来
//     让一次成功的启动失败（所以调用方 catch 掉）。
//   · 恢复是**逐个平台**的：某个平台凭据被撤了 ⇒ 那个 start 抛错，不影响其它平台。
import { renameWithRetry } from './atomicWrite.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';

/** 有独立入站网关的平台（企业微信是被动回调 ⇒ 没有"启动"这一步，也就不记状态）。 */
export const INBOUND_PLATFORMS = ['feishu', 'telegram', 'discord'];

const FILE_NAME = 'agent-im-inbound.json';

export function inboundStatePathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 读全量开关（缺文件/坏 JSON ⇒ 全 false，不抛）。 */
export async function readInboundEnabled(config) {
	const out = {};
	for (const p of INBOUND_PLATFORMS) { out[p] = false; }
	try {
		const body = JSON.parse(await readFile(inboundStatePathOf(config), 'utf8'));
		const enabled = body && typeof body.enabled === 'object' ? body.enabled : {};
		for (const p of INBOUND_PLATFORMS) { out[p] = enabled[p] === true; }
	} catch { /* 缺文件/坏 JSON ⇒ 全 false */ }
	return out;
}

/** 写某个平台的开关（其余平台保持原值）。 */
export async function setInboundEnabled(config, platform, enabled) {
	const key = String(platform ?? '').trim().toLowerCase();
	if (!INBOUND_PLATFORMS.includes(key)) {
		/* 未知/无网关平台（如 wecom）：不该被记录，直接返回当前状态 */
		return readInboundEnabled(config);
	}
	const cur = await readInboundEnabled(config);
	cur[key] = enabled === true;

	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const target = inboundStatePathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, JSON.stringify({ version: 1, enabled: cur }, null, 2), { encoding: 'utf8', mode: 0o600 });
	await renameWithRetry(tmp, target);
	try { await chmod(target, 0o600); } catch { /* Windows 上 chmod 无意义 */ }
	return cur;
}
