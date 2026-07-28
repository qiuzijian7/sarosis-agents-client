/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServiceCollection } from '../../instantiation/common/serviceCollection.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnhancedSessionStore, IMemoryEntry, ICompressionLogEntry } from '../common/enhancedSessionStore.js';
import { IContextCompressionService } from '../common/contextCompression.js';
import { IMemoryService } from '../common/memoryService.js';
import { ContextCompressionService } from './contextCompressionService.js';
import { MemoryService } from './memoryServiceImpl.js';
import { BuiltinMemoryProvider } from './builtinMemoryProvider.js';
import { ICopilotApiService, CopilotApiService } from './shared/copilotApiService.js';
import { IAgentService } from '../common/agentService.js';
import { AgentHostIntegration } from './agentHostIntegration.js';

// TODO: Implement EnhancedSessionStore class - temporary stub
// 注意：当前为进程内存态实现（不落盘），压缩流水线的记忆持久化/压缩日志为空操作。
// 接入真实 SQLite 存储是框架 Phase 2 的独立工作项。
export class EnhancedSessionStore implements IEnhancedSessionStore {
	declare readonly _serviceBrand: undefined;

	constructor() {}

	dispose(): void {}

	// Memory Operations
	insertMemory(entry: Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): string {
		return `mem_${Date.now()}`;
	}

	updateMemory(id: string, updates: Partial<Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>): void {}

	deleteMemory(id: string): void {}

	getMemories(filter?: any): IMemoryEntry[] { return []; }

	incrementMemoryAccess(id: string): void {}

	// Enhanced Search
	searchWithRelevance(query: string, options?: any): any[] { return []; }

	// Compression Log
	logCompression(entry: Omit<ICompressionLogEntry, 'id' | 'compressedAt'>): void {}

	getCompressionHistory(sessionId: string): ICompressionLogEntry[] { return []; }

	getLatestCompression(sessionId: string): ICompressionLogEntry | undefined { return undefined; }
}

/**
 * Register all Agent Host enhancement services to a ServiceCollection.
 *
 * Call this function in agentHostServerMain.ts or agentHostMain.ts to register:
 * - ICopilotApiService (for LLM calls)
 * - IEnhancedSessionStore (wraps Chronicle SessionStore with memories + compression support)
 * - IContextCompressionService (5-stage compression pipeline)
 * - IMemoryService (memory management with provider support)
 * - BuiltinMemoryProvider (default memory provider)
 *
 * Usage:
 * ```typescript
 * // In agentHostServerMain.ts or agentHostMain.ts
 * import { registerAgentHostEnhancementServices } from 'vs/platform/agentHost/node/agentHostServices';
 *
 * const services = new ServiceCollection();
 * registerAgentHostEnhancementServices(services, instantiationService, logService, configurationService);
 * ```
 */
/** 框架激活后创建的服务实例集合（供调用方继续接线，如 ProtocolServerHandler 注入压缩服务） */
export interface IEnhancementServices {
	readonly sessionStore: IEnhancedSessionStore;
	readonly copilotApiService: ICopilotApiService;
	readonly compressionService: ContextCompressionService;
	readonly memoryService: MemoryService;
	/** 自动压缩触发器；IAgentService 未注册时为 undefined（降级不激活） */
	readonly integration: AgentHostIntegration | undefined;
}

export function registerAgentHostEnhancementServices(
	services: ServiceCollection,
	instantiationService: IInstantiationService,
	logService: ILogService,
	configurationService: IConfigurationService,
): IEnhancementServices {
	// 1. CopilotApiService (needed for LLM calls in compression)
	// 复用集合中已注册的实例（main 中经 createInstance 构造、带完整依赖），仅缺失时新建。
	let copilotApiService: ICopilotApiService;
	if (services.has(ICopilotApiService)) {
		copilotApiService = services.get(ICopilotApiService) as ICopilotApiService;
	} else {
		const productServiceStub = { _serviceBrand: undefined } as any; // Temporary stub
		copilotApiService = new CopilotApiService(
			globalThis.fetch?.bind(globalThis) ?? fetch,
			logService,
			productServiceStub,
		);
		services.set(ICopilotApiService, copilotApiService);
	}

	// 2. Register EnhancedSessionStore
	// TODO: Pass real DB path when implementing the actual class
	const enhancedSessionStore = new EnhancedSessionStore();
	services.set(IEnhancedSessionStore, enhancedSessionStore);

	// 3. Register ContextCompressionService
	// This will be created by the instantiation service with proper DI
	// For now, we create it manually
	// IAgentService 若已注册则注入（供 _getSessionMessages 经 listSessions/subscribe 快照拉取消息）；
	// 未注册时传 undefined，服务降级为返回空消息列表并告警。
	const agentService = instantiationService.invokeFunction(accessor => {
		try { return accessor.get(IAgentService); } catch { return undefined; }
	});
	const compressionService = new ContextCompressionService(
		enhancedSessionStore,
		configurationService,
		logService,
		copilotApiService,
		agentService,
	);
	services.set(IContextCompressionService, compressionService);

	// 4. Register MemoryService
	const memoryService = new MemoryService(
		enhancedSessionStore,
		logService,
	);
	services.set(IMemoryService, memoryService);

	// 5. Register BuiltinMemoryProvider as a memory provider
	const builtinProvider = new BuiltinMemoryProvider(
		enhancedSessionStore,
		logService,
	);
	memoryService.registerProvider(builtinProvider);

	// 6. Create AgentHostIntegration（框架激活入口：事件订阅 → 自动压缩触发）。
	// 依赖 IAgentService —— 缺失时降级不激活并告警。
	let integration: AgentHostIntegration | undefined;
	if (agentService) {
		integration = new AgentHostIntegration(agentService, compressionService, memoryService, logService);
	} else {
		logService.warn('[AgentHostServices] IAgentService not registered — AgentHostIntegration (auto-compression) NOT activated');
	}

	logService.info('[AgentHostServices] Enhancement services registered');
	return { sessionStore: enhancedSessionStore, copilotApiService, compressionService, memoryService, integration };
}

/**
 * Initialize the enhancement services after they are registered.
 * This should be called after the services are registered and the DI system is ready.
 */
export async function initializeAgentHostEnhancements(
	memoryService: IMemoryService,
	compressionService: IContextCompressionService,
): Promise<void> {
	// Initialize memory service
	await memoryService.initialize(''); // Empty string = global initialization

	// Additional initialization if needed
}
