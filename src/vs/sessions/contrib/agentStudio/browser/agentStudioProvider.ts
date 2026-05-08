/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ISessionsProvider, ISessionChangeEvent, ISendRequestOptions } from '../../../services/sessions/common/sessionsProvider.js';
import { ISession, ISessionType, ISessionWorkspaceBrowseAction, ISessionWorkspace, IChat } from '../../../services/sessions/common/session.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { AGENT_STUDIO_PROVIDER_ID } from '../common/constants.js';

export class AgentStudioProvider extends Disposable implements ISessionsProvider {
	readonly id = AGENT_STUDIO_PROVIDER_ID;
	readonly label = 'Agent Studio';
	readonly icon = ThemeIcon.fromId(Codicon.hubot.id);

	private readonly _sessionTypes: ISessionType[] = [
		{
			id: 'agentStudio.local',
			label: 'Agent Studio (Local)',
			icon: ThemeIcon.fromId(Codicon.hubot.id),
		} as ISessionType,
	];

	get sessionTypes(): readonly ISessionType[] {
		return this._sessionTypes;
	}

	private readonly _onDidChangeSessionTypes = this._register(new Emitter<void>());
	readonly onDidChangeSessionTypes: Event<void> = this._onDidChangeSessionTypes.event;

	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionChangeEvent>());
	readonly onDidChangeSessions: Event<ISessionChangeEvent> = this._onDidChangeSessions.event;

	readonly browseActions: readonly ISessionWorkspaceBrowseAction[] = [];
	readonly supportsLocalWorkspaces = true;

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	) {
		super();
	}

	getSessions(): ISession[] {
		// TODO: map AgentStudioSession[] to ISession[]
		return [];
	}

	resolveWorkspace(_repositoryUri: URI): ISessionWorkspace | undefined {
		// TODO: resolve workspace from URI
		return undefined;
	}

	createNewSession(_repositoryUri: URI, _sessionTypeId: string): ISession {
		// TODO: create a new Agent Studio session
		throw new Error('Not implemented');
	}

	getSessionTypes(_repositoryUri: URI): ISessionType[] {
		return [...this._sessionTypes];
	}

	async renameChat(_sessionId: string, _chatUri: URI, _title: string): Promise<void> {
		// TODO: implement
	}

	setModel(_sessionId: string, _modelId: string): void {
		// TODO: implement
	}

	async archiveSession(_sessionId: string): Promise<void> {
		// TODO: implement
	}

	async unarchiveSession(_sessionId: string): Promise<void> {
		// TODO: implement
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.agentStudioService.deleteSession(sessionId);
	}

	async deleteChat(_sessionId: string, _chatUri: URI): Promise<void> {
		// TODO: implement
	}

	async sendAndCreateChat(_sessionId: string, _options: ISendRequestOptions): Promise<ISession> {
		throw new Error('Not implemented');
	}

	addChat(_sessionId: string): IChat {
		throw new Error('Not implemented');
	}

	async sendRequest(_sessionId: string, _chatResource: URI, _options: ISendRequestOptions): Promise<ISession> {
		throw new Error('Not implemented');
	}
}
