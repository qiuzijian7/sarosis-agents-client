/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbKernelApi.ts — SiYuan Kernel HTTP/WS API 客户端（复用 kernel 完整 REST 契约）。
 *
 *  负责封装 SiYuan kernel 的全部 /api/* 端点调用，包括：
 *   - 全文检索（resolves /api/search/*）
 *   - 反链 / 提及（resolves /api/ref/*）
 *   - 关系图谱（resolves /api/graph/*）
 *   - 文件树 CRUD（resolves /api/filetree/*）
 *   - 块级 CRUD（resolves /api/block/*）
 *   - 系统信息/健康检查（resolves /api/system/*）
 *
 *  当 kernel 不可用时，调用方应 graceful-degrade 到本地索引实现。
 *
 *  协议对齐 SiYuan kernel/api/*.go 的请求/响应格式：
 *   请求：POST /api/endpoint，JSON body
 *   响应：{ code: 0, msg: string, data: T }
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';

// ---------------------------------------------------------------------------
// SiYuan Kernel API 通用响应
// ---------------------------------------------------------------------------

export interface IKernelResponse<T = unknown> {
	code: number;
	msg: string;
	data: T;
}

export enum KernelApiError {
	NotFound = -1,
	AuthFailed = -2,
	Timeout = -3,
	NotRunning = -4,
}

// ---------------------------------------------------------------------------
// 搜索相关类型
// ---------------------------------------------------------------------------

export interface IKernelSearchRequest {
	k: string;        // 搜索关键词
	page?: number;    // 页码 (1-based)
	method?: number;  // 搜索方法
	groupBy?: number; // 分组方式
	orderBy?: number; // 排序方式
	types?: Record<string, boolean>; // 搜索类型
}

export interface IKernelSearchBlock {
	id: string;
	rootID: string;
	parentID: string;
	box: string;
	path: string;
	content: string;
	type: string;
	subType: string;
	hPath: string;
	ial: string;
	children: IKernelSearchBlock[];
	[key: string]: unknown;
}

export interface IKernelSearchResult {
	blocks: IKernelSearchBlock[];
	matchedBlockCount: number;
}

// ---------------------------------------------------------------------------
// 反链相关类型（对齐 kernel/model/backlink.go 返回结构）
// ---------------------------------------------------------------------------

export interface IKernelBacklinkItem {
	id: string;
	defID: string;
	rootID: string;
	box: string;
	path: string;
	hPath: string;
	content: string;
	ial: string;
	children: IKernelBacklinkItem[];
}

export interface IKernelBacklinkResult {
	defs: IKernelBacklinkItem[];
	refs: IKernelBacklinkItem[];
	kwds: IKernelBacklinkItem[];
	defBlockCount: number;
	refBlockCount: number;
	mentionBlockCount: number;
}

export interface IKernelBacklink2Result {
	backlinks: IKernelBacklinkItem[];
	backmentions: IKernelBacklinkItem[];
	backlinksBlockCount: number;
	backmentionsBlockCount: number;
}

// ---------------------------------------------------------------------------
// 图谱相关类型
// ---------------------------------------------------------------------------

export interface IKernelGraphNode {
	id: string;
	label: string;
	box: string;
	path: string;
	hPath: string;
	type: string;
	ial: string;
}

export interface IKernelGraphLink {
	id: string;
	source: string;
	target: string;
	type: string;
}

export interface IKernelGraphResult {
	nodes: IKernelGraphNode[];
	links: IKernelGraphLink[];
}

// ---------------------------------------------------------------------------
// 文件树相关类型
// ---------------------------------------------------------------------------

export interface IKernelFileItem {
	id: string;
	name: string;
	path: string;
	box: string;
	icon: string;
	subFileCount: number;
	count: number;
	size: number;
	mtime: number;
	ctime: number;
	type: 'dir' | 'file';
	closed: boolean;
	children: IKernelFileItem[];
}

// ---------------------------------------------------------------------------
// 块相关类型
// ---------------------------------------------------------------------------

export interface IKernelBlock {
	id: string;
	rootID: string;
	parentID: string;
	box: string;
	path: string;
	hPath: string;
	content: string;
	type: string;
	subType: string;
	ial: string;
	children: IKernelBlock[];
	markdown?: string;
}

// ---------------------------------------------------------------------------
// 系统信息
// ---------------------------------------------------------------------------

export interface IKernelConf {
	lang?: string;
	port?: number;
	workspace?: string;
	version?: string;
}

// ---------------------------------------------------------------------------
// KbKernelClient — 统一 HTTP/WS 客户端
// ---------------------------------------------------------------------------

export class KbKernelClient {

	private _baseUrl: string;
	private _authCode: string;
	private _timeoutMs: number;
	private _available: boolean | undefined; // undefined = 未检测
	private _healthPromise: Promise<boolean> | undefined;

	constructor(
		baseUrl: string = 'http://127.0.0.1:6806',
		authCode: string = '',
		timeoutMs: number = 8000,
	) {
		this._baseUrl = baseUrl.replace(/\/+$/, '');
		this._authCode = authCode;
		this._timeoutMs = timeoutMs;
	}

	// -- properties --

	get baseUrl(): string { return this._baseUrl; }
	get isAvailable(): boolean { return this._available === true; }

	/** 快速检查 kernel 是否可达 */
	async healthCheck(token?: CancellationToken): Promise<boolean> {
		if (this._available !== undefined) { return this._available; }
		if (!this._healthPromise) {
			this._healthPromise = this._healthCheckImpl(token);
		}
		return this._healthPromise;
	}

	private async _healthCheckImpl(token?: CancellationToken): Promise<boolean> {
		try {
			const res = await this._fetch<KernelResponse<IKernelConf>>('GET', '/api/system/getConf', undefined, token);
			this._available = res.code === 0;
			return this._available;
		} catch {
			this._available = false;
			return false;
		}
	}

	/** 强制重新检测 */
	resetHealth(): void {
		this._available = undefined;
		this._healthPromise = undefined;
	}

	// -- 全文检索（对齐 POST /api/search/fullTextSearchBlock） --

	async fullTextSearchBlock(query: string, page = 1, token?: CancellationToken): Promise<IKernelSearchResult> {
		const res = await this._post<KernelResponse<IKernelSearchResult>>('/api/search/fullTextSearchBlock', {
			k: query,
			page,
		}, token);
		return res.data;
	}

	// -- 反链（对齐 POST /api/ref/getBacklink2） --

	async getBacklink2(blockId: string, token?: CancellationToken): Promise<IKernelBacklink2Result> {
		const res = await this._post<KernelResponse<IKernelBacklink2Result>>('/api/ref/getBacklink2', {
			id: blockId,
		}, token);
		return res.data;
	}

	// -- 图谱（对齐 POST /api/graph/getGraph / getLocalGraph） --

	async getGraph(query: string, token?: CancellationToken): Promise<IKernelGraphResult> {
		const res = await this._post<KernelResponse<IKernelGraphResult>>('/api/graph/getGraph', {
			k: query,
		}, token);
		return res.data;
	}

	async getLocalGraph(blockId: string, token?: CancellationToken): Promise<IKernelGraphResult> {
		const res = await this._post<KernelResponse<IKernelGraphResult>>('/api/graph/getLocalGraph', {
			id: blockId,
		}, token);
		return res.data;
	}

	// -- 文件树 --

	async getTree(path: string, token?: CancellationToken): Promise<IKernelFileItem[]> {
		const res = await this._post<KernelResponse<{ tree: IKernelFileItem[] }>>('/api/filetree/getFiles', {
			path,
		}, token);
		return res.data.tree ?? [];
	}

	async createDoc(notebook: string, path: string, md = '', token?: CancellationToken): Promise<string> {
		const res = await this._post<KernelResponse<{ id: string }>>('/api/filetree/createDoc', {
			notebook,
			path,
			md,
		}, token);
		return res.data.id ?? '';
	}

	async removeDoc(notebook: string, path: string, token?: CancellationToken): Promise<void> {
		await this._post('/api/filetree/removeDoc', { notebook, path }, token);
	}

	async renameDoc(notebook: string, path: string, title: string, token?: CancellationToken): Promise<void> {
		await this._post('/api/filetree/renameDoc', { notebook, path, title }, token);
	}

	// -- 块操作 --

	async getBlockKramdown(blockId: string, token?: CancellationToken): Promise<IKernelBlock> {
		const res = await this._post<KernelResponse<IKernelBlock>>('/api/block/getBlockKramdown', {
			id: blockId,
		}, token);
		return res.data;
	}

	async getBlockDOM(blockId: string, token?: CancellationToken): Promise<string> {
		const res = await this._post<KernelResponse<{ dom: string }>>('/api/block/getBlockDOM', {
			id: blockId,
		}, token);
		return res.data.dom ?? '';
	}

	// -- 系统 --

	async getSystemConf(token?: CancellationToken): Promise<IKernelConf> {
		const res = await this._fetch<KernelResponse<IKernelConf>>('GET', '/api/system/getConf', undefined, token);
		return res.data ?? {};
	}

	// -- 内部 HTTP 方法 --

	private async _post<T = KernelResponse<unknown>>(endpoint: string, body: Record<string, unknown>, token?: CancellationToken): Promise<T> {
		return this._fetch<T>('POST', endpoint, body, token);
	}

	private async _fetch<T>(
		method: 'GET' | 'POST',
		endpoint: string,
		body?: Record<string, unknown>,
		token?: CancellationToken,
	): Promise<T> {
		const url = `${this._baseUrl}${endpoint}`;
		const cts = new CancellationTokenSource(token);
		const timer = setTimeout(() => cts.cancel(), this._timeoutMs);

		try {
			const init: RequestInit = {
				method,
				headers: {
					'Content-Type': 'application/json',
					...(this._authCode ? { 'Authorization': `Token ${this._authCode}` } : {}),
				},
			};
			if (method === 'POST' && body) {
				init.body = JSON.stringify(body);
			}

			const response = await fetch(url, init);
			if (!response.ok) {
				throw new Error(`Kernel API ${method} ${endpoint} → HTTP ${response.status}`);
			}
			return await response.json() as T;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}
}

// ---------------------------------------------------------------------------
// 兼容别名
// ---------------------------------------------------------------------------

type KernelResponse<T> = IKernelResponse<T>;
