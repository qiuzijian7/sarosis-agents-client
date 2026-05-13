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

// TODO: Implement EnhancedSessionStore class - temporary stub
class EnhancedSessionStore implements IEnhancedSessionStore {
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
export function registerAgentHostEnhancementServices(
	services: ServiceCollection,
	instantiationService: IInstantiationService,
	logService: ILogService,
	configurationService: IConfigurationService,
): void {
	// 1. Register CopilotApiService (needed for LLM calls in compression)
	// Note: This needs a fetch function - provide globalThis.fetch or a custom implementation
	// TODO: Pass real productService instead of empty object
	const productServiceStub = { _serviceBrand: undefined } as any; // Temporary stub
	const copilotApiService = new CopilotApiService(
		globalThis.fetch?.bind(globalThis) ?? fetch,
		logService,
		productServiceStub,
	);
	services.set(ICopilotApiService, copilotApiService);

	// 2. Register EnhancedSessionStore
	// TODO: Pass real DB path when implementing the actual class
	const enhancedSessionStore = new EnhancedSessionStore();
	services.set(IEnhancedSessionStore, enhancedSessionStore);

	// 3. Register ContextCompressionService
	// This will be created by the instantiation service with proper DI
	// For now, we create it manually
	const compressionService = new ContextCompressionService(
		enhancedSessionStore,
		configurationService,
		logService,
		copilotApiService,
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

	logService.info('[AgentHostServices] Enhancement services registered');
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
