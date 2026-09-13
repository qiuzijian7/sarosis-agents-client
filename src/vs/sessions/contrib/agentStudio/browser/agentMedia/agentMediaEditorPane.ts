/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Agent Media Editor Pane
 *
 *  在中间栏编辑器独立展示聊天里的媒体（生成图 / 候选图 / 参考图）。
 *  2026-09-11 用户需求：聊天框显示的图片双击后在中间编辑器单独 pane 展示。
 *
 *  交互：适应窗口显示；滚轮缩放（0.1×–8×）；双击画面重置为适应窗口。
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import * as DOM from '../../../../../base/browser/dom.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { AgentMediaEditorInput } from './agentMediaEditorInput.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const STYLE_ID = 'agent-media-pane-styles';

/** 一次性注入样式（与 taskOverviewEditorPane / nativeChatEditorPane 同款做法）。 */
function injectStylesOnce(): void {
	if (document.getElementById(STYLE_ID)) { return; }
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.agent-media-pane { display: flex; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
/* 棋盘底纹：透明 PNG / GIF（抠像表情包）能看清透明区域，否则会误以为图是白的。 */
.agent-media-stage {
	position: relative; flex: 1 1 auto; min-width: 0; min-height: 0;
	display: flex; align-items: center; justify-content: center;
	overflow: hidden; cursor: zoom-in;
	background-image:
		linear-gradient(45deg, rgba(128,128,128,.16) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.16) 75%),
		linear-gradient(45deg, rgba(128,128,128,.16) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.16) 75%);
	background-size: 16px 16px;
	background-position: 0 0, 8px 8px;
}
/* ★ 用 width/height:100% + object-fit:contain，而**不是** max-width/max-height
   （2026-09-11 修「点放大后图片不显示」）：max-* 依赖**父级已有确定尺寸**，一旦 stage
   高度为 0（父链高度未定），图片会被压成 0 高 → 整片空白 ✗。
   width/height:100% 同样要求父级有尺寸，但它配合 layout() 里写入的**显式像素高度**
   （见 layout 注释）就不会出现「静默塌陷」，且天然把 72px 的表情包放大到适应窗口 ✓。 */
