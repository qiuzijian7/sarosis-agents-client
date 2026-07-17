/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knowledge Storage Tools — 内置 Embedding Provider + Plan-C Hyper-Extract 知识引擎 (kb_* tools)
 * 与 KB 存储根迁移逻辑。
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
import { join } from '../../../../../../base/common/path.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IAiEmbeddingVectorService } from '../../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import { buildKnowledgeToolDescriptors, KnowledgeToolDeps } from '../../knowledge/knowledgeTools.js';
import { resolveKbRoot, migrateKnowledgeStorage, listKbIds } from '../../knowledge/knowledgeStorage.js';
import { createBuiltinEmbeddingProvider } from '../../knowledge/builtinEmbeddingProvider.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface KnowledgeStorageContext {
	/** 注册一个内置工具（来自 buildKnowledgeToolDescriptors 的 descriptor）。 */
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
		const deps: KnowledgeToolDeps = {
			fileService: ctx.fileService,
			configurationService: ctx.configurationService,
			embeddingService: ctx.embeddingService,
			resolveBaseDir: () => resolveWorkspaceDir(),
			resolveStorageRoot: () => resolveKbStorageRoot(),
		};
		for (const d of buildKnowledgeToolDescriptors(deps)) {
			ctx.register(d as unknown as IBuiltinToolRegistration);
		}

		// Best-effort one-time migration: the default storage root used to be
		// <workspace>/.saros/kb; it now defaults to <userHome>/.saros/kb.
		// Move any existing KBs from the legacy location on first activation.
		void migrateLegacyKbStorage();

		// Auto-migrate when the user changes the storage root setting.
		ctx.addDisposable(ctx.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ctx.kbStoragePathKey)) {
				void maybeMigrateKbStorage();
			}
		}));
	}

	/** Workspace root — used to resolve relative source/output file paths in kb_* tools. */
	async function resolveWorkspaceDir(): Promise<string> {
		try {
			const wsId = ctx.studioService.getActiveWorkspaceId();
			if (wsId) {
				const ws = await ctx.studioService.getWorkspace(wsId);
				if (ws?.path) { return ws.path; }
			}
		} catch {
			// fall through to VS Code folders
		}
		const folders = ctx.workspaceService.getWorkspace().folders;
		if (folders.length) { return folders[0].uri.fsPath; }
		const home = (ctx.environmentService as any).userHome?.fsPath;
		return home ?? (typeof process !== 'undefined' ? process.cwd() : '.');
	}

	/** KB storage root. Default `<userHome>/.saros/kb`; config overrides (supports ~ / absolute / relative-to-home). */
	async function resolveKbStorageRoot(): Promise<string> {
		const cfg = ctx.configurationService.getValue<string>(ctx.kbStoragePathKey);
		const userHome = (ctx.environmentService as any).userHome?.fsPath
			?? (typeof process !== 'undefined' ? process.cwd() : '.');
		const root = resolveKbRoot(cfg, userHome);
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

	/** One-time migration from the legacy `<workspace>/.saros/kb` location to the new default home root. */
	async function migrateLegacyKbStorage(): Promise<void> {
		try {
			const userHome = (ctx.environmentService as any).userHome?.fsPath
				?? (typeof process !== 'undefined' ? process.cwd() : '.');
			const newRoot = resolveKbRoot(undefined, userHome);
			const legacyRoot = await legacyKbRoot();
			if (!legacyRoot || legacyRoot === newRoot) { return; }
			const legacyIds = await listKbIds(ctx.fileService, legacyRoot);
			if (legacyIds.length === 0) { return; }
			const n = await migrateKnowledgeStorage(ctx.fileService, legacyRoot, newRoot);
			if (n > 0) {
				ctx.logService.info(`[Knowledge] migrated ${n} legacy knowledge base(s) from ${legacyRoot} → ${newRoot}`);
			}
		} catch (err) {
			ctx.logService.error(`[Knowledge] legacy KB migration failed: ${err}`);
		}
	}

	/** The pre-change default KB root: `<workspace>/.saros/kb`. */
	async function legacyKbRoot(): Promise<string | undefined> {
		try {
			const wsId = ctx.studioService.getActiveWorkspaceId();
			if (wsId) {
				const ws = await ctx.studioService.getWorkspace(wsId);
				if (ws?.path) { return join(ws.path, '.saros', 'kb'); }
			}
		} catch {
			// fall through
		}
		const folders = ctx.workspaceService.getWorkspace().folders;
		if (folders.length) { return join(folders[0].uri.fsPath, '.saros', 'kb'); }
		return undefined;
	}

	return { registerEmbeddingProvider, registerKnowledgeTools };
}
