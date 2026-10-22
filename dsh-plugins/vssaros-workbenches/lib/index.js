// @vssaros/dsh-workbenches — 工作台宿主（服务端半）。
//
// doc/workbench-refactor-plan.md §4.1 路线 B：与 dsh-desktop 官方宿主 `dsh-desktop-workbenches`
// **同名同形**的兼容宿主。服务端照搬官方 `index.js` 里与市场无关的部分（MIT，见 THIRD_PARTY.md）：
//   · 只读归属服务 `desktopWorkbenchOwnership.read() → { revision, sessionBindings, added }`
//     （业务插件判断"这个会话是不是我的"用它；**不许**另开一套设置命名空间来授权会话）；
//   · `GET  /api/vssaros-workbenches/state`        读 state.json（含 revision）；
//   · `POST /api/vssaros-workbenches/state/write`  带 revision 写入（乐观锁 409 / 校验 400 / 损坏 500）。
// 不搬：市场目录 / 安装 / 投稿状态 / 文档路由（P4 再做，见方案 §6）。
//
// ⚠ 为什么路由前缀不是官方的 `/api/desktop-workbenches/`：官方宿主万一也被装进同一 profile，
//   同一路由会"谁先注册谁赢"静默打架。服务名同官方（业务插件代码零改动可移植），路由各用各的。

import { createStateStore, MAX_STATE_BYTES, StateError } from './state.js';

export const name = 'vssaros-workbenches';
/** 没有硬依赖：connection 走可选注入（同 scheduler / sessions 口径：非 web 模板里不让整包 pending）。 */
export const inject = [];

const PREFIX = '/api/vssaros-workbenches';
const NO_STORE = { 'cache-control': 'no-store' };

async function readPayload(request, maximum = MAX_STATE_BYTES) {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maximum) { throw new StateError('工作台状态太大。', 413); }
	const reader = request.body?.getReader();
	if (!reader) { throw new StateError('需要 JSON 请求体。'); }
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			length += value.length;
			if (length > maximum) {
				await reader.cancel();
				throw new StateError('工作台状态太大。', 413);
			}
			chunks.push(value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new StateError('请求体不是合法 JSON。');
		}
	} finally {
		reader.releaseLock();
	}
}

const failure = error => Response.json(
	{ error: error instanceof StateError ? error.message : '读写工作台状态失败。' },
	{ status: error instanceof StateError ? error.status : 500, headers: NO_STORE },
);

export function apply(ctx, config) {
	const root = typeof config?.root === 'string' && config.root.trim() ? config.root.trim() : '';
	if (!root) {
		// 没给数据目录 = 组合写错了 ⇒ 如实报错，不猜一个目录去写（写错位置比不写更糟）。
		try { (typeof ctx.logger === 'function' ? ctx.logger('vssaros-workbenches') : console).warn('config.root 为空：工作台状态不可用（检查 cordis.patch.yml 的 dshHomePath）'); } catch { /* 探针假 ctx */ }
		return;
	}
	const store = createStateStore(root);
	ctx.effect(() => ctx.reflect.provide('desktopWorkbenchOwnership', {
		async read() {
			const { revision, state } = await store.read();
			return { revision, sessionBindings: { ...state.sessionBindings }, added: [...state.added] };
		},
	}));
	ctx.inject(['connection'], webCtx => registerRoutes(webCtx, store));
}

function registerRoutes(ctx, store) {
	ctx.connection.fetch.register({
		path: `${PREFIX}/state`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch() {
			try {
				return Response.json(await store.read(), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
	ctx.connection.fetch.register({
		path: `${PREFIX}/state/write`,
		methods: ['POST'],
		requestBody: 'buffered',
		async fetch(request) {
			try {
				return Response.json(await store.write(await readPayload(request)), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
}
