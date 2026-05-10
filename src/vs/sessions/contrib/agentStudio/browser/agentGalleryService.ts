/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentGalleryService, AgentTemplate } from '../common/agentInstance.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Agent Gallery Service Implementation ─────────────────────────

export class AgentGalleryService extends Disposable implements IAgentGalleryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTemplates = this._register(new Emitter<void>());
	readonly onDidChangeTemplates = this._onDidChangeTemplates.event;

	private _logService: ILogService = console as unknown as ILogService;
	private _templates: AgentTemplate[] = [];

	constructor() {
		super();
		this._loadTemplates();
	}

	async getTemplates(): Promise<AgentTemplate[]> {
		return this._templates;
	}

	async getTemplatesByCategory(category: string): Promise<AgentTemplate[]> {
		return this._templates.filter(t => t.category === category);
	}

	async searchTemplates(query: string): Promise<AgentTemplate[]> {
		const lowerQuery = query.toLowerCase();
		return this._templates.filter(t =>
			t.name.toLowerCase().includes(lowerQuery) ||
			t.description.toLowerCase().includes(lowerQuery) ||
			t.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
		);
	}

	private _loadTemplates(): void {
		// TODO: 从远程或本地模板仓库加载
		// 暂时返回模拟数据
		this._templates = [
			{
				id: 'general-assistant',
				name: 'General Assistant',
				description: '通用对话助手，适用于大多数场景',
				category: 'general',
				defaultConfig: {},
				tags: ['chat', 'general'],
			},
			{
				id: 'code-generator',
				name: 'Code Generator',
				description: '代码生成助手，支持多种编程语言',
				category: 'codegen',
				defaultConfig: {},
				tags: ['code', 'generation'],
			},
			{
				id: 'data-analyst',
				name: 'Data Analyst',
				description: '数据分析助手，支持 SQL、Python、可视化',
				category: 'data-analysis',
				defaultConfig: {},
				tags: ['data', 'sql', 'python'],
			},
		];
		this._onDidChangeTemplates.fire();
		this._logService.info('[AgentGallery] Templates loaded:', this._templates.length);
	}

	setLogService(logService: ILogService): void {
		this._logService = logService;
	}
}
