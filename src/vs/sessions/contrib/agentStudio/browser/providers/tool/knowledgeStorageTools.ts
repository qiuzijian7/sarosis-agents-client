/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knowledge Storage Tools — 内置 Embedding Provider + llm-wiki 知识内核 (kb_search 工具)
 * 与 KB 存储根迁移逻辑。
 *
 * 注：原「Plan-C Hyper-Extract 抽取式知识引擎」（`browser/knowledge/engine/`、`knowledgeTools.ts`、
 * 每仓库 RAG session、`kb_ask`/`kb_search_repo`/`kb_export*`/`kb_list`）已于 2026-07-31 整体下线，
 * Agent 侧唯一检索入口为 `kb_search`（`kbVaultRecallTools.ts`，统一走 `IKbNativeKernelService`）。
 *
 * 从 builtinToolProvider.ts 的 _registerEmbeddingProvider / _registerKnowledgeTools 及其 5 个
 * 私有 helper (_resolveWorkspaceDir / _resolveKbStorageRoot / _maybeMigrateKbStorage /
 * _migrateLegacyKbStorage / _legacyKbRoot) 抽出，降低主文件体积。
 *
 * 由于 `_kbStorageRootCache` 需要在「工具运行时按需解析」与「配置变更监听」之间共享，这里用
 * 工厂闭包持有该缓存，而非无状态函数；`addDisposable` 把需要随 provider 释放的监听器接入主文件
 * 的 Disposable 生命周期。
 */

import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IAiEmbeddingVectorService } from '../../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { resolveKbRoot, migrateKnowledgeStorage } from '../../knowledge/knowledgeStorage.js';
import { createBuiltinEmbeddingProvider } from '../../knowledge/builtinEmbeddingProvider.js';
import { registerKbVaultRecallTools } from './kbVaultRecallTools.js';
import type { IKbNativeKernelService } from '../../kbNativeKernelService.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface KnowledgeStorageContext {
	/** 注册一个内置工具（kb_* 系列）。 */
	register(registration: IBuiltinToolRegistration): IDisposable;
	/** 注册一个需要随 provider 释放的 Disposable（如配置变更监听）。 */
	addDisposable(d: IDisposable): void;
	configurationService: IConfigurationService;
	fileService: IFileService;
	embeddingService: IAiEmbeddingVectorService;
	studioService: IAgentStudioService;
	workspaceService: IWorkspaceContextService;
	environmentService: INativeEnvironmentService;
	logService: ILogService;
	/** 系统 B 知识库内核（与「知识库」视图共享），kb_search 的唯一数据源。 */
	kernelService: IKbNativeKernelService;
	/** 配置键：KB 存储根路径（即主文件中的 AGENT_STUDIO_KB_STORAGE_PATH）。 */
	kbStoragePathKey: string;
}

export interface IKnowledgeStorageRegistrar {
	registerEmbeddingProvider(): void;
	registerKnowledgeTools(): void;
}

export function createKnowledgeStorageRegistrar(ctx: KnowledgeStorageContext): IKnowledgeStorageRegistrar {
	// 缓存的 KB 存储根：工具运行时通过 resolveStorageRoot 写入，配置变更监听读取并据此迁移。
	let _kbStorageRootCache: string | undefined;

	function registerEmbeddingProvider(): void {
		try {
			const provider = createBuiltinEmbeddingProvider(ctx.configurationService, ctx.logService);
			ctx.addDisposable(
				ctx.embeddingService.registerAiEmbeddingVectorProvider('builtin-byok', provider)
			);
			ctx.logService.info('[BuiltinToolProvider] Built-in embedding provider registered (BYOK API).');
		} catch (err) {
			ctx.logService.warn(`[BuiltinToolProvider] Failed to register built-in embedding provider: ${err}`);
		}
	}

	function registerKnowledgeTools(): void {
		// 系统 A（Hyper-Extract 抽取式引擎 + 每仓库 RAG session）已下线，
		// Agent 侧只保留基于 KbNativeKernel 的统一入口 kb_search。
		registerKbVaultRecallTools({
			register: ctx.register,
			kernelService: ctx.kernelService,
			logService: ctx.logService,
		});

		// Auto-migrate when the user changes the storage root setting.
		ctx.addDisposable(ctx.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ctx.kbStoragePathKey)) {
				void maybeMigrateKbStorage();
			}
		}));
	}

	/** KB storage root. Default `~/.vssaros/knowledge-base`; config overrides (supports ~ / absolute / relative). */
	async function resolveKbStorageRoot(): Promise<string> {
		const cfg = ctx.configurationService.getValue<string>(ctx.kbStoragePathKey);
		const dataRoot = (ctx.environmentService as INativeEnvironmentService).userDataPath
			?? (typeof process !== 'undefined' ? process.cwd() : '.');
		const root = resolveKbRoot(cfg, dataRoot);
		_kbStorageRootCache = root;
		return root;
	}

	/** Migrate KBs from the cached root to the (newly resolved) current root. */
	async function maybeMigrateKbStorage(): Promise<void> {
		const oldRoot = _kbStorageRootCache;
		const newRoot = await resolveKbStorageRoot();
		if (!oldRoot || oldRoot === newRoot) { return; }
		try {
			const n = await migrateKnowledgeStorage(ctx.fileService, oldRoot, newRoot);
			if (n > 0) {
				ctx.logService.info(`[Knowledge] migrated ${n} knowledge base(s) from ${oldRoot} → ${newRoot}`);
			}
		} catch (err) {
			ctx.logService.error(`[Knowledge] KB migration failed: ${err}`);
		}
	}

	return { registerEmbeddingProvider, registerKnowledgeTools };
}
