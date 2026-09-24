/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/kbSettingsEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { $ } from '../../../../base/browser/dom.js';
import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEmbeddingService, IEmbeddingProviderInfo } from '../common/embeddingProvider.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { resolveAuxEmbeddingConfig } from './knowledge/embeddingConfigResolver.js';
import { formatSizeFull } from './views/knowledgeBase/kbViewUtils.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_KB_AGENTIC_BUILD,
	AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED,
	AGENT_STUDIO_KB_FEISHU_CLI_PATH,
	AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS,
	AGENT_STUDIO_KB_FEISHU_SYNC_PARENT,
	AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT,
	AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL,
	AGENT_STUDIO_KB_FEISHU_AUTO_SYNC,
	AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH,
	AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES,
	AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE,
} from '../common/constants.js';
import { KbSettingsEditorInput, IKbSettingsHost } from './kbSettingsEditorInput.js';
import {
	DEFAULT_LARK_CLI,
	FEISHU_SYNC_LOG_FILE,
	KB_FEISHU_SYNC_SCRIPT_REL,
	LARK_CLI_MISSING_HINT,
	buildUpgradeArgs,
	checkCliUpdate,
	detectLarkCli,
	hasUpdate,
	resolveSyncScript,
} from './knowledge/feishuSyncCore.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';

/**
 * KbSettingsEditorPane — 知识库设置面板（在中间栏打开的 EditorPane）。
 *
 * 取代原先挂在侧栏 ⚙ 按钮上的下拉面板：设置项已增至 5 组（目录 / 构建方式 /
 * Embedding / 飞书同步 / 状态），下拉受侧栏宽度限制显示拥挤、小窗口下还会被视口截断。
 * 本 Pane 以「分组卡片 + 宽行控件」布局呈现；配置项直接读写 IConfigurationService
 * （全局服务），需要视图上下文的动作（选目录 / 重建索引 / 触发同步）经
 * `IKbSettingsHost` 回调交回 KnowledgeBaseView 执行。
 */
