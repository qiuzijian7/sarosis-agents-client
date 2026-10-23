// @vssaros/dsh-marketplace — **MCP 的 dsh 侧安装/卸载**（★ 2026-10-23 用户："都转移到 dsh 侧实现"）
//
// 之前 mcp 的装/升/卸**全在 IDE**（`agentStudio/browser/installers/mcpInstaller.ts`）。
// 但它做的事情其实很"文件化"：
//   ① 解包 → 写 `<数据根>/mcp/<id>/`（含 `config.json`）
//   ② 把 `config.json` 转成一条 entry，**合并进** `<数据根>/mcp.json` 的 `servers[<id>]`
//   ③ 卸载 = 删目录 + 删 `servers[<id>]`
// ⇒ 三件事都只是读写 JSON/目录，**dsh 侧完全能做**，不必绕 IDE ✓
//
// ⚠ 与 IDE 侧保持**逐字段一致**（同一个 `mcp.json` 会被两边读到）：
//   · 顶层是 `servers`（不是 `mcpServers`）
//   · entry 形状见 `toMcpEntry()`（照搬 `mcpInstaller._convertToMcpJsonEntry`）
//   · `inputs` 等其它顶层键**原样保留**（IDE 写了别的东西不能被我踩掉 ✗）

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** mcp.json 里服务器条目的形状（与 IDE 侧一致）。 */
export function toMcpEntry(config) {
	const cfg = config ?? {};
	const transport = typeof cfg.transport === 'string' && cfg.transport ? cfg.transport : 'stdio';
	/** @type {Record<string, unknown>} */
	const entry = { disabled: false };
	if (transport === 'stdio') {
		entry.type = 'stdio';
		if (cfg.command) { entry.command = cfg.command; }
		if (cfg.args) { entry.args = cfg.args; }
		if (cfg.env) { entry.env = cfg.env; }
	} else {
		// 远程型（http / sse）：env 里的键值对当 HTTP headers 用
		entry.type = transport;
		if (cfg.url) { entry.url = cfg.url; }
		if (cfg.env) { entry.headers = cfg.env; }
		else if (cfg.headers) { entry.headers = cfg.headers; }
	}
	return entry;
}

/** `<数据根>/mcp.json` 的路径。 */
export function mcpJsonPath(dataRoot) {
	return join(dataRoot, 'mcp.json');
}

/** `<数据根>/mcp/<id>`。 */
export function mcpDirOf(dataRoot, storeId) {
	return join(dataRoot, 'mcp', storeId);
}

/** 读 mcp.json（不存在 / 坏 JSON ⇒ 给一个空壳，**不抛**）。 */
export async function readMcpJson(dataRoot) {
	try {
		const raw = await readFile(mcpJsonPath(dataRoot), 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') { return { servers: {} }; }
		if (!parsed.servers || typeof parsed.servers !== 'object') { parsed.servers = {}; }
		return parsed;
	} catch {
		return { servers: {} };
	}
}

/** 写 mcp.json（保留其它顶层键，比如 IDE 写的 `inputs`）。 */
export async function writeMcpJson(dataRoot, config) {
	const file = mcpJsonPath(dataRoot);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * 把某个 MCP 服务器**注册**进 mcp.json（幂等：同 id 覆盖）。
 *
 * @param {string} dataRoot
 * @param {string} storeId
 * @param {object} config 包里的 `config.json` 内容
 */
export async function registerMcpServer(dataRoot, storeId, config) {
	const mcp = await readMcpJson(dataRoot);
	mcp.servers[storeId] = toMcpEntry(config);
	await writeMcpJson(dataRoot, mcp);
	return mcp.servers[storeId];
}

/**
 * 从 mcp.json **注销**某个 MCP 服务器（幂等：本来没有也不算失败）。
 *
 * @returns {Promise<boolean>} 真的删掉了一条吗
 */
export async function unregisterMcpServer(dataRoot, storeId) {
	const mcp = await readMcpJson(dataRoot);
	if (!(storeId in mcp.servers)) { return false; }
	delete mcp.servers[storeId];
	await writeMcpJson(dataRoot, mcp);
	return true;
}

/**
 * 装好之后读一下这个包的 `config.json`（校验 + 拿 version）。
 *
 * @returns {Promise<{ config: object, version: string }>}
 */
export async function readMcpPackageConfig(dataRoot, storeId) {
	const file = join(mcpDirOf(dataRoot, storeId), 'config.json');
	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		throw new Error(`mcp 包内缺少 config.json（${file}）—— 不知道该注册什么服务器`);
	}
	let config;
	try {
		config = JSON.parse(raw);
	} catch (e) {
		throw new Error(`mcp 的 config.json 不是合法 JSON：${String(e?.message ?? e).slice(0, 80)}`);
	}
	return { config, version: String(config.version ?? '') };
}

/**
 * 卸载：删 `<数据根>/mcp/<id>/` + 从 mcp.json 注销。
 *
 * 顺序有意为之：**先注销再删目录** —— 反过来的话，删目录成功但注销失败会留下
 * 一条指向不存在目录的 entry（下次启动会报"MCP 服务器起不来"）✗
 */
export async function removeMcpCompletely(dataRoot, storeId) {
	const removedEntry = await unregisterMcpServer(dataRoot, storeId);
	const dir = mcpDirOf(dataRoot, storeId);
	let removedDir = false;
	try {
		await rm(dir, { recursive: true, force: true });
		removedDir = true;
	} catch {
		removedDir = false;
	}
	return { removedEntry, removedDir };
}
