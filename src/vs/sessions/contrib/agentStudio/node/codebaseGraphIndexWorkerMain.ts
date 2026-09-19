/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph **索引 utility process** 入口（P2-1 Phase 1）。
 *
 * ## 为什么需要独立进程
 *
 * 索引编排是 CPU 密集（52 万边匹配 / 克隆检测 / BM25 / Leiden），而 renderer 是**多窗口共享**的
 * 主线程 ⇒ 放这里会整窗冻结 ✗；放 main 进程更糟（它是窗口管理与 IPC 的共享资源 ✗✗）。
 * 故按 VS Code 标准形态：renderer → main（channel 转发）→ **本进程**（真正干活 ✓）。
 *
 * ## 范式（照抄 `src/vs/platform/files/node/watcher/watcherMain.ts`，该文件仅 21 行）
 *
 * `isUtilityProcess` 决定用哪个 Server；再把「服务对象」用 `ProxyChannel.fromService` 包成 channel
 * 注册上去 —— renderer/main 侧经 `client.getChannel('index')` 取到它 ✓。
 * ⚠ `moduleId` 就是本文件路径（`vs/sessions/contrib/agentStudio/node/codebaseGraphIndexWorkerMain`，
 *   无 `.js`、按 `out/` 解析）⇒ **无需任何构建登记** ✓。
 *
 * ## 当前阶段（先把「进程能起 + 通道能通」验证掉）
 *
 * 四个方法都是**诚实桩**（`runIndex` 返回 not implemented）⇒ 本进程目前"起来了但什么都不做" ✓，
 * 对现有行为**零影响**。真正的编排搬迁见 `common/codebaseGraphIndexChannel.ts` 头部的阶段说明 ——
 * **不要**在搬逻辑之前改这些桩的语义 ✗。
 *
 * ## ★ 2026-09-19（Step 3）：接线已按「方案 B」落地
 *
 * renderer 代理改为经 `IUtilityProcessWorkerWorkbenchService.createWorker(...)` **直连本进程**
 * （`browser/codebaseGraphIndexProxy.ts` ✓），main 宿主 + `app.ts` 注册已删除。
 * 两侧共用契约里的 `CODEBASE_GRAPH_INDEX_WORKER`（moduleId / type / name / 通道名 ✓）。
 * ⚠ 本进程**没有** `process.env` 之类的环境语义，也**不拥有**文件系统状态 —— 搬迁编排时
 * 需要的东西（rootPath / excludeDirs / changeSet）都在请求里传进来 ✓（契约已定义）。
 */

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { CODEBASE_GRAPH_INDEX_WORKER } from '../common/codebaseGraphIndexChannel.js';
import type {
	ICodebaseGraphIndexChannel,
	ICodebaseGraphIndexProgress,
	ICodebaseGraphIndexRunRequest,
	ICodebaseGraphIndexRunResult,
} from '../common/codebaseGraphIndexChannel.js';

/**
 * 本进程注册的 channel 名 —— ★ 与 renderer 代理**共用契约里那一份定义** ✓
 * （此前是本地字面量 `'index'`，两边各写一份 ⇒ 一旦漂移，取通道得到 `undefined` 且**不报错** ✗）。
 */
const INDEX_CHANNEL_NAME = CODEBASE_GRAPH_INDEX_WORKER.channel;

/**
 * 索引服务（Phase 1 的**宿主本体**，将来承载编排）。
 *
 * ⚠ 现阶段全是桩：唯一目的是让「进程能起 + 通道能通 + 方法可调用」可被验证 ✓。
 * 每个返回值都**显式**说明"未实现"，不允许静默空返回（本仓反复踩过"静默"✗）。
 */
class CodebaseGraphIndexWorkerService implements ICodebaseGraphIndexChannel {

	private _lastProgress: ICodebaseGraphIndexProgress | undefined;

	async runIndex(request: ICodebaseGraphIndexRunRequest): Promise<ICodebaseGraphIndexRunResult> {
		this._lastProgress = { stage: '未实现', message: '索引编排尚未搬迁（P2-1 Phase 1；进程与通道已就绪）' };
		return {
			success: false,
			kind: request.mode,
			message: 'runIndex: not implemented（索引 utility process 已启动、通道已连通；编排搬迁进行中）',
			rootPath: request.rootPath,
		};
	}

	async cancel(_project: string): Promise<void> {
		// 无运行中的任务 ⇒ 幂等空操作 ✓
	}

	async isRunning(_project: string): Promise<boolean> {
		return false;
	}

	async getProgress(_project: string): Promise<ICodebaseGraphIndexProgress | undefined> {
		return this._lastProgress;
	}
}

let server: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	server = new UtilityProcessServer();
} else {
	server = new ChildProcessServer('codebaseGraphIndex');
}

const service = new CodebaseGraphIndexWorkerService();
server.registerChannel(INDEX_CHANNEL_NAME, ProxyChannel.fromService(service, new DisposableStore()));
