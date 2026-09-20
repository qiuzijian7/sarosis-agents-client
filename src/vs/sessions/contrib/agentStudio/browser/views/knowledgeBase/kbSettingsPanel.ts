/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbSettingsPanel.ts — 知识库「设置」下拉面板的 DOM 构建。
 *
 *  从 knowledgeBaseView.ts 的 renderSettingsPanel()（约 177 行）抽出：本函数只负责
 *  依据传入的快照值 + 回调构建面板 DOM，不含任何 ViewPane 实例状态依赖，
 *  便于独立测试并降低主文件体积。行为与原实现逐字一致。
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../../base/browser/domSanitize.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { IEmbeddingProviderInfo } from '../../../common/embeddingProvider.js';
import { resolveAuxEmbeddingConfig } from '../../knowledge/embeddingConfigResolver.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_KB_AGENTIC_BUILD,
} from '../../../common/constants.js';
import { formatSizeFull } from './kbViewUtils.js';

/** 构建设置面板所需的上下文（由 View 组装，避免面板依赖 ViewPane 实例） */
export interface IKbSettingsPanelContext {
	/** 面板挂载容器（会被 replaceChildren 清空后重建） */
	container: HTMLElement;
	/** VS Code 配置服务（读写 Embedding 相关配置） */
	configurationService: IConfigurationService;
	/** 已配置的 Embedding Provider 列表 */
	providers: readonly IEmbeddingProviderInfo[];
	/** 知识库根目录绝对路径 */
	rootPath: string;
	/** 当前 Vault 是否激活（用于展示统计块） */
	hasActiveVault: boolean;
	/** 文档数量与总大小（统计块；hasActiveVault 为 false 时不使用） */
	docCount: number;
	totalSize: number;
	/** 是否启用 SQLite FTS5（统计块展示标记） */
	sqliteActive: boolean;
	/** 已关联工作区数量（统计块展示；0 表示不展示） */
	linkedWorkspaceCount: number;
	/** 当前 agentic 构建开关状态（AGENT_STUDIO_KB_AGENTIC_BUILD） */
	agenticBuild: boolean;
	/** 操作日志回调（settings.embedding.*） */
	logOp: (code: string, detail: Record<string, unknown>) => void;
	/** 打开文件夹选择框 */
	onPickDir: (current: string) => void;
	/** 手动输入路径后提交 */
	onApplyDir: (dir: string) => void;
	/** 重新构建向量索引 */
	onRebuildVectorIndex: () => void;
	/** 打开知识库文件夹 */
	onOpenKbFolder: () => void;
	/** 重新渲染面板（手动输入取消时回退） */
	onRerender: () => void;
}