export class KbSettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbSettingsPane';

	private _container: HTMLElement | undefined;
	private _host: IKbSettingsHost | undefined;
	/** 已同步篇数（-1 = 未统计） */
	private _syncedCount = -1;
	/** 最近一次检查到的 Release 页面地址（供「查看版本说明」按钮使用） */
	private _cliReleaseUrl: string | undefined;
	/** 飞书同步实时输出的订阅（面板重建/销毁时释放，避免重复订阅）。 */
	private _syncOutputSub: { dispose(): void } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IEmbeddingService private readonly embeddingService: IEmbeddingService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super(KbSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.kb-settings-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof KbSettingsEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}
		this._host = input.host;
		this._render();
		void this._refreshSyncedCount();
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	// ─── 渲染 ────────────────────────────────────────────────────────────────

	private _render(): void {
		const host = this._host;
		const c = this._container;
		if (!host || !c) { return; }
		c.replaceChildren();

		const scroll = $('div.kbs-scroll');
		c.appendChild(scroll);

		const rootPath = host.getRootPath();

		// ── 头部 ──
		const header = $('header.kbs-header');
		const h1 = $('h1.kbs-title'); h1.textContent = '知识库设置';
		const sub = $('p.kbs-sub');
		sub.textContent = '当前知识库：';
		const rootCode = $('code.kbs-root'); rootCode.textContent = rootPath;
		sub.appendChild(rootCode);
		const openBtn = $('button.kbs-btn'); openBtn.textContent = '📂 打开知识库文件夹';
		openBtn.onclick = () => host.openKbFolder();
		header.append(h1, sub, openBtn);
		scroll.appendChild(header);

		// ── 1. 知识库目录 ──
		const dirSec = this._section(scroll, '📁 知识库目录');
		const dirControl = this._row(dirSec, '目录');
		const pathInput = document.createElement('input');
		pathInput.type = 'text'; pathInput.className = 'kbs-input kbs-grow';
		pathInput.value = rootPath; pathInput.readOnly = true;
		pathInput.title = '所选目录即知识库（Vault）根目录，「库」「笔记」子文件夹直接建在此目录下';
		const browseBtn = $('button.kbs-btn'); browseBtn.textContent = '浏览…';
		// ★ 2026-09-23：选定后**回填输入框并重渲染**。
		// 此前 `pickDir` 是单向 void 调用（host 内部持久化后不回传），而面板唯一的重渲染
		// 入口是 `setInput()` —— 复用同一个设置 Tab 时 `KbSettingsEditorInput.matches()`
		// 恒为 true ⇒ `doSetInput` 提前返回 ⇒ 面板永不重渲染。
		// 结果就是用户看到的「选了目录，路径没变」（顶部「当前知识库」同样停在旧值）。
		browseBtn.onclick = async () => {
			const picked = await host.pickDir(pathInput.value);
			if (picked) { pathInput.value = picked; }
			this._render();
		};
		const manualBtn = $('button.kbs-btn'); manualBtn.textContent = '手动输入';
		manualBtn.onclick = () => {
			pathInput.readOnly = false;
			pathInput.focus();
			pathInput.select();
		};
		pathInput.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const v = pathInput.value.trim();
				if (v) {
					void host.applyDir(v).then(applied => {
						if (applied) { pathInput.value = applied; }
						this._render();
					});
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._render();
			}
		};
		dirControl.append(pathInput, browseBtn, manualBtn);
		this._hint(dirSec, '点击「浏览…」选择文件夹，或「手动输入」后按回车应用。所选目录**即知识库根目录**：'
			+ '已有「库」「笔记」子文件夹与笔记 ⇒ 直接加载；没有 ⇒ 自动创建。');

		// ── 2. 构建方式 ──
		const buildSec = this._section(scroll, '⚙️ 构建方式');
		const buildControl = this._row(buildSec, 'Agentic 构建');
		const buildCheck = this._check(
			buildControl,
			'知识库专家 Agent（技能注入 + 工具能力，质量更高但更慢）',
			this.configurationService.getValue<boolean>(AGENT_STUDIO_KB_AGENTIC_BUILD) !== false,
			(v) => {
				this.configurationService.updateValue(AGENT_STUDIO_KB_AGENTIC_BUILD, v);
				host.logOp('settings.kb.agenticBuild', { target: v ? 'on' : 'off' });
			},
		);
		buildCheck.title = '关闭后走纯直连 LLM 管线（更快更省，无工具能力）';
		this._hint(buildSec, '开启时「构建笔记」交给 knowledge-base-expert Agent；失败或 agent 无产出会自动回退直连管线');

		// ── 3. Embedding 模型 ──
		const embSec = this._section(scroll, '🧬 Embedding 模型');
		const embCfg = resolveAuxEmbeddingConfig(this.configurationService);

		const providerControl = this._row(embSec, 'Provider');
		const providerSelect = document.createElement('select');
		providerSelect.className = 'kbs-select';
		const autoOpt = document.createElement('option');
		autoOpt.value = 'auto'; autoOpt.textContent = 'Auto（跟随全局设置）';
		if (embCfg.providerId === 'auto') { autoOpt.selected = true; }
		providerSelect.appendChild(autoOpt);
		const providers: readonly IEmbeddingProviderInfo[] = this.embeddingService.listProviders();
		for (const p of providers.filter(x => x.configured)) {
			const o = document.createElement('option');
			o.value = p.id;
			o.textContent = `${p.kind === 'openai' ? 'OpenAI' : 'Local'} / ${p.model} (${p.dimensions}d)`;
			if (p.id === embCfg.providerId) { o.selected = true; }
			providerSelect.appendChild(o);
		}
		if (embCfg.providerId && embCfg.providerId !== 'auto' && !providers.some(p => p.id === embCfg.providerId)) {
			const o = document.createElement('option');
			o.value = embCfg.providerId;
			o.textContent = `${embCfg.providerId}（未配置）`;
			o.selected = true;
			providerSelect.appendChild(o);
		}
		providerSelect.onchange = () => {
			this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, providerSelect.value);
			host.logOp('settings.embedding.provider', { target: providerSelect.value });
		};
		providerControl.appendChild(providerSelect);

		const modelControl = this._row(embSec, 'Model');
		const modelInput = document.createElement('input');
		modelInput.type = 'text'; modelInput.className = 'kbs-input kbs-grow';
		modelInput.value = embCfg.modelId;
		modelInput.placeholder = 'text-embedding-3-small';
		modelInput.onchange = () => {
			const v = modelInput.value.trim();
			if (!v) { return; }
			this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_MODEL, v);
			host.logOp('settings.embedding.model', { target: v });
		};
		modelControl.appendChild(modelInput);

		const dimControl = this._row(embSec, 'Dimensions');
		const dimInput = document.createElement('input');
		dimInput.type = 'number'; dimInput.className = 'kbs-input kbs-num';
		dimInput.value = String(embCfg.dimensions);
		dimInput.min = '1'; dimInput.max = '8192'; dimInput.step = '64';
		dimInput.onchange = () => {
			const v = parseInt(dimInput.value, 10);
			if (Number.isFinite(v) && v > 0) {
				this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, v);
				host.logOp('settings.embedding.dimensions', { target: String(v) });
			}
		};
		dimControl.appendChild(dimInput);
		this._hint(embSec, '向量维度（默认 512，范围 1-8192）；切换 Provider 或修改维度后需重建向量索引');

		const rebuildRow = $('div.kbs-row');
		const rebuildBtn = $('button.kbs-btn.kbs-primary'); rebuildBtn.textContent = '🔄 重新构建向量索引';
		rebuildBtn.onclick = () => host.rebuildVectorIndex();
		rebuildRow.appendChild(rebuildBtn);
		embSec.appendChild(rebuildRow);

		// ── 4. 飞书同步 ──
		const fsSec = this._section(scroll, '📤 飞书同步');
		// ★ 2026-09-23：留引用 + 打标，供 `_scrollToRequestedSection()` 定位
		//（视图「同步飞书」发现未配置时会跳到这里）
		this._feishuSection = fsSec;
		fsSec.dataset.kbsSection = 'feishu';

		const fsEnableControl = this._row(fsSec, '启用');
		this._check(
			fsEnableControl,
			'启用飞书同步',
			this.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED) === true,
			(v) => {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED, v);
				host.logOp('settings.kb.feishu.enabled', { target: v ? 'on' : 'off' });
			},
		);

		const fsAutoControl = this._row(fsSec, '定时同步');
		this._check(
			fsAutoControl,
			'允许定时自动同步（与总开关是「与」关系）',
			this.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_AUTO_SYNC) === true,
			(v) => {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_AUTO_SYNC, v);
				host.logOp('settings.kb.feishu.autoSync', { target: v ? 'on' : 'off' });
			},
		);

		// 运行环境：飞书 CLI（lark-cli）检测 + 可执行路径
		// 注：同步脚本已内置随产品发布（resources/.agents/kb/feishu-sync.mjs），无需用户配置
		const cliControl = this._row(fsSec, '飞书 CLI');
		const cliInput = document.createElement('input');
		cliInput.type = 'text'; cliInput.className = 'kbs-input kbs-grow';
		cliInput.value = this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI;
		cliInput.placeholder = DEFAULT_LARK_CLI;
		cliInput.title = 'lark-cli 可执行名或完整路径（默认从系统 PATH 查找）';
		cliInput.onchange = () => {
			const v = cliInput.value.trim() || DEFAULT_LARK_CLI;
			this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_CLI_PATH, v);
			host.logOp('settings.kb.feishu.cliPath', { target: v });
			void this._refreshCliStatus();
		};
		const recheckBtn = $('button.kbs-btn'); recheckBtn.textContent = '🔄 重新检测';
		recheckBtn.onclick = () => void this._refreshCliStatus();
		cliControl.append(cliInput, recheckBtn);

		const cliStatus = $('p.kbs-hint');
		cliStatus.id = 'kbsCliStatus';
		cliStatus.textContent = '正在检测飞书 CLI…';
		fsSec.appendChild(cliStatus);

		const scriptStatus = $('p.kbs-hint');
		scriptStatus.id = 'kbsScriptStatus';
		scriptStatus.textContent = `内置同步脚本：${KB_FEISHU_SYNC_SCRIPT_REL}（随产品发布，无需配置）`;
		fsSec.appendChild(scriptStatus);

		// 升级行：检测到新版本时才显示（按钮可见性由 _refreshCliStatus 控制）
		const updateRow = $('div.kbs-row');
		const upgradeBtn = $('button.kbs-btn.kbs-primary');
		upgradeBtn.id = 'kbsCliUpgrade';
		upgradeBtn.textContent = '⬆️ 升级 lark-cli';
		upgradeBtn.title = '在集成终端执行 lark-cli update（可见进度，结束后保留输出）';
		upgradeBtn.style.display = 'none';
		upgradeBtn.onclick = () => void this._upgradeCli();
		const releaseBtn = $('button.kbs-btn');
		releaseBtn.id = 'kbsCliRelease';
		releaseBtn.textContent = '📄 查看版本说明';
		releaseBtn.style.display = 'none';
		releaseBtn.onclick = () => {
			const url = this._cliReleaseUrl;
			if (url) { void this.openerService.open(URI.parse(url), { openExternal: true }); }
		};
		updateRow.append(upgradeBtn, releaseBtn);
		fsSec.appendChild(updateRow);

		const updateHint = $('p.kbs-hint');
		updateHint.id = 'kbsCliUpdate';
		fsSec.appendChild(updateHint);

		const srcControl = this._row(fsSec, '同步范围');
		const srcInput = document.createElement('input');
		srcInput.type = 'text'; srcInput.className = 'kbs-input kbs-grow';
		srcInput.value = this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS) ?? '';
		// ★ 2026-09-23：把「留空」的含义写清楚 —— 现在它真的会同步「库」+「笔记」两个分区
		// （此前留空会传空 src ⇒ 计划为空 ⇒ 终端只打印「完成 0 篇」）。
		srcInput.placeholder = '留空 = 库 + 笔记（整个知识库）';
		srcInput.title = '库内相对目录，多个用逗号分隔；留空 = 同步「库」与「笔记」两个分区';
		srcInput.onchange = () => {
			const v = srcInput.value.trim();
			this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS, v);
			host.logOp('settings.kb.feishu.srcDirs', { target: v || '<whole-vault>' });
		};
		srcControl.appendChild(srcInput);

		// 「同步到」= 新建文档在飞书侧的落点（复用脚本 --parent 语义）：
		//   my_library → `--wiki-space my_library`（飞书「个人知识库」）
		//   其它值     → `--folder-token <token>`（飞书云空间指定文件夹）
		// ⚠ 仅作用于**新建**文档；已同步文档走 `docs +update --doc`，位置不变。
		const parentControl = this._row(fsSec, '同步到');
		const parentInput = document.createElement('input');
		parentInput.type = 'text'; parentInput.className = 'kbs-input kbs-grow';
		parentInput.value = this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_PARENT) || 'my_library';
		parentInput.placeholder = 'my_library（飞书个人知识库）';
		parentInput.title = 'my_library = 飞书「个人知识库」（默认）；也可填飞书云空间文件夹 token，新建文档会落到该文件夹下';
		parentInput.onchange = () => {
			const v = parentInput.value.trim() || 'my_library';
			this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_SYNC_PARENT, v);
			host.logOp('settings.kb.feishu.parent', { target: v });
		};
		parentControl.appendChild(parentInput);
		this._hint(fsSec, '「同步到」决定新建文档在飞书的位置：my_library = 个人知识库（默认），或填云空间文件夹 token。仅影响新建文档，已同步的仍按原位置更新。');

		// ── 多类别 → 多知识库 ──
		const depthControl = this._row(fsSec, '类别层级');
		const depthInput = document.createElement('input');
		depthInput.type = 'number'; depthInput.className = 'kbs-input kbs-num';
		const rawDepth = this.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH);
		depthInput.value = String(Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : 1);
		depthInput.min = '0'; depthInput.max = '5'; depthInput.step = '1';
		depthInput.title = '同步源目录下第几级目录作为一个「类别」（每个类别对应一个飞书知识库）；0 = 不分类别';
		depthInput.onchange = () => {
			const v = parseInt(depthInput.value, 10);
			if (Number.isFinite(v) && v >= 0) {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH, v);
				host.logOp('settings.kb.feishu.categoryDepth', { target: String(v) });
				void this._refreshCliStatus();
			}
		};
		depthControl.appendChild(depthInput);
		this._hint(fsSec, '每个「类别」= 同步源目录下的第 N 级目录，各自对应一个飞书知识库；类别变化时其文档会自动跨知识库搬迁（wiki move）。0 = 不分类别。');

		// ── 目录 ↔ 知识库映射（**用户显式配置**，优先于上面的「类别层级」自动推导）──
		// 落盘在 vault 内 `.feishu-space-map.json`（与内置脚本同一契约）⇒ 无需经 CLI 参数传递（避免引号转义问题）。
		const mapRow = this._row(fsSec, '目录映射');
		const addMapBtn = $('button.kbs-btn');
		addMapBtn.textContent = '＋ 添加目录';
		addMapBtn.title = '选择知识库内的一个目录，为它显式指定飞书知识库（该目录的子目录一并绑定）';
		const reloadMapBtn = $('button.kbs-btn');
		reloadMapBtn.textContent = '🔄 刷新知识库列表';
		reloadMapBtn.title = '重新拉取飞书知识库列表（lark-cli wiki +space-list）';
		mapRow.append(addMapBtn, reloadMapBtn);

		const mapList = $('div.kbs-map-list');
		fsSec.appendChild(mapList);
		const mapStatus = $('p.kbs-hint');
		mapStatus.id = 'kbsSpaceMapStatus';
		fsSec.appendChild(mapStatus);
		this._hint(fsSec, '显式映射**优先于**「类别层级」：映射目录（含其子目录）下的笔记会同步到你指定的飞书知识库；未映射的目录仍按类别层级自动推导（必要时自动建库）。');

		/** 可选的知识库列表（惰性拉取一次；「刷新知识库列表」可重拉）。 */
		let spaceOptions: Array<{ spaceId: string; name: string }> = [];
		/** 下拉里的「＋ 新建飞书知识库…」哨兵值（不与真实 spaceId 冲突）。 */
		const NEW_SPACE_OPTION = '__kb_new_space__';
		const renderMapList = async (reloadSpaces = false): Promise<void> => {
			if (reloadSpaces || spaceOptions.length === 0) {
				spaceOptions = await host.listSpaces();
			}
			const mappings = await host.loadSpaceMap();
			mapList.replaceChildren();
			mapStatus.textContent = spaceOptions.length > 0
				? `已获取 ${spaceOptions.length} 个飞书知识库`
				: '未获取到飞书知识库列表（确认 lark-cli 已安装并登录，再点「刷新知识库列表」）';
			if (mappings.length === 0) {
				const empty = $('p.kbs-hint');
				empty.textContent = '（未配置显式映射 —— 全部按类别层级自动推导）';
				mapList.appendChild(empty);
				return;
			}
			for (const m of mappings) {
				const row = $('div.kbs-row');
				const dirEl = $('span.kbs-grow');
				dirEl.textContent = m.dir;
				dirEl.title = m.dir;
				dirEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:12px;';
				const sel = document.createElement('select');
				sel.className = 'kbs-input';
				sel.title = '该目录对应的飞书知识库（也可选「＋ 新建飞书知识库…」直接创建）';
				// 下拉即入口：选中「＋ 新建飞书知识库…」⇒ 弹输入框 ⇒ `wiki +space-create` ⇒ 自动选中新库
				const newOpt = document.createElement('option');
				newOpt.value = NEW_SPACE_OPTION;
				newOpt.textContent = '＋ 新建飞书知识库…';
				sel.appendChild(newOpt);
				if (!spaceOptions.some(o => o.spaceId === m.spaceId)) {
					const opt = document.createElement('option');
					opt.value = m.spaceId;
					opt.textContent = `${m.spaceName || m.spaceId}（已配置，不在当前列表）`;
					sel.appendChild(opt);
				}
				for (const o of spaceOptions) {
					const opt = document.createElement('option');
					opt.value = o.spaceId;
					opt.textContent = o.name;
					sel.appendChild(opt);
				}
				sel.value = m.spaceId;
				sel.onchange = () => {
					void (async () => {
						if (sel.value === NEW_SPACE_OPTION) {
							const name = await host.promptSpaceName();
							if (!name) { sel.value = m.spaceId; return; }
							mapStatus.textContent = `正在新建飞书知识库「${name}」…`;
							const created = await host.createSpace(name);
							if (!created) {
								mapStatus.textContent = '新建飞书知识库失败：请确认 lark-cli 已安装并登录，然后点「刷新知识库列表」重试。';
								sel.value = m.spaceId;
								return;
							}
							const cur = await host.loadSpaceMap();
							await host.saveSpaceMap(cur.map(x => x.dir === m.dir
								? { dir: x.dir, spaceId: created.spaceId, spaceName: created.name }
								: x));
							host.logOp('settings.kb.feishu.spaceCreate', { target: `${created.name} (${created.spaceId})` });
							spaceOptions = await host.listSpaces();
							await renderMapList();
							return;
						}
						const picked = spaceOptions.find(o => o.spaceId === sel.value);
						const list = await host.loadSpaceMap();
						await host.saveSpaceMap(list.map(x => x.dir === m.dir
							? { dir: x.dir, spaceId: sel.value, spaceName: picked?.name ?? x.spaceName ?? '' }
							: x));
						host.logOp('settings.kb.feishu.spaceMap', { target: `${m.dir} → ${sel.value}` });
						await renderMapList();
					})();
				};
				const delBtn = $('button.kbs-btn');
				delBtn.textContent = '🗑';
				delBtn.title = '删除该映射（删除后该目录回到「类别层级」自动推导）';
				delBtn.onclick = () => {
					void (async () => {
						const list = await host.loadSpaceMap();
						await host.saveSpaceMap(list.filter(x => x.dir !== m.dir));
						host.logOp('settings.kb.feishu.spaceMap', { target: `remove ${m.dir}` });
						await renderMapList();
					})();
				};
				row.append(dirEl, sel, delBtn);
				mapList.appendChild(row);
			}
		};
		addMapBtn.onclick = () => {
			void (async () => {
				const dir = await host.pickDirForMapping();
				if (!dir) { return; }
				const list = await host.loadSpaceMap();
				if (list.some(x => x.dir === dir)) {
					mapStatus.textContent = `该目录已在映射中：${dir}`;
					return;
				}
				if (spaceOptions.length === 0) { spaceOptions = await host.listSpaces(); }
				const first = spaceOptions[0];
				if (!first) {
					mapStatus.textContent = '未能获取飞书知识库列表：请确认 lark-cli 已安装并登录，再点「刷新知识库列表」。';
					return;
				}
				await host.saveSpaceMap([...list, { dir, spaceId: first.spaceId, spaceName: first.name }]);
				host.logOp('settings.kb.feishu.spaceMap', { target: `${dir} → ${first.name}` });
				await renderMapList();
			})();
		};
		reloadMapBtn.onclick = () => { void renderMapList(true); };
		void renderMapList();

		const autoCreateControl = this._row(fsSec, '自动建库');
		this._check(
			autoCreateControl,
			'类别没有对应知识库时，自动创建同名知识库',
			this.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES) !== false,
			(v) => {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES, v);
				host.logOp('settings.kb.feishu.autoCreateSpaces', { target: v ? 'on' : 'off' });
			},
		);

		const pruneControl = this._row(fsSec, '删除清理');
		this._check(
			pruneControl,
			'本地删除的文档，同时移除远端节点（危险）',
			this.configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE) === true,
			(v) => {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE, v);
				host.logOp('settings.kb.feishu.pruneRemote', { target: v ? 'on' : 'off' });
			},
		);
		this._hint(fsSec, '「删除清理」默认关闭：本地删除不会影响飞书侧（远端保留）。开启后，本地已删除且曾同步过的文档会连带移除其远端节点。');

		const conflictControl = this._row(fsSec, '远端手改时');
		const conflictSelect = document.createElement('select');
		conflictSelect.className = 'kbs-select';
		const currentConflict = this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT) === 'skip' ? 'skip' : 'overwrite';
		for (const [value, text] of [['overwrite', '本地覆盖'], ['skip', '跳过并记录冲突']] as const) {
			const o = document.createElement('option');
			o.value = value; o.textContent = text;
			if (currentConflict === value) { o.selected = true; }
			conflictSelect.appendChild(o);
		}
		conflictSelect.onchange = () => {
			const v = conflictSelect.value === 'skip' ? 'skip' : 'overwrite';
			this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT, v);
			host.logOp('settings.kb.feishu.onConflict', { target: v });
		};
		conflictControl.appendChild(conflictSelect);

		const intervalControl = this._row(fsSec, '间隔 (ms)');
		const intervalInput = document.createElement('input');
		intervalInput.type = 'number'; intervalInput.className = 'kbs-input kbs-num';
		const rawInterval = this.configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL);
		intervalInput.value = String(Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 800);
		intervalInput.min = '0'; intervalInput.max = '10000'; intervalInput.step = '100';
		intervalInput.title = '每篇之间的间隔毫秒数（限流保护）';
		intervalInput.onchange = () => {
			const v = parseInt(intervalInput.value, 10);
			if (Number.isFinite(v) && v >= 0) {
				this.configurationService.updateValue(AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL, v);
				host.logOp('settings.kb.feishu.interval', { target: String(v) });
			}
		};
		intervalControl.appendChild(intervalInput);

		const fsHint = $('p.kbs-hint');
		fsHint.id = 'kbsFeishuSyncedCount';
		fsHint.textContent = this._syncedCount >= 0
			? `已同步 ${this._syncedCount} 篇（按笔记 frontmatter 的 feishu.token 统计）`
			: '同步前需完成 lark-cli 登录；首次建议先「预览同步计划」确认范围';
		fsSec.appendChild(fsHint);

		const fsBtnRow = $('div.kbs-row');
		const previewBtn = $('button.kbs-btn'); previewBtn.textContent = '🔍 预览同步计划（dry-run）';
		previewBtn.onclick = () => host.feishuSync('dry-run');
		const applyBtn = $('button.kbs-btn.kbs-primary'); applyBtn.textContent = '📤 立即同步到飞书';
		applyBtn.onclick = () => host.feishuSync('apply');
		const logBtn = $('button.kbs-btn'); logBtn.textContent = '📄 查看同步日志';
		logBtn.onclick = () => host.openFile(URI.joinPath(URI.file(rootPath), FEISHU_SYNC_LOG_FILE));
		fsBtnRow.append(previewBtn, applyBtn, logBtn);
		fsSec.appendChild(fsBtnRow);

		// ── 实时输出（2026-09-23）────────────────────────────────────────────────
		// 需求：同步信息要在**面板下方实时显示**，而不是让用户切到终端去找。
		// 做法：视图侧把终端 onData 镜像过来（含累计缓存），这里增量追加到一个 <pre>。
		// ⚠ 增量追加而非整面板重渲染：同步每秒可能多行，重渲染会打断滚动位置与输入焦点。
		const outWrap = $('div.kbs-sync-out');
		const outHead = $('div.kbs-sync-out-head');
		const outState = $('span.kbs-sync-state'); outState.textContent = '等待同步';
		const outClear = $('button.kbs-btn'); outClear.textContent = '清空';
		outHead.append(outState, outClear);
		const outPre = document.createElement('pre');
		outPre.className = 'kbs-sync-out-pre';
		outPre.style.cssText = [
			'max-height:240px', 'overflow:auto', 'margin:6px 0 0', 'padding:8px',
			'border-radius:6px', 'font-family:var(--vscode-editor-font-family,monospace)',
			'font-size:12px', 'line-height:1.45', 'white-space:pre-wrap', 'word-break:break-all',
			'background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.1))',
		].join(';');
		const initialOut = host.getSyncOutput();
		outPre.textContent = initialOut || '（尚未运行同步。点击上方按钮后，这里会实时显示进度与报错）';
		if (!initialOut) { outPre.dataset.placeholder = '1'; }
		outWrap.append(outHead, outPre);
		fsSec.appendChild(outWrap);

		// ⚠ 该编译目标下 setTimeout 返回 Node 的 `Timeout`（不是 number）⇒ 用 ReturnType 推断
		let refreshHandle: ReturnType<typeof setTimeout> | undefined;
		const appendOut = (chunk: string): void => {
			if (outPre.dataset.placeholder === '1') { outPre.textContent = ''; delete outPre.dataset.placeholder; }
			outPre.textContent = ((outPre.textContent ?? '') + chunk).slice(-40000);
			outPre.scrollTop = outPre.scrollHeight;
			// 脚本收尾会打印「完成 N 篇…」⇒ 据此把状态切回「已完成」（tail 判断，避免分行导致的漏匹配）
			const tail = (outPre.textContent ?? '').slice(-400);
			outState.textContent = /完成\s*\d+\s*篇/.test(tail) ? '已完成' : '同步运行中…';
			// 输出到达 ⇒ 稍后刷新「已同步 N 篇」（不每次输出都扫盘）
			if (refreshHandle !== undefined) { clearTimeout(refreshHandle); }
			refreshHandle = setTimeout(() => { refreshHandle = undefined; void this._refreshSyncedCount(); }, 2500);
		};
		outClear.onclick = () => {
			outPre.textContent = '';
			outPre.dataset.placeholder = '1';
			outState.textContent = '等待同步';
		};
		this._syncOutputSub?.dispose();
		this._syncOutputSub = host.onSyncOutput(appendOut);

		// ★ 2026-09-23：说明「同步前会自动把图表渲成图片」——否则用户看到笔记被改写会困惑
		this._hint(fsSec, '同步前会自动把笔记里的 mermaid / drawio 代码块渲染为 PNG 图片并改写为图片引用'
			+ '（飞书不渲染图表源码，且不支持 SVG；失败时保留源码不丢内容）。');
		this._hint(fsSec, '定时计划：工作日上午 10:00（IDE 自动化任务 kb）· 需同时勾选「启用飞书同步」与「允许定时自动同步」才会自动执行；手动同步不受开关约束');

		// ── 5. 状态 ──
		const statSec = this._section(scroll, '📊 状态');
		const statRow = $('div.kbs-stats');
		const parts = [
			`📄 ${host.getDocCount()} 文档`,
			host.getTotalSize() > 0 ? `· ${formatSizeFull(host.getTotalSize())}` : '',
			host.isSqliteActive() ? '· 🗄️ SQLite FTS5' : '· 💾 内存索引',
			host.getLinkedWorkspaceCount() > 0 ? `· 🔧 ${host.getLinkedWorkspaceCount()} 工作区` : '',
		].filter(Boolean);
		statRow.textContent = host.hasActiveVault() ? parts.join(' ') : '当前没有已激活的知识库 Vault';
		statSec.appendChild(statRow);

		// 飞书 CLI 检测要执行外部命令（异步）：先渲染完，结果回来再局部更新文案
		void this._refreshCliStatus();

		// ★ 2026-09-23：若调用方要求定位某分组（如「同步飞书」发现未配置），渲染完再滚动过去
		this._scrollToRequestedSection();
	}

	/** 「📤 飞书同步」分组的 DOM 引用（`_render()` 里留存，供打开时定位滚动）。 */
	private _feishuSection?: HTMLElement;

	/**
	 * 按需滚动到指定分组（2026-09-23）。
	 *
	 * 场景：知识库视图的「同步飞书」按钮发现飞书未配置 ⇒ 打开本设置页并要求定位到「📤 飞书同步」，
	 * 让用户一进来就看到该开的开关，而不是自己在一屏设置里找。
	 * 实现要点：
	 *  · 用 `setTimeout(0)` 等一次布局 —— 刚 append 的元素还没有几何信息，立刻 `scrollIntoView` 会落空；
	 *  · 高亮用**内联样式**（不新增 CSS），1.8s 后自动还原，避免用户以为那是持久状态。
	 */
	private _scrollToRequestedSection(): void {
		// 鸭子类型读取：设置页输入带 `focusSection`（见 KbSettingsEditorInput）；
		// 用 `this.input` 而不是成员字段 ⇒ **复用同一个设置 Tab 时**（框架会重新 setInput）同样生效。
		const focus = (this.input as unknown as { focusSection?: string } | undefined)?.focusSection;
		if (!focus) { return; }
		// 用 `_render()` 里留下的元素引用（Pane 上没有 `this.element` 可查，改用字段最稳）
		const target = focus === 'feishu' ? this._feishuSection : undefined;
		if (!target) { return; }
		setTimeout(() => {
			try {
				target.scrollIntoView({ block: 'start' });
				const prevOutline = target.style.outline;
				const prevOffset = target.style.outlineOffset;
				target.style.outline = '2px solid var(--vscode-focusBorder, #4da3ff)';
				target.style.outlineOffset = '2px';
				setTimeout(() => {
					target.style.outline = prevOutline;
					target.style.outlineOffset = prevOffset;
				}, 1800);
			} catch { /* 定位失败不影响设置页正常使用 */ }
		}, 0);
	}

	/**
	 * 检测飞书 CLI（lark-cli）与内置同步脚本是否就位，并更新状态文案。
	 * - 未安装 ⇒ 明确提示 + 自定义路径引导（不静默失败）
	 * - 已安装 ⇒ 显示版本与登录态（登录态无法判定时不显示）
	 * - 执行通道不可用 ⇒ 如实说明为「无法检测」，不误报为未安装
	 */
	private async _refreshCliStatus(): Promise<void> {
		const statusEl = this._container?.querySelector('#kbsCliStatus') as HTMLElement | null;
		const scriptEl = this._container?.querySelector('#kbsScriptStatus') as HTMLElement | null;
		if (statusEl) { statusEl.textContent = '正在检测飞书 CLI…'; }

		const cliPath = this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI;
		const [cli, scriptUri] = await Promise.all([
			detectLarkCli(cliPath),
			resolveSyncScript(this.fileService, this.environmentService as INativeEnvironmentService),
		]);
		// 仅在确实装好 CLI 时才检查新版本（`update --check` 为只读；解析失败返回 undefined ⇒ 不误报）
		const update = cli.state === 'installed' ? await checkCliUpdate(cliPath) : undefined;

		if (statusEl) {
			if (cli.state === 'missing') {
				statusEl.textContent = `❌ ${LARK_CLI_MISSING_HINT}`;
			} else if (cli.state === 'unknown') {
				statusEl.textContent = `⚠️ 无法检测飞书 CLI：${cli.raw ?? '执行通道不可用'}`;
			} else {
				const v = cli.version ? ` v${cli.version}` : '';
				const login = cli.loggedIn === true
					? '· 已登录'
					: cli.loggedIn === false ? '· 未登录（请执行 lark-cli auth login）' : '';
				statusEl.textContent = `✅ 已检测到飞书 CLI${v}${login}`;
			}
		}
		if (scriptEl) {
			scriptEl.textContent = scriptUri
				? `内置同步脚本：已就位（${KB_FEISHU_SYNC_SCRIPT_REL}）`
				: `⚠️ 内置同步脚本未找到（${KB_FEISHU_SYNC_SCRIPT_REL}）——安装可能不完整，请重新安装应用`;
		}

		// 升级提示：仅在确实检测到新版本时展示升级按钮（无法判定时不误导用户）
		this._cliReleaseUrl = update?.releaseUrl;
		const updateEl = this._container?.querySelector('#kbsCliUpdate') as HTMLElement | null;
		const upgradeBtn = this._container?.querySelector('#kbsCliUpgrade') as HTMLElement | null;
		const releaseBtn = this._container?.querySelector('#kbsCliRelease') as HTMLElement | null;
		if (hasUpdate(update)) {
			const from = update?.currentVersion ?? cli.version ?? '';
			const to = update?.latestVersion ?? '';
			if (updateEl) {
				updateEl.textContent = `⬆️ 可升级：${from}${to ? ` → ${to}` : ''}${update?.message ? `（${update.message}）` : ''}`;
			}
			if (upgradeBtn) { upgradeBtn.style.display = ''; }
			if (releaseBtn) { releaseBtn.style.display = update?.releaseUrl ? '' : 'none'; }
		} else {
			if (updateEl) { updateEl.textContent = update ? '✅ 已是最新版本。' : ''; }
			if (upgradeBtn) { upgradeBtn.style.display = 'none'; }
			if (releaseBtn) { releaseBtn.style.display = 'none'; }
		}
	}

	/**
	 * 升级 lark-cli（在集成终端执行 `lark-cli update`）。
	 *
	 * 升级会下载安装包、耗时较长 ⇒ 走**终端**（进度可见、失败可读），而不是单次缓冲的短命令通道；
	 * CLI 会自动识别安装方式（npm 全局安装 ⇒ `npm i -g @larksuite/cli@<ver>`；手动安装 ⇒ 给出下载地址）。
	 * 结束后提示重新检测（版本号与登录态都可能变化）。
	 */
	private async _upgradeCli(): Promise<void> {
		const cliPath = (this.configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim();
		const exe = cliPath || DEFAULT_LARK_CLI;
		const updateEl = this._container?.querySelector('#kbsCliUpdate') as HTMLElement | null;
		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'lark-cli 升级',
					executable: exe,
					args: buildUpgradeArgs(),
					waitOnExit: true, // 结束后保留终端，便于查看安装结果
				},
			});
			this.terminalService.setActiveInstance(terminal);
			await this.terminalService.revealTerminal(terminal);
			if (updateEl) {
				updateEl.textContent = '⏳ 已在终端执行 lark-cli update；完成后点「🔄 重新检测」刷新版本与登录态。';
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (updateEl) { updateEl.textContent = `⚠️ 升级启动失败：${msg}`; }
		}
	}

	// ─── 小工具 ──────────────────────────────────────────────────────────────

	/** 新建分组卡片（标题已就位，内容由调用方继续 append 到返回值）。 */
	private _section(parent: HTMLElement, title: string): HTMLElement {
		const sec = $('section.kbs-section');
		const h2 = $('h2.kbs-section-title');
		h2.textContent = title;
		sec.appendChild(h2);
		parent.appendChild(sec);
		return sec;
	}

	/** 新建一行并返回「控件区」（label 已就位，调用方 append 具体控件）。 */
	private _row(parent: HTMLElement, label: string): HTMLElement {
		const row = $('div.kbs-row');
		const l = $('label.kbs-label');
		l.textContent = label;
		const control = $('div.kbs-control');
		row.append(l, control);
		parent.appendChild(row);
		return control;
	}

	private _hint(parent: HTMLElement, text: string): HTMLElement {
		const p = $('p.kbs-hint');
		p.textContent = text;
		parent.appendChild(p);
		return p;
	}

	private _check(parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
		const box = document.createElement('input');
		box.type = 'checkbox'; box.className = 'kbs-checkbox'; box.checked = checked;
		const text = document.createElement('span');
		text.className = 'kbs-check-label';
		text.textContent = label;
		box.onchange = () => onChange(box.checked);
		parent.append(box, text);
		return box;
	}

	// ─── 已同步篇数（异步统计，避免阻塞面板渲染） ──────────────────────────────

	private async _refreshSyncedCount(): Promise<void> {
		const host = this._host;
		if (!host || !host.hasActiveVault()) {
			this._syncedCount = -1;
			return;
		}
		let count = 0;
		const walk = async (dir: URI): Promise<void> => {
			let stat;
			try { stat = await this.fileService.resolve(dir); } catch { return; }
			for (const child of stat.children ?? []) {
				if (child.name.startsWith('.')) { continue; }
				if (child.isDirectory) { await walk(child.resource); continue; }
				if (!/\.(md|markdown)$/i.test(child.name)) { continue; }
				try {
					const text = (await this.fileService.readFile(child.resource)).value.toString();
					if (/^feishu:\s*$/m.test(text) && /^\s+token:\s*\S+/m.test(text)) { count++; }
				} catch { /* 读取失败跳过 */ }
			}
		};
		await walk(URI.file(host.getRootPath()));
		this._syncedCount = count;
		const el = this._container?.querySelector('#kbsFeishuSyncedCount') as HTMLElement | null;
		if (el) {
			el.textContent = `已同步 ${count} 篇（按笔记 frontmatter 的 feishu.token 统计）`;
		}
	}

	override dispose(): void {
		this._syncOutputSub?.dispose();
		this._syncOutputSub = undefined;
		this._host = undefined;
		this._container = undefined;
		super.dispose();
	}
}
