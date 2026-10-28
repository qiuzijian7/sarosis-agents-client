// 萨罗斯中转站「自动注册」（机器自报家门）。
//
// 触发点：用户登录 CodeBuddy provider 之后 ⇒ 本机自动注册成中转站的一个节点。
// 红线：绝不把 CodeBuddy 凭据发出去（注册体只有身份 + 模型目录）。
import * as os from 'os';
import * as vscode from 'vscode';
import type { CodeBuddyAuth } from './auth';

/** globalState 键：已注册节点 { nodeId, nodeToken, relayUrl, updatedAt }。 */
const GS_KEY_NODE = 'codebuddy.relay.node';

/**
 * 默认中转站地址（AnyDev 环境「我的开发环境」= 21.6.92.5，devcloud 域名是它的对外入口）。
 * ⚠ 用域名而不是裸 IP：裸 IP 在部分网段不可达。
 */
const DEFAULT_RELAY_URL = 'http://zijianqiu-any1.devcloud.woa.com:8000';

/** 扩展版本（报给中转站，便于按版本排查）。 */
const AGENT_VERSION = '1.0.0';

/** 模型目录缓存时长（中转站不需要秒级新鲜度，别把 /v3/config 打太勤）。 */
const CATALOG_TTL_MS = 5 * 60_000;

/** 一条注册记录（本机在中转站里的身份）。 */
export interface IRelayNodeRecord {
	readonly nodeId: string;
	readonly nodeToken: string;
	readonly relayUrl: string;
	readonly updatedAt: number;
}

/** 构造参数（identityHeaders 由 extension.ts 注入，避免两个模块循环依赖）。 */
export interface IRelayRegistrationOptions {
	readonly context: vscode.ExtensionContext;
	readonly auth: CodeBuddyAuth;
	readonly identityHeaders: (token: string) => Record<string, string>;
}

/** 中转站节点注册器：登录成功 ⇒ 把本机注册进去。 */
export class RelayRegistration implements vscode.Disposable {
	private readonly _context: vscode.ExtensionContext;
	private readonly _auth: CodeBuddyAuth;
	private readonly _identityHeaders: (token: string) => Record<string, string>;
	private readonly _disposables: vscode.Disposable[] = [];
	private _running = false;
	/** 模型目录缓存（避免连续手动注册时反复打 /v3/config）。 */
	private _catalogCache: { models: string[]; at: number } | undefined;

	constructor(options: IRelayRegistrationOptions) {
		this._context = options.context;
		this._auth = options.auth;
		this._identityHeaders = options.identityHeaders;
	}

	/**
	 * ★ 2026-10-27：**不做任何自动注册**（用户要求：注册必须由人点按钮触发）。
	 *
	 * 移除的两条自动路径：
	 *   ① 登录 CodeBuddy provider 成功后自动注册；
	 *   ② 启动时若已登录也自动注册。
	 * 另：周期心跳也一并去掉（不再有"后台偷偷续约"这件事）。
	 *
	 * 保留的入口只有**显式命令** `codebuddy.relay.register`（命令面板里手动跑）——
	 * 它带得上 CodeBuddy 身份与模型目录，比工作台页面上的按钮更"全"。
	 * 工作台页面上的「注册本机到号池」按钮走的是 Host 侧那条路（见 dsh-plugins/vssaros-relay）。
	 */
	start(): void {
		/* 故意留空：注册必须是显式动作。 */
	}

	/** 已注册的节点记录（没有则 undefined）。 */
	node(): IRelayNodeRecord | undefined {
		return this._context.globalState.get<IRelayNodeRecord>(GS_KEY_NODE);
	}

	/** 同步入口：先心跳，令牌失效才重新注册。并发调用只跑一个。 */
	async sync(reason: string): Promise<void> {
		if (this._running) {
			return;
		}
		this._running = true;
		try {
			await this._syncOnce(reason);
		} finally {
			this._running = false;
		}
	}

