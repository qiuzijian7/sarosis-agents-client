/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IGitHubService } from '../../../../contrib/github/browser/githubService.js';
import { SarosLocalAgentHostSessionsProvider } from '../../browser/sarosLocalAgentHostSessionsProvider.js';
import { SAROS_LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';

// ---- Mock IAgentHostService -------------------------------------------------

class MockAgentHostService extends mock<IAgentHostService>() {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAction = new Emitter<any>();
	override readonly onDidAction = this._onDidAction.event;
	private readonly _onDidNotification = new Emitter<any>();
	override readonly onDidNotification = this._onDidNotification.event;

	override readonly clientId = 'test-saros-client';

	constructor() {
		super();
	}

	fireNotification(n: any): void {
		this._onDidNotification.fire(n);
	}

	dispose(): void {
		this._onDidAction.dispose();
		this._onDidNotification.dispose();
	}
}

// ---- Test helpers -----------------------------------------------------------

function createSarosProvider(
	disposables: DisposableStore,
	agentHostService: MockAgentHostService,
	options?: {
		checkpointsEnabled?: boolean;
	},
): SarosLocalAgentHostSessionsProvider {
	const instantiationService = disposables.add(new TestInstantiationService());

	const configService = new TestConfigurationService();
	configService.setUserConfiguration('chat.checkpoints.enabled', options?.checkpointsEnabled ?? true);

	instantiationService.stub(IAgentHostService, agentHostService);
	instantiationService.stub(IConfigurationService, configService);
	instantiationService.stub(IFileDialogService, {});
	instantiationService.stub(IChatSessionsService, {
		getChatSessionContribution: () => ({ type: 'agent-host-copilotcli', name: 'copilot', displayName: 'Copilot', description: 'test', icon: undefined }),
		getAllChatSessionContributions: () => [{ type: 'agent-host-copilotcli', name: 'copilot', displayName: 'Copilot', description: 'test', icon: undefined }],
		getOrCreateChatSession: async () => ({ onWillDispose: () => ({ dispose() { } }), sessionResource: { scheme: 'test' } as any, history: [], dispose() { } }),
	});
	instantiationService.stub(IChatService, {
		acquireOrLoadSession: async () => undefined,
		sendRequest: async () => ({ kind: 'sent' as const, data: {} as any }),
	});
	instantiationService.stub(IChatWidgetService, {
		openSession: async () => undefined,
	});
	instantiationService.stub(ILanguageModelsService, {
		lookupLanguageModel: () => undefined,
	});
	instantiationService.stub(ILabelService, { getUriLabel: () => '' });
	instantiationService.stub(ILogService, new NullLogService());
	instantiationService.stub(IGitHubService, new class extends mock<IGitHubService>() {
		declare readonly _serviceBrand: undefined;
		override async findPullRequestNumberByHeadBranch(): Promise<number | undefined> { return undefined; }
	});

	return disposables.add(instantiationService.createInstance(SarosLocalAgentHostSessionsProvider));
}

// ---- Tests -----------------------------------------------------------------

suite('SarosLocalAgentHostSessionsProvider', () => {
	const disposables = new DisposableStore();
	let agentHost: MockAgentHostService;

	setup(() => {
		agentHost = disposables.add(new MockAgentHostService());
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	// ---- Provider identity -------

	test('has correct id (SAROS_LOCAL_AGENT_HOST_PROVIDER_ID)', () => {
		const provider = createSarosProvider(disposables, agentHost);
		assert.strictEqual(provider.id, SAROS_LOCAL_AGENT_HOST_PROVIDER_ID);
	});

	// ---- Checkpoint configuration -------

	test('respects checkpointsEnabled configuration', () => {
		const provider = createSarosProvider(disposables, agentHost, { checkpointsEnabled: false });
		// Access private field via any cast for testing
		assert.strictEqual((provider as any)._checkpointsEnabled, false);
	});

	test('checkpoints are enabled by default', () => {
		const provider = createSarosProvider(disposables, agentHost);
		assert.strictEqual((provider as any)._checkpointsEnabled, true);
	});
});