.agent-media-image, .agent-media-video {
	width: 100%; height: 100%; object-fit: contain;
	transition: transform .12s ease-out; transform-origin: center center;
}
.agent-media-audio-box {
	display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px;
}
.agent-media-audio-label { font-size: 13px; opacity: .85; }
.agent-media-audio { width: 420px; max-width: 80vw; }
.agent-media-error { padding: 16px; font-size: 12px; opacity: .8; word-break: break-all; }
/* 占位（setInput 成功即被清除）：既是「媒体预览」提示，也是「pane 是否真的被使用」的诊断信号。 */
.agent-media-placeholder { font-size: 12px; opacity: .45; }
`;
	document.head.appendChild(style);
}

export class AgentMediaEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.agentMediaPane';

	private _container: HTMLElement | undefined;
	private _stage: HTMLElement | undefined;
	private _media: HTMLElement | undefined;
	private _scale = 1;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(AgentMediaEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		injectStylesOnce();
		this._container = DOM.append(parent, DOM.$('.agent-media-pane'));
		this._container.style.width = '100%';
		this._container.style.height = '100%';

		this._stage = DOM.append(this._container, DOM.$('.agent-media-stage'));
		// ★ 占位文案（2026-09-11）：兼作**诊断信号** —— 若用户看到「媒体预览」占位一直不消失，
		//   说明 setInput 没跑到（pane 被复用到别的 input / 打开流程异常）；若占位消失但图仍
		//   空白，则是媒体加载问题。setInput 成功时会清掉它。
		DOM.append(this._stage, DOM.$('.agent-media-placeholder', undefined, '媒体预览'));
		this._logService.trace(`[AgentMediaPane] createEditor: parent=${parent.className || parent.tagName}`);

		// 滚轮缩放：媒体适应窗口时无滚动内容，故直接占用滚轮（passive:false 才能 preventDefault）。
		this._register(DOM.addDisposableListener(this._stage, DOM.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (!this._media) { return; }
			e.preventDefault();
			const next = this._scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
			this._applyScale(next);
		}, { passive: false }));

		// 双击画面重置为适应窗口。
		this._register(DOM.addDisposableListener(this._stage, DOM.EventType.DBLCLICK, () => {
			this._applyScale(1);
		}));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._logService.trace(`[AgentMediaPane] setInput: typeId=${input.typeId} isMedia=${input instanceof AgentMediaEditorInput} hasStage=${!!this._stage}`);
		if (token.isCancellationRequested || !(input instanceof AgentMediaEditorInput) || !this._stage) {
			return;
		}
		DOM.clearNode(this._stage);
		this._media = this._createMedia(input);
		this._applyScale(1);
		const el = this._media;
		this._logService.trace(
			`[AgentMediaPane] setInput: kind=${input.kind} srcLen=${input.src.length} mediaEl=${el?.tagName ?? 'NONE'}` +
			` stageRect=${this._stage.clientWidth}x${this._stage.clientHeight}`,
		);
	}

	/** 按 kind 建对应元素（audio 无「画面」，故单独加占位标题）。 */
	private _createMedia(input: AgentMediaEditorInput): HTMLElement | undefined {
		const src = input.src;
		if (!src) { return undefined; }

		if (input.kind === 'audio') {
			const box = DOM.append(this._stage!, DOM.$('.agent-media-audio-box'));
			DOM.append(box, DOM.$('.agent-media-audio-label', undefined, input.getName()));
			const audio = DOM.append(box, DOM.$('audio.agent-media-audio')) as HTMLAudioElement;
			audio.src = src;
			audio.controls = true;
			return box;
		}

		if (input.kind === 'video') {
			const video = DOM.append(this._stage!, DOM.$('video.agent-media-video')) as HTMLVideoElement;
			video.src = src;
			video.controls = true;
			video.loop = true;
			return video;
		}

		// image / unknown 一律按图片渲染（unknown 常见于画布未标注 kind 的快照）。
		const img = DOM.append(this._stage!, DOM.$('img.agent-media-image')) as HTMLImageElement;
		img.src = src;
		img.alt = input.getName();
		// 加载结果落日志（2026-09-11）：把「pixels 到底有没有渲染出来」变成可判定 ——
		//   load 后 natural=0x0 ⇒ 数据无法解码；display=0x0 ⇒ 仍是被压扁（布局问题）。
		this._register(DOM.addDisposableListener(img, 'load', () => {
			this._logService.info(
				`[AgentMediaPane] image loaded: natural=${img.naturalWidth}x${img.naturalHeight}`
				+ ` display=${img.clientWidth}x${img.clientHeight}`,
			);
			// ★★ 可见性诊断（2026-09-11）：日志已证明「图片解码成功 + 元素尺寸正常」，
			//   但用户仍看到空白 ⇒ 问题在**可见性**（被遮挡 / 祖先隐藏 / 未真正上屏）。
			//   延迟 50ms（等布局与可见性切换完成）后测量，并用 elementFromPoint 找出
			//   **图片中心点上真正位于最顶层的元素** —— 它就是「盖住图片」的元凶（或就是图片本身）。
			setTimeout(() => {
				try {
					if (!img.isConnected) { this._logService.warn('[AgentMediaPane] DIAG: img NOT in DOM'); return; }
					const r = img.getBoundingClientRect();
					const cs = getComputedStyle(img);
					const pane = this._container?.getBoundingClientRect();
					const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
					const ar = this._container?.parentElement?.getBoundingClientRect();
					this._logService.info(
						`[AgentMediaPane] DIAG img=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`
						+ ` opacity=${cs.opacity} visibility=${cs.visibility} display=${cs.display} objectFit=${cs.objectFit}`
						+ ` pane=${pane ? `${Math.round(pane.width)}x${Math.round(pane.height)}@${Math.round(pane.left)},${Math.round(pane.top)}` : 'NONE'}`
						+ ` instance=${ar ? `${Math.round(ar.width)}x${Math.round(ar.height)}@${Math.round(ar.left)},${Math.round(ar.top)}` : 'NONE'}`
						+ ` viewport=${window.innerWidth}x${window.innerHeight}`
						+ ` topAtCenter=${top ? `${top.tagName}.${String((top as HTMLElement).className).slice(0, 60)}` : 'NONE'}`,
					);
				} catch (err) {
					this._logService.warn('[AgentMediaPane] DIAG failed', err);
				}
			}, 50);
		}));
		// 图片加载失败（如本地路径在编辑器域不可读）时给出可读提示，避免只看到碎图。
		this._register(DOM.addDisposableListener(img, 'error', () => {
			this._logService.warn(`[AgentMediaPane] image load FAILED: srcLen=${src.length} prefix=${src.slice(0, 48)}`);
			img.replaceWith(DOM.$('.agent-media-error', undefined, `无法加载该媒体：${src.slice(0, 120)}`));
		}));
		return img;
	}

	private _applyScale(scale: number): void {
		this._scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
		if (this._media) {
			this._media.style.transform = this._scale === 1 ? '' : `scale(${this._scale})`;
		}
	}

	/**
	 * 尺寸完全交给 CSS（容器 `position:absolute; top/left:0; width/height:100%` 锚定在
	 * `.editor-container` 上）→ 自动跟随编辑器区尺寸，无需在 JS 里写像素 ✗✓。
	 *
	 * 历程（2026-09-11）：初版 `height:'100%'` 在父链下曾解析为 0（图片被压成 0 高 ✗）；
	 * 改成写显式像素后尺寸正常，但**位置**仍错（pane 被排在可视区下方 ✗）——
	 * 最终由 createEditor 的绝对定位解决。这里只留日志。
	 */
	override layout(dimension: DOM.Dimension): void {
		this._logService.trace(`[AgentMediaPane] layout: ${dimension.width}x${dimension.height}`);
	}

	// ★★ 刻意**不覆写** `getContainer()`（2026-09-11 修「上方空白」+「图片不在视口内」）：
	//   基类 `Composite.getContainer()` 返回 `create(parent)` 收到的 `.editor-instance`，
	//   而 `doShowEditorPane` 会执行 `editorPanesParent.appendChild(getContainer())` ——
	//   即**工作台把 getContainer() 当作「本 pane 的实例元素」来挂载/显隐**。
	//   一旦覆写成返回内层容器：① 内层容器被**搬出** `.editor-instance`，留下一个空的、
	//   `height:100%`、**永不隐藏**的实例 → 同组其它编辑器上方出现**空白** ✗；
	//   ② 内层容器成为流式子节点 → 被排到已有实例**下方**（实测 top=1391）✗。
	//   保持基类语义即可：容器留在实例内，随实例一起显隐 ✓。
}