/** 构建并挂载知识库设置面板；返回容器以便调用方继续操作 */
export function renderKbSettingsPanel(ctx: IKbSettingsPanelContext): HTMLElement {
	const dd = ctx.container;
	dd.replaceChildren();

	const title = $('div.kb-dd-title'); title.textContent = '知识库设置';
	dd.appendChild(title);

	// 知识库目录配置行（Vault 及其「库」「笔记」子文件夹均在此目录下）
	const row = $('div.kb-set-row');
	const label = $('span.kb-set-label'); label.textContent = '📁 知识库目录';
	const path = $('span.kb-set-path'); path.id = 'kbRootPath'; path.textContent = ctx.rootPath;
	const browse = $('span.kb-set-btn.primary'); browse.id = 'kbRootBrowse'; browse.textContent = '📂'; browse.title = '浏览文件夹…';
	const manual = $('span.kb-set-btn'); manual.id = 'kbRootManual'; manual.textContent = '📄'; manual.title = '手动输入路径';
	row.append(label, path, browse, manual);
	dd.appendChild(row);

	const hint = $('div.kb-set-hint'); hint.textContent = '点击 📂 选择文件夹，或 📄 手动输入路径（Vault 及其「库」「笔记」子文件夹均在此目录下）';
	dd.appendChild(hint);

	// ── 构建方式（agentic 构建开关，默认开启）──
	const buildDivider = $('div.kb-divider');
	dd.appendChild(buildDivider);

	const buildRow = $('div.kb-set-row');
	const buildLabel = $('span.kb-set-label'); buildLabel.textContent = '⚙️ 构建方式';
	const buildToggle = $('input') as HTMLInputElement;
	buildToggle.type = 'checkbox'; buildToggle.id = 'kbAgenticBuild'; buildToggle.checked = ctx.agenticBuild;
	buildToggle.title = 'Agentic 构建（knowledge-base-expert agent）';
	const buildToggleText = $('span.kb-set-hint-inline'); buildToggleText.textContent = 'Agentic 构建（知识库专家 Agent）';
	buildToggle.onchange = () => {
		ctx.configurationService.updateValue(AGENT_STUDIO_KB_AGENTIC_BUILD, buildToggle.checked);
		ctx.logOp('settings.kb.agenticBuild', { target: buildToggle.checked ? 'on' : 'off' });
	};
	buildRow.append(buildLabel, buildToggle, buildToggleText);
	dd.appendChild(buildRow);

	const buildHint = $('div.kb-set-hint');
	buildHint.textContent = '开启后由知识库专家 Agent 构建笔记（技能注入 + 工具能力，质量更高但更慢）；失败自动回退直连管线';
	dd.appendChild(buildHint);

	// ── Embedding 模型配置 ──
	const embDivider = $('div.kb-divider');
	dd.appendChild(embDivider);

	const embTitle = $('div.kb-dd-title'); embTitle.textContent = '🧬 Embedding 模型';
	dd.appendChild(embTitle);

	const embCfg = resolveAuxEmbeddingConfig(ctx.configurationService);

	// Provider select — 已配置的 Embedding Provider 列表（Auto 始终首位）
	const providerRow = $('div.kb-set-row');
	const providerLabel = $('span.kb-set-label'); providerLabel.textContent = 'Provider';
	const providerSelect = document.createElement('select') as HTMLSelectElement;
	providerSelect.className = 'kb-set-select';

	const autoOpt = document.createElement('option');
	autoOpt.value = 'auto'; autoOpt.textContent = 'Auto（自动）';
	if (embCfg.providerId === 'auto') { autoOpt.selected = true; }
	providerSelect.appendChild(autoOpt);

	const configuredProviders = ctx.providers.filter(p => p.configured);
	for (const p of configuredProviders) {
		const o = document.createElement('option');
		o.value = p.id;
		o.textContent = `${p.kind === 'openai' ? 'OpenAI' : 'Local'} / ${p.model} (${p.dimensions}d)`;
		if (p.id === embCfg.providerId) { o.selected = true; }
		providerSelect.appendChild(o);
	}
	// 当前选中 provider 不在已配置列表中（可能被动态移除）→ 额外标记项提示用户
	if (embCfg.providerId && embCfg.providerId !== 'auto' && !configuredProviders.some(p => p.id === embCfg.providerId)) {
		const o = document.createElement('option');
		o.value = embCfg.providerId;
		o.textContent = `${embCfg.providerId}（未配置）`;
		o.selected = true;
		o.disabled = false;
		providerSelect.appendChild(o);
	}

	providerSelect.onchange = () => {
		ctx.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, providerSelect.value);
		ctx.logOp('settings.embedding.provider', { target: providerSelect.value });
	};
	providerRow.append(providerLabel, providerSelect);
	dd.appendChild(providerRow);

	const providerHint = $('div.kb-set-hint'); providerHint.textContent = 'Auto 表示跟随全局 Embedding Provider 设置';
	dd.appendChild(providerHint);

	// Model input
	const modelRow = $('div.kb-set-row');
	const modelLabel = $('span.kb-set-label'); modelLabel.textContent = 'Model';
	const modelInput = document.createElement('input');
	modelInput.className = 'kb-set-input';
	modelInput.value = embCfg.modelId;
	modelInput.placeholder = 'text-embedding-3-small';
	modelInput.onchange = () => {
		const v = modelInput.value.trim();
		if (v) {
			ctx.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_MODEL, v);
			ctx.logOp('settings.embedding.model', { target: v });
		}
	};
	modelRow.append(modelLabel, modelInput);
	dd.appendChild(modelRow);

	const modelHint = $('div.kb-set-hint'); modelHint.textContent = '向量化模型 ID（留空使用默认 text-embedding-3-small）';
	dd.appendChild(modelHint);

	// Dimensions input
	const dimRow = $('div.kb-set-row');
	const dimLabel = $('span.kb-set-label'); dimLabel.textContent = 'Dimensions';
	const dimInput = document.createElement('input');
	dimInput.type = 'number';
	dimInput.className = 'kb-set-num';
	dimInput.value = String(embCfg.dimensions);
	dimInput.min = '1'; dimInput.max = '8192'; dimInput.step = '64';
	dimInput.onchange = () => {
		const v = parseInt(dimInput.value, 10);
		if (Number.isFinite(v) && v > 0) {
			ctx.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, v);
			ctx.logOp('settings.embedding.dimensions', { target: String(v) });
		}
	};
	dimRow.append(dimLabel, dimInput);
	dd.appendChild(dimRow);

	const dimHint = $('div.kb-set-hint'); dimHint.textContent = '向量维度（默认 512，范围 1-8192，修改后需重建索引）';
	dd.appendChild(dimHint);

	// 重建向量索引按钮
	const rebuildRow = $('div.kb-set-row');
	const rebuildBtn = $('div.kb-set-action'); rebuildBtn.textContent = '🔄 重新构建向量索引';
	rebuildBtn.onclick = (e) => {
		e.stopPropagation();
		dd.classList.remove('show');
		ctx.onRebuildVectorIndex();
	};
	rebuildRow.appendChild(rebuildBtn);
	dd.appendChild(rebuildRow);

	// ── Vault 统计 ──
	if (ctx.hasActiveVault) {
		const stats = $('div.kb-set-hint');
		stats.style.paddingTop = '8px';
		stats.style.borderTop = `1px solid var(--vscode-panel-border, #444)`;
		stats.style.marginTop = '4px';
		let statsHtml = [
			`📄 ${ctx.docCount} 文档`,
			ctx.totalSize > 0 ? `· ${formatSizeFull(ctx.totalSize)}` : '',
			ctx.sqliteActive ? '· 🗄️ SQLite FTS5' : '· 💾 内存索引',
		].filter(Boolean).join(' ');
		if (ctx.linkedWorkspaceCount > 0) {
			statsHtml += ` · 🔧 ${ctx.linkedWorkspaceCount} 工作区`;
		}
		safeSetInnerHtml(stats, statsHtml);
		dd.appendChild(stats);
	}

	// 快捷入口：打开当前知识库文件夹
	const openRow = $('div.kb-set-row');
	const openBtn = $('div.kb-set-action'); openBtn.textContent = '📂 打开知识库文件夹';
	openBtn.onclick = (e) => { e.stopPropagation(); dd.classList.remove('show'); ctx.onOpenKbFolder(); };
	openRow.appendChild(openBtn);
	dd.appendChild(openRow);

	// 交互：浏览 / 手动输入
	const rootPath = path;
	browse.onclick = (e) => { e.stopPropagation(); ctx.onPickDir(rootPath.textContent ?? ''); };
	manual.onclick = (e) => {
		e.stopPropagation();
		const input = document.createElement('input');
		input.className = 'kb-set-input';
		input.value = rootPath.textContent ?? '';
		rootPath.replaceWith(input);
		input.focus(); input.select();
		let done = false;
		const commit = (save: boolean) => {
			if (done) { return; }
			done = true;
			const v = input.value.trim();
			if (save && v) { ctx.onApplyDir(v); }
			else { ctx.onRerender(); }
		};
		input.onkeydown = (ke) => {
			if (ke.key === 'Enter') { ke.preventDefault(); commit(true); }
			else if (ke.key === 'Escape') { ke.preventDefault(); commit(false); }
		};
		input.onblur = () => commit(true);
	};

	return dd;
}
