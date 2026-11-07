/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★ P3（2026-11-07）：IDE 侧技能资源管理器已整体下线。
 *
 * 原本这里是一个 2400 行的技能详情编辑器（列表 / 使用说明 / 文件树 / AutoGit 版本历史 /
 * 商城发布 / 重命名 / 卸载 / AI 评测），依赖 `ISkillRegistry` / `ISkillInstallService` /
 * `ISkillVersionService` 三个 IDE 侧服务。技能真源、浏览、创建、安装、版本与评测现在全在
 * dsh 侧（`dsh-skill-bundle` / `vssaros-skills` 的 `/x/skills/` / `vssaros-marketplace`）。
 *
 * 这里只保留一个**兼容壳**：外部仍有 3 处会打开本编辑器（页面桥的模块设置、
 * Agent 设置页的技能详情、MCP 商城包预览），直接删类会破坏它们的 import 与
 * `instanceof` 判断。壳不读任何技能服务，只给出可读的迁移指引 ⇒ 不会「点了没反应」。
 */

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ResourceManagerEditorInput, ResourceManagerEditorPane_ID } from './resourceManagerEditorInput.js';
import { IMarketplacePackage } from '../common/marketplace.js';

/** 保留旧类型形状，避免外部调用点的字面量参数编译失败。 */
type ResourceType = 'skill' | 'knowledge' | 'workflow';

export class ResourceManagerEditorPane extends EditorPane {

	static readonly ID = ResourceManagerEditorPane_ID;

	private _container!: HTMLElement;
	private _title = '技能与资源已迁到 dsh 侧「工具 / 技能」页（/x/skills/）管理。';
	private _resourceId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(ResourceManagerEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	/** 外部调用方通过 `pane.getControl()` 拿到本实例再调下面的公开方法。 */
	override getControl(): ResourceManagerEditorPane {
		return this;
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.resource-manager-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);
		this._render();
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._render();
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	/** 模块设置 / Agent 设置页仍会传 `type='skill'`；这里只给迁移指引，不再查技能库。 */
	async showDetailOnly(_type: ResourceType, itemId: string): Promise<void> {
		this._resourceId = itemId;
		if (this.input instanceof ResourceManagerEditorInput) {
			this.input.setItemName(itemId);
		}
		this._render();
	}

	/** MCP 商城包预览入口保留形状；技能商城包同样指向 dsh 侧。 */
	showMarketplacePackage(pkg: IMarketplacePackage): void {
		this._resourceId = pkg.slug ?? pkg.id;
		this._title = '商城包预览已迁到 dsh 侧「工具 / 商城」页（/x/marketplace/）。';
		if (this.input instanceof ResourceManagerEditorInput) {
			this.input.setItemName(pkg.name);
		}
		this._render();
	}

	private _render(): void {
		if (!this._container) { return; }
		clearNode(this._container);

		const box = $('div.rm-pane-notice');
		box.style.padding = '24px';
		box.style.color = 'var(--vscode-foreground, inherit)';

		const title = $('div');
		title.style.fontSize = '14px';
		title.style.lineHeight = '1.6';
		title.textContent = this._title;
		box.appendChild(title);

		if (this._resourceId) {
			const detail = $('div');
			detail.style.marginTop = '10px';
			detail.style.color = 'var(--vscode-descriptionForeground, inherit)';
			detail.textContent = `资源：${this._resourceId}`;
			box.appendChild(detail);
		}

		this._container.appendChild(box);
	}
}
