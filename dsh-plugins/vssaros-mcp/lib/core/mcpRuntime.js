// @vssaros/dsh-mcp — 运行时 MCP 挂载（**缺省启用**，`VSSAROS_MCP_RUNTIME_MOUNT=0` 回退到旧覆盖层）。
//
// 依据：`poc/dsh-p0/scripts/p3-110-mcp-runtime-mount.mjs` 用官方 `boot()` 起真组合树，9/9 证明
// 在本项目 dsh runtime（0.2.1-rc.2）上：
//   ctx.get('loader') 可用 → 加载 @deepseek-ai/dsh-mcp-client → ctx.plugin(plugin, config)
//   → fiber.await() 真 spawn/握手 stdio server（mcp__probe__echo 出现在 ctx.tools）
//   → fiber.dispose() 工具干净移除 → 同一 serverName 卸完可重挂。
// `dshMcpConfig.ts:9-18` 的「实测做不到」只覆盖 `pluginManager` 无 addRow 那条路，
// 不适用于这条 cordis 原生路径。
//
// ★ 开关两侧同源：IDE 侧 `dshHostSupervisor._writeMcpOverlay` / `dshHostConfig.renderHostOverlays`
//   读**同一个**环境变量让路。两侧必须一致，否则同一 serverName 会挂两遍——
//   dsh-mcp-client 有全局 serverName 去重表（`lib/index.js:818`），重复会直接抛错。
// ★ 缺省关闭 ⇒ 现有行为零变化（仍走启动期 --patch 覆盖层）。开启属架构切换，
//   必须先做真机 Host 验证；本模块不擅自改写用户的挂载模型。
//
// 骨架照上游 DS Bot `connectors/index.js` 的全局路径（单队列 + 指纹 + 失败指纹保留），
// 但不含 OAuth 网关 / per-Bot 遮罩；那些是后续能力，不在这一步引入。

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMcpServers } from './mcpConfig.js';

export const MCP_RUNTIME_MOUNT_ENV = 'VSSAROS_MCP_RUNTIME_MOUNT';
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/**
 * 两侧共用的唯一判据：**缺省启用**，显式 `=0` 回退到旧的启动期覆盖层。
 * 依据 P3-110（官方 boot 真组合树 9/9）+ P3-111（隔离真 Host 7/7：argv[1] 落在 runtime
 * node_modules、三级解析命中、真挂/真卸干净）⇒ 运行时路径已在真 Host 上验证通过。
 * 保留 `=0` 是挂载模型切换的逃生开关（不改发版即可回退）。
 */
export const isMcpRuntimeMountEnabled = (env = process.env) => env?.[MCP_RUNTIME_MOUNT_ENV] !== '0';

/**
 * 加载 mcp-client 插件对象，三级解析，任何一级都不静默。
 * ① `loader.import('包名')` —— POC 里因解析基址是 profile 目录而失败，但真 Host 里可能可用；
 * ② `createRequire` 从 Host bin（`process.argv[1]`）向上找到 runtime 的 node_modules；
 * ③ IDE 侧注入的 `config.mcpClientUrl`（绝对 file URL）兜底。
 */
export async function loadMcpClient({ loader, mcpClientUrl } = {}) {
	const errors = [];
	const unwrap = (mod, via) => {
		const plugin = typeof loader?.unwrapExports === 'function' ? (loader.unwrapExports(mod) ?? mod?.default ?? mod) : (mod?.default ?? mod);
		if (typeof plugin?.apply !== 'function') { throw new Error(`${via} 返回的模块没有 apply()`); }
		return plugin;
	};
	if (typeof loader?.import === 'function') {
		try { return unwrap(await loader.import(MCP_CLIENT_PACKAGE), 'loader.import'); }
		catch (e) { errors.push(`loader.import: ${String(e?.message ?? e)}`); }
	} else {
		errors.push('ctx.get("loader").import 不可用');
	}
	try {
		const bin = process.argv?.[1];
		if (bin) {
			const req = createRequire(pathToFileURL(join(dirname(bin), '__vssaros_mcp__.js')).href);
			return unwrap(await import(pathToFileURL(req.resolve(MCP_CLIENT_PACKAGE)).href), 'createRequire');
		}
		errors.push('process.argv[1] 为空，无法推导 runtime node_modules');
	} catch (e) { errors.push(`createRequire: ${String(e?.message ?? e)}`); }
	if (mcpClientUrl) {
		try { return unwrap(await import(mcpClientUrl), 'mcpClientUrl'); }
		catch (e) { errors.push(`mcpClientUrl: ${String(e?.message ?? e)}`); }
	}
	throw new Error(`无法加载 ${MCP_CLIENT_PACKAGE}（运行时挂载不可用）：${errors.join(' | ')}`);
}