	/** 真正干活的同步流程。 */
	private async _syncOnce(reason: string): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('codebuddy');
		const baseUrl = (cfg.get<string>('relay.baseUrl') || DEFAULT_RELAY_URL).replace(/\/+$/, '');
		const enrollKey = (cfg.get<string>('relay.enrollKey') || '').trim();
		const autoRegister = cfg.get<boolean>('relay.autoRegister') !== false;
		const nodeName = (cfg.get<string>('relay.nodeName') || os.hostname() || 'unknown-host').trim();
		if (!autoRegister) {
			return;
		}
		const token = await this._auth.getAccessToken();
		if (!token) {
			return;
		}
		const identity = buildIdentity(token, nodeName);
		const catalog = await this._fetchCatalog(token);
		const existing = this.node();
		if (existing && existing.relayUrl === baseUrl) {
			if (await this._heartbeat(baseUrl, existing, identity, catalog)) {
				return;
			}
			// 令牌失效（401）⇒ 清掉旧的，重新注册。
			await this._context.globalState.update(GS_KEY_NODE, undefined);
		}
		if (!enrollKey) {
			console.log('[CodeBuddy][relay] 未配置 codebuddy.relay.enrollKey ⇒ 跳过自动注册');
			return;
		}
		await this._register(baseUrl, enrollKey, nodeName, identity, catalog, reason);
	}

	/** 心跳：带节点令牌刷新身份与目录。成功返回 true。 */
	private async _heartbeat(
		baseUrl: string,
		record: IRelayNodeRecord,
		identity: Record<string, string>,
		catalog: string[],
	): Promise<boolean> {
		try {
			const res = await fetch(`${baseUrl}/api/nodes/${encodeURIComponent(record.nodeId)}/heartbeat`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'authorization': `Bearer ${record.nodeToken}`,
				},
				body: JSON.stringify({ identity, catalog: { models: catalog } }),
			});
			if (!res.ok) {
				console.log(`[CodeBuddy][relay] 心跳失败（HTTP ${res.status}）⇒ 重新注册`);
				return false;
			}
			await this._context.globalState.update(GS_KEY_NODE, { ...record, updatedAt: Date.now() });
			console.log(`[CodeBuddy][relay] 心跳 OK：${record.nodeId}`);
			return true;
		} catch (e) {
			console.log(`[CodeBuddy][relay] 心跳异常（${String(e)}）⇒ 重新注册`);
			return false;
		}
	}

	/** 自动注册：拿长期节点令牌，存到 globalState。 */
	private async _register(
		baseUrl: string,
		enrollKey: string,
		nodeName: string,
		identity: Record<string, string>,
		catalog: string[],
		reason: string,
	): Promise<void> {
		try {
			const res = await fetch(`${baseUrl}/api/nodes/auto-enroll`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enroll_key: enrollKey,
					node_name: nodeName,
					provider: 'codebuddy',
					identity,
					catalog: { models: catalog },
				}),
			});
			const text = await res.text();
			if (!res.ok) {
				console.warn(`[CodeBuddy][relay] 自动注册失败：HTTP ${res.status} ${text.slice(0, 200)}`);
				void vscode.window.showWarningMessage(`CodeBuddy：注册到萨罗斯中转站失败（HTTP ${res.status}）`);
				return;
			}
			let data: { node_id?: string; node_token?: string };
			try {
				data = JSON.parse(text) as { node_id?: string; node_token?: string };
			} catch {
				console.warn(`[CodeBuddy][relay] 自动注册返回的不是 JSON：${text.slice(0, 200)}`);
				return;
			}
			if (!data.node_id || !data.node_token) {
				console.warn('[CodeBuddy][relay] 自动注册返回缺少 node_id / node_token');
				return;
			}
			await this._context.globalState.update(GS_KEY_NODE, {
				nodeId: data.node_id,
				nodeToken: data.node_token,
				relayUrl: baseUrl,
				updatedAt: Date.now(),
			});
			console.log(`[CodeBuddy][relay] 已注册到中转站：${data.node_id}（${reason}，模型 ${catalog.length} 个）`);
			void vscode.window.setStatusBarMessage(`CodeBuddy：已注册到萨罗斯中转站（${data.node_id}）`, 6000);
		} catch (e) {
			console.warn(`[CodeBuddy][relay] 自动注册异常：${String(e)}`);
		}
	}

	/** 拉一次平台模型目录（只报模型 id，不报凭据）。 */
	private async _fetchCatalog(token: string): Promise<string[]> {
		const cached = this._catalogCache;
		if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
			return cached.models;
		}
		try {
			const cfg = vscode.workspace.getConfiguration('codebuddy');
			const endpoint = (cfg.get<string>('endpoint') || 'https://copilot.tencent.com').replace(/\/+$/, '');
			const res = await fetch(`${endpoint}/v3/config`, {
				headers: { ...this._identityHeaders(token), 'Accept': 'application/json' },
			});
			if (!res.ok) {
				return [];
			}
			const json = await res.json() as { data?: { models?: Array<{ id?: string }> } };
			const models = json?.data?.models;
			if (!Array.isArray(models)) {
				return [];
			}
			const ids = models.map(m => String(m?.id || '')).filter(id => !!id);
			this._catalogCache = { models: ids, at: Date.now() };
			return ids;
		} catch {
			return [];
		}
	}

	dispose(): void {
		for (const item of this._disposables) {
			try { item.dispose(); } catch { /* ignore */ }
		}
		this._disposables.length = 0;
	}
}

/** 从 token 里取身份（只有 id，没有凭据）。 */
function buildIdentity(token: string, nodeName: string): Record<string, string> {
	const payload = decodeJwtPayload(token);
	const userId = String(payload?.sub || '');
	const iss = String(payload?.iss || '');
	const tenant = /\/realms\/sso-([^/]+)$/.exec(iss)?.[1] || '';
	return {
		user_id: userId,
		tenant_id: tenant,
		account: userId,
		hostname: nodeName,
		os: `${os.platform()} ${os.release()}`,
		agent_version: AGENT_VERSION,
	};
}

/** 解 JWT 载荷（只取 `sub` / `iss`，不碰签名）。 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) {
			return undefined;
		}
		const payload = parts[1];
		const padded = payload + '=='.slice(0, (4 - payload.length % 4) % 4);
		return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
