/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentGalleryService, AgentTemplate } from '../common/agentInstance.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

// ─── Agent Gallery Service Implementation ─────────────────────────

export class AgentGalleryService extends Disposable implements IAgentGalleryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTemplates = this._register(new Emitter<void>());
	readonly onDidChangeTemplates = this._onDidChangeTemplates.event;

	private readonly _logService: ILogService;
	private readonly _fileService: IFileService;
	private _templates: AgentTemplate[] = [];

	constructor(
		@ILogService logService: ILogService,
		@IFileService fileService: IFileService,
	) {
		super();
		this._logService = logService;
		this._fileService = fileService;
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

	private async _loadTemplates(): Promise<void> {
		// 尝试从本地文件系统加载模板
		try {
			if (this._fileService) {
				await this._loadTemplatesFromDisk();
			} else {
				this._logService.warn('[AgentGallery] No FileService available, using mock data');
				this._loadMockTemplates();
			}
		} catch (error) {
			this._logService.error('[AgentGallery] Failed to load templates from disk, falling back to mock data', error);
			this._loadMockTemplates();
		}
		this._onDidChangeTemplates.fire();
		this._logService.info('[AgentGallery] Templates loaded:', this._templates.length);
	}

	private async _loadTemplatesFromDisk(): Promise<void> {
		if (!this._fileService) {
			return;
		}

		// 模板目录：.saros/templates/
		// 每个模板是一个子目录，包含 template.yaml
		const templatesDir = URI.from({ scheme: 'file', path: '.saros/templates' });

		try {
			const children = await this._fileService.resolve(templatesDir);
			if (children.children) {
				for (const child of children.children) {
					if (child.isDirectory) {
						const template = await this._loadTemplateFromDirectory(child.resource);
						if (template) {
							this._templates.push(template);
						}
					}
				}
			}
		} catch (error) {
			this._logService.error('[AgentGallery] Error reading templates directory', error);
			throw error;
		}
	}

		private async _loadTemplateFromDirectory(dirUri: URI): Promise<AgentTemplate | undefined> {
		try {
			const templateFile = URI.joinPath(dirUri, 'template.yaml');
			const content = await this._fileService!.readFile(templateFile);
			const templateData = this._parseYaml(content.value.toString());
			return {
				id: (templateData.id as string) || dirUri.path.split('/').pop() || 'unknown',
				name: (templateData.name as string) || 'Unnamed Template',
				description: (templateData.description as string) || '',
				category: (templateData.category as string) || 'general',
				icon: templateData.icon as string | undefined,
				defaultConfig: (templateData.defaultConfig as Record<string, unknown>) || {},
				tags: (templateData.tags as string[]) || [],
			};
		} catch (error) {
			this._logService.error(`[AgentGallery] Failed to load template from ${dirUri.toString()}`, error);
			return undefined;
		}
	}

	private _parseYaml(content: string): Record<string, unknown> {
		// 简单的 YAML 解析（仅支持基本键值对）
		// 生产环境应使用 js-yaml 或类似库
		try {
			// 尝试解析为 JSON（如果文件是 JSON 格式）
			return JSON.parse(content);
		} catch {
			// 简单的 YAML 解析
			const result: Record<string, unknown> = {};
			const lines = content.split('\n');
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith('#') || !trimmed.includes(':')) {
					continue;
				}
				const idx = trimmed.indexOf(':');
				const key = trimmed.substring(0, idx).trim();
				const value = trimmed.substring(idx + 1).trim();
				result[key] = value;
			}
			return result;
		}
	}

	private _loadMockTemplates(): void {
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
	}
}