/** `parseMcpServers` 的归一化结果 → mcp-client 的 config（与 `renderMcpOverlay` 同形）。 */
export function configFor(server) {
	const base = { transport: server.transport, serverName: server.serverName, failOnStartupError: true };
	if (server.transport === 'stdio') {
		return {
			...base,
			command: server.command,
			...(server.args ? { args: server.args } : {}),
			...(server.env ? { env: server.env } : {}),
			...(server.cwd ? { cwd: server.cwd } : {}),
		};
	}
	return { ...base, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

export const fingerprintOf = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');

/**
 * 全局运行时挂载器（可在离线 fake ctx 下完整测，不依赖真 Host）。
 * `mounts: Map<serverName, {fp, fiber?}>`；`statuses` 只保留非 ready 状态（ready = 无条目），
 * 与上游 DS Bot connectors 的状态口径一致。
 */
export class McpRuntime {
	constructor({ ctx, client, warn = () => {} } = {}) {
		this.ctx = ctx;
		this.client = client;
		this.warn = warn;
		this.mounts = new Map();
		this.statuses = new Map();
		this.stopped = false;
		this.queue = Promise.resolve();
	}

	async unmount(name) {
		const mount = this.mounts.get(name);
		this.mounts.delete(name);
		if (mount?.fiber) {
			try { await Promise.resolve().then(() => mount.fiber.dispose()); } catch { /* 卸载失败不阻断 */ }
		}
	}

	async mountOne(server) {
		const name = server.serverName;
		let config;
		try { config = configFor(server); }
		catch (e) { this.statuses.set(name, { state: 'error', error: String(e?.message ?? e) }); return; }
		const fp = fingerprintOf(config);
		if (this.mounts.get(name)?.fp === fp) { return; }
		await this.unmount(name);
		this.statuses.set(name, { state: 'connecting' });
		try {
			if (this.stopped) { return; }
			const fiber = this.ctx.plugin(this.client, config);
			this.mounts.set(name, { fp, fiber });
			await fiber.await();
			if (this.stopped || this.mounts.get(name)?.fiber !== fiber) { return; }
			this.statuses.delete(name);
		} catch (e) {
			await this.unmount(name);
			// 保留失败指纹（无 fiber）⇒ 后续 sync 不会反复重试同一坏配置，只有 config 变化或显式重试才重挂。
			this.mounts.set(name, { fp });
			const message = String(e?.message ?? e).slice(0, 300);
			this.statuses.set(name, { state: 'error', error: message });
			this.warn(`mcp runtime: ${name} failed: ${message}`);
		}
	}

	async reconcile(servers) {
		const desired = new Set((servers ?? []).map(s => s.serverName));
		for (const name of [...this.mounts.keys()]) {
			if (!desired.has(name)) { await this.unmount(name); this.statuses.delete(name); }
		}
		for (const server of servers ?? []) { await this.mountOne(server); }
	}

	/** 串行化：同一时刻只有一轮 reconcile 在跑，避免并发挂/卸交错。 */
	sync(servers) {
		this.queue = this.queue.then(() => this.reconcile(servers))
			.catch(e => this.warn(`mcp runtime: reconcile failed: ${String(e?.message ?? e)}`));
		return this.queue;
	}

	statusView() { return Object.fromEntries(this.statuses); }

	async stop() {
		this.stopped = true;
		const names = [...this.mounts.keys()];
		await Promise.all(names.map(name => this.unmount(name)));
		this.statuses.clear();
	}
}

/** 读 `mcp.json` 并按既有归一化规则解析（跳过原因在 parsed.skipped 里，交给调用方记日志）。 */
export async function readMountPlan(path, env = process.env) {
	const text = await readFile(path, 'utf8');
	const parsed = parseMcpServers(text, env);
	// 保留**未经 `${env:VAR}` 替换**的原始配置：凭据网关要在每次转发时才解析，
	// 这样 token 轮换无需重启 Host（parseMcpServers 的替换只用于配置校验）。
	let rawConfig = {};
	try {
		const json = JSON.parse(text);
		if (json && typeof json === 'object' && !Array.isArray(json)) { rawConfig = json; }
	} catch { /* 坏 JSON 时 parsed.skipped 已有说明 */ }
	return { ...parsed, rawConfig };
}

/** mtime 轮询用的轻量签名：文件消失/不可读返回 null，调用方据此跳过本轮。 */
export async function mtimeOf(path) {
	try { return (await stat(path)).mtimeMs; } catch { return null; }
}
