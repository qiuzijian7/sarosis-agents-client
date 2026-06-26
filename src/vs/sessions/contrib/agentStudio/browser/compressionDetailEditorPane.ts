/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { CompressionDetailEditorInput, type ICompressionDetailData } from './compressionDetailEditorInput.js';

export class CompressionDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.compressionDetail';

	private _container: HTMLElement | null = null;
	private _dataChangeListener: IDisposable | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(CompressionDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.compression-detail-container'));
		const style = document.createElement('style');
		style.textContent = `
			.compression-detail-container { padding: 20px; overflow-y: auto; height: 100%; box-sizing: border-box; }
			.compression-detail-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: var(--vscode-foreground); }
			.compression-detail-empty { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
			.compression-detail-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
			.compression-stat-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 12px 16px; min-width: 100px; }
			.compression-stat-card .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
			.compression-stat-card .stat-value { font-size: 20px; font-weight: 600; color: var(--vscode-foreground); }
			.compression-stat-card.stat-saved .stat-value { color: #4ec9b0; }
			.compression-stat-card.stat-percent .stat-value { color: #4ec9b0; }
			.compression-detail-summary { margin-bottom: 20px; }
			.compression-summary-box { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 14px; font-size: 12px; line-height: 1.6; color: var(--vscode-foreground); max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
			.compression-detail-compare { margin-top: 8px; }
			.compare-title { font-size: 14px; font-weight: 500; margin-bottom: 12px; color: var(--vscode-foreground); }
			/* Diff 统计条 */
			.diff-toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; padding: 8px 0; }
			.diff-stat { font-size: 12px; display: flex; align-items: center; gap: 4px; }
			.diff-stat .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
			.diff-stat.removed .dot { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.3)); }
			.diff-stat.added .dot { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.3)); }
			.diff-stat.unchanged .dot { background: var(--vscode-descriptionForeground); }
			.diff-stat.removed { color: var(--vscode-errorForeground, #f48771); }
			.diff-stat.added { color: var(--vscode-diffEditor-insertedLineBackground, #4ec9b0); }
			.diff-stat.unchanged { color: var(--vscode-descriptionForeground); }
			/* Split Diff 逐行对齐布局 */
			.split-diff { border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; }
			.split-diff-headers { display: flex; border-bottom: 1px solid var(--vscode-widget-border); }
			.split-diff-header { flex: 1; padding: 8px 16px; font-size: 12px; font-weight: 600; background: var(--vscode-editorWidget-background); display: flex; align-items: center; gap: 6px; color: var(--vscode-foreground); }
			.split-diff-header.left { border-right: 1px solid var(--vscode-widget-border); border-bottom: 3px solid var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.3)); }
			.split-diff-header.right { border-bottom: 3px solid var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.3)); }
			.split-diff-header .header-count { background: var(--vscode-editor-background); border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
			.split-diff-body { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.6; max-height: 600px; overflow-y: auto; overflow-x: hidden; }
			/* 每行：flex 左右两个 cell，行高取两侧最大值自动对齐 */
			.diff-row { display: flex; align-items: stretch; min-height: 28px; }
			.diff-cell { flex: 1; min-width: 0; display: flex; align-items: flex-start; box-sizing: border-box; }
			.diff-cell.left { border-right: 1px solid var(--vscode-widget-border); }
			.diff-cell .line-gutter { width: 40px; min-width: 40px; text-align: right; padding: 4px 8px 4px 0; font-size: 11px; color: var(--vscode-descriptionForeground); background: rgba(0,0,0,0.2); user-select: none; box-sizing: border-box; }
			.diff-cell .line-content { flex: 1; padding: 4px 12px; white-space: pre-wrap; word-break: break-word; box-sizing: border-box; }
			/* 删除行 — VS Code diff editor 主题变量 */
			.diff-cell.removed { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1)); }
			.diff-cell.removed .line-gutter { background: var(--vscode-diffEditorGutter-removedLineBackground, rgba(255,0,0,0.05)); }
			.diff-cell.removed .line-content { color: var(--vscode-editor-foreground); }
			/* 新增行 */
			.diff-cell.added { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.1)); }
			.diff-cell.added .line-gutter { background: var(--vscode-diffEditorGutter-insertedLineBackground, rgba(0,255,0,0.05)); }
			.diff-cell.added .line-content { color: var(--vscode-editor-foreground); }
			/* 保留行 */
			.diff-cell.unchanged .line-content { color: var(--vscode-editor-foreground); }
			/* 占位行 — 斜线填充模拟 VS Code diff editor 空白侧 */
			.diff-cell.placeholder {
				background-color: var(--vscode-diffEditor-diagonalFill, rgba(128,128,128,0.05));
				background-image: repeating-linear-gradient(
					-45deg,
					transparent, transparent 4px,
					var(--vscode-diffEditor-diagonalFill, rgba(128,128,128,0.12)) 4px,
					var(--vscode-diffEditor-diagonalFill, rgba(128,128,128,0.12)) 8px
				);
			}
			.diff-cell.placeholder .line-content { color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; }
			/* 折叠行 */
			.diff-cell.folded { background: rgba(128,128,128,0.05); }
			.diff-cell.folded .line-gutter { background: rgba(0,0,0,0.2); }
			.diff-cell.folded .line-content { text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 2px 0; }
			/* 可折叠伸缩条 — 中间被压缩区域的展开/收起开关 */
			.diff-row.collapse-bar { cursor: pointer; transition: background 0.15s; }
			.diff-row.collapse-bar .diff-cell {
				background: rgba(128,128,128,0.08);
				border-top: 1px solid var(--vscode-widget-border);
				border-bottom: 1px solid var(--vscode-widget-border);
			}
			.diff-row.collapse-bar:hover .diff-cell { background: rgba(128,128,128,0.16); }
			.diff-row.collapse-bar .line-content {
				text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;
				padding: 8px 0; font-style: italic; flex: 1;
			}
			.diff-row.collapse-bar .line-gutter { background: rgba(0,0,0,0.25); }
			.diff-row.collapse-bar .collapse-icon { display: inline-block; margin-right: 4px; transition: transform 0.15s; }
			.diff-row.collapse-bar.expanded .collapse-icon { transform: rotate(90deg); }
		`;
		this._container.appendChild(style);
		this._renderContent(null);
	}

	override async setInput(input: CompressionDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._renderContent(input.data);
		// 监听数据变更：点击不同压缩条目时，singleton input 的 _data 更新但 setInput 不会再次调用，
		// 通过 onDidChangeData 事件触发重新渲染。
		this._dataChangeListener?.dispose();
		this._dataChangeListener = input.onDidChangeData(() => {
			this._renderContent(input.data);
		});
	}

	override clearInput(): void {
		this._dataChangeListener?.dispose();
		this._dataChangeListener = null;
		super.clearInput();
	}

	private _renderContent(data: ICompressionDetailData | null): void {
		if (!this._container) { return; }
		// 保留 style 元素，移除其他子元素
		const styleEl = this._container.querySelector('style');
		while (this._container.firstChild) {
			this._container.removeChild(this._container.firstChild);
		}
		if (styleEl) { this._container.appendChild(styleEl); }

		const title = append(this._container, $('.compression-detail-title'));
		title.textContent = '📦 上下文压缩详情';

		if (!data) {
			const empty = append(this._container, $('.compression-detail-empty'));
			empty.textContent = '暂无压缩数据';
			return;
		}

		const stats = append(this._container, $('.compression-detail-stats'));
		const items: Array<{ label: string; value: string; cls: string }> = [
			{ label: '原始消息数', value: String(data.originalCount), cls: 'stat-original' },
			{ label: '压缩后消息数', value: String(data.compressedCount), cls: 'stat-compressed' },
			{ label: '节省 Token', value: data.tokensSaved.toLocaleString(), cls: 'stat-saved' },
			{ label: '节省比例', value: `${data.savePercent ?? 0}%`, cls: 'stat-percent' },
			{ label: '压缩耗时', value: `${(data.durationMs / 1000).toFixed(2)}s`, cls: 'stat-duration' },
		];
		for (const item of items) {
			const card = append(stats, $(`.compression-stat-card.${item.cls}`));
			const labelEl = append(card, $('.stat-label'));
			labelEl.textContent = item.label;
			const valueEl = append(card, $('.stat-value'));
			valueEl.textContent = item.value;
		}

		// 摘要内容
		if (data.summary) {
			const summarySection = append(this._container, $('.compression-detail-summary'));
			const summaryTitle = append(summarySection, $('.compare-title'));
			summaryTitle.textContent = '压缩摘要';
			const summaryBox = append(summarySection, $('.compression-summary-box'));
			summaryBox.textContent = data.summary;
		}

		// 前后文本对比（Split Diff 双面板，类似 VS Code diff editor）
		const compare = append(this._container, $('.compression-detail-compare'));
		const compareTitle = append(compare, $('.compare-title'));
		compareTitle.textContent = '压缩前后文本对比';

		const beforeText = data.beforeText || '';
		const afterText = data.afterText || '';
		const diff = this._computeStructuredDiff(beforeText, afterText);

		// diff 统计条
		const removedCount = diff.beforeMiddle.length;
		const addedCount = diff.afterMiddle.length;
		const unchangedCount = diff.prefix.length + diff.suffix.length;
		const diffToolbar = append(compare, $('.diff-toolbar'));
		const statUnchanged = append(diffToolbar, $('.diff-stat.unchanged'));
		append(statUnchanged, $('.dot'));
		append(statUnchanged, $('span')).textContent = ' 保留 ' + unchangedCount + ' 段';
		const statRemoved = append(diffToolbar, $('.diff-stat.removed'));
		append(statRemoved, $('.dot'));
		append(statRemoved, $('span')).textContent = ' 删除 ' + removedCount + ' 段';
		const statAdded = append(diffToolbar, $('.diff-stat.added'));
		append(statAdded, $('.dot'));
		append(statAdded, $('span')).textContent = ' 新增 ' + addedCount + ' 段';

		// Split Diff 容器
		const splitDiff = append(compare, $('.split-diff'));
		const headers = append(splitDiff, $('.split-diff-headers'));
		const leftHeader = append(headers, $('.split-diff-header.left'));
		leftHeader.textContent = '压缩前 ';
		const leftCount = append(leftHeader, $('.header-count'));
		leftCount.textContent = data.originalCount + ' 条';
		const rightHeader = append(headers, $('.split-diff-header.right'));
		rightHeader.textContent = '压缩后 ';
		const rightCount = append(rightHeader, $('.header-count'));
		rightCount.textContent = data.compressedCount + ' 条';

		const body = append(splitDiff, $('.split-diff-body'));
		let leftLineNum = 0;
		let rightLineNum = 0;

		// 1. 渲染公共前缀（unchanged，左右内容完全一致，天然对齐）
		for (const block of diff.prefix) {
			leftLineNum++; rightLineNum++;
			this._renderDiffRow(body, 'unchanged', block, leftLineNum, 'unchanged', block, rightLineNum);
		}

		// 2. 渲染可折叠的中间压缩区域
		if (diff.beforeMiddle.length > 0 || diff.afterMiddle.length > 0) {
			// 折叠伸缩条（可点击展开/收起）
			const collapseRow = append(body, $('.diff-row.collapse-bar'));
			const collapseLeft = append(collapseRow, $('.diff-cell.left'));
			append(collapseLeft, $('.line-gutter'));
			const collapseLeftContent = append(collapseLeft, $('.line-content'));
			const collapseRight = append(collapseRow, $('.diff-cell.right'));
			append(collapseRight, $('.line-gutter'));
			const collapseRightContent = append(collapseRight, $('.line-content'));

			const updateCollapseText = (expanded: boolean) => {
				const leftIcon = expanded ? '▼' : '▶';
				const rightIcon = expanded ? '▼' : '▶';
				collapseLeftContent.textContent = '';
				const li = append(collapseLeftContent, $('span.collapse-icon'));
				li.textContent = leftIcon;
				append(collapseLeftContent, $('span')).textContent = ' ' + diff.beforeMiddle.length + ' 条被压缩消息' + (expanded ? '（点击收起）' : '（点击展开）');
				collapseRightContent.textContent = '';
				const ri = append(collapseRightContent, $('span.collapse-icon'));
				ri.textContent = rightIcon;
				append(collapseRightContent, $('span')).textContent = ' ' + diff.afterMiddle.length + ' 条摘要消息' + (expanded ? '（点击收起）' : '（点击展开）');
			};
			updateCollapseText(false);

			// 中间区域的详细 diff 行（初始隐藏）
			const middleRows: HTMLElement[] = [];
			// 先渲染 beforeMiddle（removed：左有内容，右占位）
			for (const block of diff.beforeMiddle) {
				leftLineNum++;
				const row = this._renderDiffRow(body, 'removed', block, leftLineNum, 'placeholder', '（已压缩删除）', 0);
				row.style.display = 'none';
				middleRows.push(row);
			}
			// 再渲染 afterMiddle（added：左占位，右有内容）
			for (const block of diff.afterMiddle) {
				rightLineNum++;
				const row = this._renderDiffRow(body, 'placeholder', '（新增摘要）', 0, 'added', block, rightLineNum);
				row.style.display = 'none';
				middleRows.push(row);
			}

			collapseRow.addEventListener('click', () => {
				const expanded = collapseRow.classList.toggle('expanded');
				for (const row of middleRows) {
					row.style.display = expanded ? '' : 'none';
				}
				updateCollapseText(expanded);
			});
		}

		// 3. 渲染公共后缀（unchanged，左右内容完全一致，天然对齐）
		for (const block of diff.suffix) {
			leftLineNum++; rightLineNum++;
			this._renderDiffRow(body, 'unchanged', block, leftLineNum, 'unchanged', block, rightLineNum);
		}
	}

	/** 渲染一行 diff-row（包含左右两个 cell，行高自动取最大值对齐）。返回创建的 row 元素。 */
	private _renderDiffRow(
		body: HTMLElement,
		leftCls: string, leftText: string, leftLineNum: number,
		rightCls: string, rightText: string, rightLineNum: number,
	): HTMLElement {
		const row = append(body, $('.diff-row'));
		// 左 cell
		const leftCell = append(row, $('.diff-cell.left.' + leftCls));
		const leftGutter = append(leftCell, $('.line-gutter'));
		leftGutter.textContent = leftLineNum > 0 ? String(leftLineNum) : '';
		const leftContent = append(leftCell, $('.line-content'));
		leftContent.textContent = leftText || '(空)';
		// 右 cell
		const rightCell = append(row, $('.diff-cell.right.' + rightCls));
		const rightGutter = append(rightCell, $('.line-gutter'));
		rightGutter.textContent = rightLineNum > 0 ? String(rightLineNum) : '';
		const rightContent = append(rightCell, $('.line-content'));
		rightContent.textContent = rightText || '(空)';
		return row;
	}

	/**
	 * 结构化 diff：利用压缩算法"首尾不变、中间压缩"的特性，
	 * 直接匹配公共前缀和公共后缀，中间部分分别为 beforeMiddle（被删除）和 afterMiddle（新增摘要）。
	 * 比 LCS 更可靠：完全相同的文本块严格匹配，不会因回溯顺序导致错位。
	 */
	private _computeStructuredDiff(beforeText: string, afterText: string): {
		prefix: string[];
		beforeMiddle: string[];
		afterMiddle: string[];
		suffix: string[];
	} {
		const beforeBlocks = beforeText ? beforeText.split('\n\n').filter(b => b.length > 0) : [];
		const afterBlocks = afterText ? afterText.split('\n\n').filter(b => b.length > 0) : [];

		// 公共前缀：从头匹配完全相同的块
		let prefixLen = 0;
		const minLen = Math.min(beforeBlocks.length, afterBlocks.length);
		while (prefixLen < minLen && beforeBlocks[prefixLen] === afterBlocks[prefixLen]) {
			prefixLen++;
		}

		// 公共后缀：从尾部匹配（前缀之后的剩余部分）
		let suffixLen = 0;
		while (suffixLen < beforeBlocks.length - prefixLen
			&& suffixLen < afterBlocks.length - prefixLen
			&& beforeBlocks[beforeBlocks.length - 1 - suffixLen] === afterBlocks[afterBlocks.length - 1 - suffixLen]) {
			suffixLen++;
		}

		return {
			prefix: beforeBlocks.slice(0, prefixLen),
			beforeMiddle: beforeBlocks.slice(prefixLen, beforeBlocks.length - suffixLen),
			afterMiddle: afterBlocks.slice(prefixLen, afterBlocks.length - suffixLen),
			suffix: beforeBlocks.slice(beforeBlocks.length - suffixLen),
		};
	}

	override layout(dimension: { width: number; height: number }): void {
		// No special layout needed
	}
}
