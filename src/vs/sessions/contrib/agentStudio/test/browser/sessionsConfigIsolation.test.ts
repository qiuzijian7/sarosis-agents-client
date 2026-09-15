/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 方案 C「分层接管」的源码级不变量：**agents 窗口不读工作区 `.vscode/`**。
 *
 * 该目录在**工作区内、模型可写**。读它等于让「被约束者改写约束」——仓库里（或被注入到
 * 文件/网页/issue 的指令）写一条 `sessions.agentStudio.*` / `chat.agent.*`，或塞一个
 * `tasks.json` 任务，就能改掉模型、provider、自动批准档位，乃至**执行任意命令**。
 * 与「授权表不放 `.vscode/`」同源（见 `common/toolAllowStore.ts` 注释）。
 *
 * 已接管项：
 *   1. 配置（settings.json）—— `ConfigurationService` 不加载 folder 配置，folder 模型恒空；
 *      `updateValue` 的 WORKSPACE/WORKSPACE_FOLDER 目标抛错。
 *   2. 工作区级任务（tasks.json）—— 落点改为 `<workspace>/.sarosworkspace/tasks.json`，
 *      旧 `.vscode/tasks.json` 只允许在**一次性迁移**里被读到。
 *
 * 未接管（有意）：`editor.*` 这类外观/编辑器能力仍按 VS Code 原生语义读工作区设置；
 * 扩展自有的 `.vscode/xxx.json` 由各扩展自己解析，核心管不到。
 */

const CONFIG_SERVICE = 'src/vs/sessions/services/configuration/browser/configurationService.ts';
const TASKS_SERVICE = 'src/vs/sessions/contrib/chat/browser/sessionsTasksService.ts';
const EXTENSIONS_CONFIG_SERVICE = 'src/vs/workbench/services/extensionRecommendations/common/workspaceExtensionsConfig.ts';
const SNIPPETS_SERVICE = 'src/vs/workbench/contrib/snippets/browser/snippetsService.ts';
const CONFIGURE_SNIPPETS_COMMAND = 'src/vs/workbench/contrib/snippets/browser/commands/configureSnippets.ts';
const AGENT_STUDIO_CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
const LAYOUT_PROFILE = 'src/vs/sessions/browser/layoutProfile.ts';
const SESSIONS_WORKBENCH = 'src/vs/sessions/browser/workbench.ts';
const WORKBENCH_LAYOUT = 'src/vs/workbench/browser/layout.ts';
const AGENT_EDITOR_PARTS = 'src/vs/sessions/browser/parts/agentEditorParts.ts';
const WORKBENCH_DESKTOP_MAIN = 'src/vs/workbench/workbench.desktop.main.ts';
const WORKBENCH_COMMON_MAIN = 'src/vs/workbench/workbench.common.main.ts';
const AGENT_LAYOUT_WORKBENCH = 'src/vs/sessions/browser/agentLayoutWorkbench.ts';
const AGENT_LAYOUT_DESKTOP_MAIN = 'src/vs/sessions/electron-browser/agentLayoutDesktopMain.ts';
const AGENT_LAYOUT_DESKTOP_MAIN_ENTRY = 'src/vs/sessions/agentLayout.desktop.main.ts';
const DESKTOP_MAIN = 'src/vs/workbench/electron-browser/desktop.main.ts';
const WORKBENCH_CONFIG_SERVICE = 'src/vs/workbench/services/configuration/browser/configurationService.ts';
const AGENT_LAYOUT_WORKSPACE_SERVICE = 'src/vs/sessions/services/configuration/browser/agentLayoutWorkspaceService.ts';
const SESSIONS_COMMON_MAIN = 'src/vs/sessions/sessions.common.main.ts';
const WORKBENCH_BROWSER = 'src/vs/workbench/browser/workbench.ts';
const SESSIONS_DESKTOP_MAIN = 'src/vs/sessions/sessions.desktop.main.ts';

/** 只剥**整行** `//` 注释（与 `guardrailWiring.test.ts` 同款手法，避免误吃代码）。 */
function stripComments(src: string): string {
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 连块注释一起去掉，得到「纯代码」。
 *
 * 用于断言某个标识符**没有被实现** —— 这类标识符经常恰好出现在解释「为什么
 * 不实现它」的文档注释里（例如 `createMainEditorPart`），只剥行注释会把
 * 注释里的提及误判成实现。
 */
function stripAllComments(src: string): string {
	return stripComments(src).replace(/\/\*[\s\S]*?\*\//g, '');
}

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return stripComments(fs.readFileSync(abs, 'utf8'));
}

suite('Sessions configuration isolation — no workspace .vscode/settings.json', () => {

	test('★★ 反向：配置服务不得再有任何 folder 级配置（`.vscode/settings.json`）的读取路径', () => {
		const src = readSource(CONFIG_SERVICE);
		// 这些标识符只可能来自「读/写 folder 配置」的实现；注释里刻意不写它们，
		// 否则负向断言会被块注释骗到（块注释不剥，见 stripComments 说明）。
		const forbidden = [
			'FOLDER_SETTINGS_PATH',
			'FOLDER_CONFIG_FOLDER_NAME',
			'FolderConfiguration',
			'loadFolderConfigurations',
			'updateFolderConfiguration',
			'compareAndUpdateFolderConfiguration',
			'compareAndDeleteFolderConfiguration',
			'cachedFolderConfigs',
		];
		for (const needle of forbidden) {
			assert.ok(
				!src.includes(needle),
				`${CONFIG_SERVICE} 不该再出现 \`${needle}\` —— 它会把 \`<folder>/.vscode/settings.json\` 读回配置体系`,
			);
		}
	});

	test('正向：用户级配置仍在读（不能因为摘 folder 配置把配置源一起摘没了）', () => {
		const src = readSource(CONFIG_SERVICE);
		assert.ok(src.includes('UserConfiguration'), '仍应读取用户级 settings.json');
		assert.ok(src.includes('this.settingsResource'), '仍应有用户级 settings 资源');
	});

	test('正向：folder 配置模型恒为空（构造 Configuration 时不传 folder 模型）', () => {
		const src = readSource(CONFIG_SERVICE);
		assert.ok(src.includes('new ResourceMap<ConfigurationModel>()'), 'folder 配置应传空 ResourceMap');
	});

	test('元测试：源码确实被读到（防止路径错了导致断言全部空过）', () => {
		const src = readSource(CONFIG_SERVICE);
		assert.ok(src.length > 2000, `源码长度异常（${src.length}），路径基准可能已变`);
		assert.ok(src.includes('class ConfigurationService'), '应能读到 ConfigurationService 类定义');
	});

	test('★★ 工作区级任务落 `.sarosworkspace`，`\'.vscode\'` 只允许出现在一次性迁移里', () => {
		const src = readSource(TASKS_SERVICE);
		assert.ok(
			src.includes(`'.sarosworkspace'`),
			'工作区级任务应落 `<workspace>/.sarosworkspace/tasks.json`',
		);
		// 用**带引号的字面量**计数：块注释里写的 `.vscode/tasks.json` 不含引号，不会误命中。
		// 恰好 1 次 = 只出现在 `_migrateLegacyWorkspaceTasks` 的旧路径读取里；
		// 多一处就说明又有人把 `.vscode/` 当数据源了。
		const legacyHits = src.split(`'.vscode'`).length - 1;
		assert.strictEqual(
			legacyHits,
			1,
			`${TASKS_SERVICE} 里 '.vscode' 只应出现在一次性迁移中，实际 ${legacyHits} 次`,
		);
	});

	test('★★ agents 窗口不读 `<folder>/.vscode/extensions.json`（推荐扩展 = 安装即执行）', () => {
		const src = readSource(EXTENSIONS_CONFIG_SERVICE);
		assert.ok(
			src.includes('isSessionsWindow'),
			'扩展推荐服务应按窗口类型区分：agents 窗口不得读工作区扩展推荐',
		);
		assert.ok(
			src.includes('_readWorkspaceFolderConfigs'),
			'应有单一闸门 `_readWorkspaceFolderConfigs`（读取与写入共用，防止只堵一半）',
		);
		// 读取咽喉点必须真的查这个闸门 —— 否则闸门只是个装饰。
		const resolve = src.slice(src.indexOf('resolveWorkspaceFolderExtensionConfig('));
		assert.ok(
			resolve.includes('_readWorkspaceFolderConfigs'),
			'`resolveWorkspaceFolderExtensionConfig` 必须查闸门，否则 folder 级仍会被读进来',
		);
		// 写入侧同理：不能读它却写它（会在用户仓库里凭空造配置）。
		assert.ok(
			src.includes('_writableFolderTargets'),
			'写入目标应走 `_writableFolderTargets`（agents 窗口下为空）',
		);
	});

	test('★★ Agent Studio 配置必须带 `MACHINE` scope（标准 IDE 底座下唯一的工作区隔离手段）', () => {
		const src = readSource(AGENT_STUDIO_CONTRIBUTION);
		assert.ok(
			src.includes('ConfigurationScope'),
			'应引入 `ConfigurationScope` —— 否则配置会被工作区 `.vscode/settings.json` 覆盖',
		);
		const nodes = src.split('registerConfiguration({').length - 1;
		const scoped = src.split('scope: ConfigurationScope.MACHINE').length - 1;
		assert.ok(nodes > 0, '应能读到 registerConfiguration 调用');
		assert.strictEqual(
			scoped,
			nodes,
			`${nodes} 处 registerConfiguration 都应带 \`scope: ConfigurationScope.MACHINE\`，实际只有 ${scoped} 处`,
		);
		// 反向：不得退化成默认 WINDOW（可被工作区覆盖），也不得用 APPLICATION
		// （其语义是「仅默认 profile 用户设置」—— agents 窗口跑在独立 profile 下，会静默读不到用户设置）。
		assert.ok(
			!src.includes('scope: ConfigurationScope.WINDOW'),
			'不得显式用 WINDOW（= 可被工作区覆盖，等于放弃隔离）',
		);
		assert.ok(
			!src.includes('scope: ConfigurationScope.APPLICATION'),
			'不得用 APPLICATION（仅默认 profile 生效，agents profile 下会读不到用户设置）',
		);
	});

	test('★★ Agent 布局 grid 只能有一份实现（workbench.ts 必须委托纯函数，不得内联第二份）', () => {
		// 背景：「IDE 底座 + Agent 布局」方案要把这套 grid 复用到标准 workbench。
		// 若 sessions 侧仍内联一份、标准侧再抄一份 ⇒ 必然漂移（本仓已多次踩此坑）。
		// 因此把 grid 构造抽到 `browser/layoutProfile.ts` 的纯函数，workbench.ts 只做状态映射。
		//
		// 注：本模块无法在 node 测试环境里 import —— `layoutProfile.ts` 运行时依赖
		// `base/browser/ui/grid/grid.js` 与 `workbench/services/layout/browser/layoutService.js`，
		// 二者在模块加载期就引用 `window`（`var mainWindow = window`）。
		// 故这里用**源码级**断言守边界，行为基线靠 tsgo + 人工目视（agents 窗口布局应逐字不变）。
		const profile = readSource(LAYOUT_PROFILE);
		assert.ok(
			profile.includes('export function createAgentsLayoutGridDescriptor('),
			'应导出纯函数 `createAgentsLayoutGridDescriptor`',
		);
		assert.ok(
			!profile.includes('this.'),
			'纯函数不得引用 `this`（否则无法被标准 workbench 复用）',
		);

		const wb = readSource(SESSIONS_WORKBENCH);
		const methodStart = wb.indexOf('private createDesktopGridDescriptor(');
		assert.ok(methodStart >= 0, '应能找到 `createDesktopGridDescriptor`');
		const methodBody = wb.slice(methodStart, wb.indexOf('\n\t}', methodStart));
		assert.ok(
			methodBody.includes('createAgentsLayoutGridDescriptor('),
			'`createDesktopGridDescriptor` 必须委托到纯函数',
		);
		assert.ok(
			!methodBody.includes(`type: 'leaf'`),
			'`createDesktopGridDescriptor` 不得再内联 grid 节点构造 —— 说明出现了第二份实现',
		);
	});

	test('★★ 标准 workbench 的 `createGridDescriptor` 必须可覆写（布局 profile 的唯一接缝）', () => {
		// 「IDE 底座 + Agent 布局」的接法 = 覆写 `Layout.createGridDescriptor()`。
		// 它原本是 `private`，子类无法覆写 ⇒ 已改 `protected`。本用例把它钉住：
		// 谁改回 `private`，布局复用方案当场失效。
		const src = readSource(WORKBENCH_LAYOUT);
		assert.ok(
			src.includes('protected createGridDescriptor(): ISerializedGrid'),
			'`createGridDescriptor` 必须是 `protected`（否则子类无法替换布局）',
		);
		assert.ok(
			!src.includes('private createGridDescriptor(): ISerializedGrid'),
			'`createGridDescriptor` 不得回到 `private`',
		);
	});

	test('★★ 额外 part 必须在 renderWorkbench 的部件循环里渲染（否则 grid 崩在 deserialize）', () => {
		const wb = stripAllComments(readSource(WORKBENCH_BROWSER));

		// 这是**唯一**调用 `part.create(parent)` 的地方 —— 而 `EditorPart` 的内部 grid
		// 正是在 `create()` 里建立的。只 `registerPart` 而不经此循环渲染，
		// grid 解出来时会拿到未初始化的视图（`onDidChange` getter 读 undefined）。
		assert.ok(
			wb.includes('this.getPart(id).create(partContainer, options)'),
			'`renderWorkbench()` 的部件循环必须仍是 `create()` 的唯一调用点',
		);
		assert.ok(wb.includes('...this.getAdditionalPartsToRender()'), '循环必须并入 `getAdditionalPartsToRender()`');
		assert.ok(wb.includes('protected getAdditionalPartsToRender()'), '必须提供 `getAdditionalPartsToRender()` 接缝');
		// `shouldRenderPart` 声明在 **`Layout`** 里 —— `createWorkbenchLayout()` 在那边，
		// 它也得能调到（那边同样有 `getPart(ACTIVITYBAR)`）。
		const layout = stripAllComments(readSource(WORKBENCH_LAYOUT));
		assert.ok(
			layout.includes('protected shouldRenderPart(_id: Parts): boolean'),
			'`shouldRenderPart()` 接缝必须声明在 `Layout` 里',
		);
		// `getPart()` 对未注册部件**抛错**（不是返回 undefined），所以跳过必须在调用它之前。
		assert.ok(wb.includes('if (!this.shouldRenderPart(id))'), '渲染循环必须在 `getPart()` 之前跳过');
		// ★ `createWorkbenchLayout()` 里的 activity bar 同样必须先问再接。
		assert.ok(
			layout.includes('this.shouldRenderPart(Parts.ACTIVITYBAR_PART) ? this.getPart(Parts.ACTIVITYBAR_PART) : undefined'),
			'`createWorkbenchLayout()` 必须先问 `shouldRenderPart()` 再取 activity bar',
		);

		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH));
		assert.ok(
			code.includes('protected override getAdditionalPartsToRender()'),
			'子类必须覆写追加接缝（否则 `AGENT_EDITOR_PART` 永不 `create()`）',
		);
		// ★ 子类**不再**跳过 activity bar —— 标准 `Layout` 的记账要求它存在
		// （`getMaximumEditorDimensions()` 读 `activityBarPartView.minimumWidth`），
		// 所以改为补建一个（sessions 的 `SidebarPart` 不自建，标准 `SidebarPart` 才自建）。
		assert.ok(
			!code.includes('shouldRenderPart(id: Parts)'),
			'子类不得再跳过 activity bar（标准 Layout 的记账要求它存在）',
		);
		assert.ok(code.includes('createActivityBarPart('), '必须补建 activity bar 部件');
		// ★ 必须在**更早**的接缝里创建：`renderWorkbench()`（`workbench.ts:172`）早于
		// `createWorkbenchLayout()`（`:175`），而它的部件循环会先 `getPart(ACTIVITYBAR)`。
		// 放进 `createAdditionalPartViews()` 就太晚了（真机验证过），而且会重复创建。
		assert.ok(
			!code.includes('[Parts.ACTIVITYBAR_PART]: agentEditorParts.createActivityBarPart('),
			'不得在 `createAdditionalPartViews()` 里注入 activity bar（注册太晚且会重复创建）',
		);
		assert.ok(
			stripAllComments(readSource(AGENT_EDITOR_PARTS)).includes('createActivityBarPart(paneCompositePart: IPaneCompositePart)'),
			'`AgentEditorParts` 必须提供 `createActivityBarPart()`（子类没有 DI）',
		);

		// ★ 追加接缝里必须**真的取一次** `agentPart`（惰性 getter）：
		// 不实例化就不会 `registerPart`，`renderWorkbench` 的循环会抛
		// `Unknown part workbench.parts.agentEditor`（真机验证过）。
		assert.ok(
			code.includes('void agentEditorParts.agentPart;'),
			'追加接缝必须触发 `agentPart` 的惰性实例化',
		);
	});

	test('★★ 标准 `layoutActions.js` 必须引入（与 sessions 版不冲突）', () => {
		// 放开它是安全的：sessions 自己的 `./browser/layoutActions.js` 与之**不冲突** ——
		// action id 全带 `agent` 前缀（`workbench.action.agentToggle*`）、
		// 图标 id 全带 `agent-` 前缀，标准版则是 `workbench.action.toggle*` /
		// `fullscreen` / `centerLayoutIcon` / `zenMode`。
		//
		// ⚠ 它**不是** `zenMode` 配置的注册处（那个在
		// `workbench/browser/workbench.zenMode.contribution.ts`，已由
		// `workbench.common.main.ts:12` 引入）—— 真机验证：放开本行后
		// `getZenModeConfiguration(...).restore` 那个 ERR 依旧、栈不变。
		const common = stripAllComments(readSource(SESSIONS_COMMON_MAIN));
		assert.ok(
			common.includes("import '../workbench/browser/actions/layoutActions.js'"),
			'必须引入标准 `layoutActions.js`',
		);
	});

	test('★★ 方案 B1：agents 窗口入口 + parts 覆盖都已切到标准底座', () => {
		const desktop = stripAllComments(readSource(SESSIONS_DESKTOP_MAIN));
		assert.ok(
			desktop.includes("import './electron-browser/agentLayoutDesktopMain.js'"),
			'入口必须换成 `AgentLayoutDesktopMain`',
		);
		assert.ok(
			desktop.includes("export { main } from './electron-browser/agentLayoutDesktopMain.js'"),
			'`main` 必须指向 `AgentLayoutDesktopMain`',
		);
		assert.ok(!desktop.includes('electron-browser/sessions.main.js'), '不得再引用 sessions 的 `SessionsMain`');

		const common = stripAllComments(readSource(SESSIONS_COMMON_MAIN));
		assert.ok(
			common.includes("import '../workbench/browser/parts/editor/editorParts.js'"),
			'必须引入**标准** `editorParts.js`',
		);
		assert.ok(
			common.includes("import '../workbench/browser/parts/paneCompositePartService.js'"),
			'必须引入**标准** `paneCompositePartService.js`',
		);
		// ★ 只撤 `editorParts`：它覆盖 `IEditorGroupsService`，必须让标准
		// `AgentEditorParts` 生效（否则 `Parts.AGENT_EDITOR_PART` 没有宿主）。
		assert.ok(
			!common.includes("'./browser/parts/editorParts.js'"),
			'不得再引入 sessions 的 `editorParts`（会顶掉标准版，agent part 就没有宿主）',
		);

		// ★ `paneCompositePartService` **必须保留** —— 它是标准版的**超集**
		// （Panel/Sidebar/AuxiliaryBar + **ChatBar**）。撤掉它，`sessions/contrib/chat` 的
		// `RegisterChatViewContainerContribution` 往 `ViewContainerLocation.ChatBar`
		// 注册容器时会在标准 `PaneCompositePartService.getPartByLocation()` 上断言失败。
		// （首次真机验证已确认这条，别再把两处覆盖一起撤。）
		assert.ok(
			common.includes("'./browser/paneCompositePartService.js'"),
			'必须保留 sessions 的 `paneCompositePartService`（ChatBar 是 sessions chat 的刚需）',
		);
	});

	test('★★ `IWorkspaceEditingService` 必须显式注册（sessions 侧靠 context service 兼任）', () => {
		// sessions 侧：`sessions.main.ts` `serviceCollection.set(IWorkspaceEditingService, workspaceContextService)`。
		// 标准 `DesktopMain` 只注册 `IWorkspaceContextService` + `IWorkbenchConfigurationService`
		// ⇒ 缺它会让 `sessions.sourceControlWorkspaceSync` / `sessions.agentStudio.workspaceFolderSync` /
		// `ChatSessionStore` / `MainThreadWorkspace` 全部创建失败，**扩展宿主客户都建不起来**。
		const common = stripAllComments(readSource(SESSIONS_COMMON_MAIN));
		assert.ok(
			common.includes("import '../workbench/services/workspaces/browser/workspaceEditingService.js'"),
			'必须引入标准 `workspaceEditingService.js` 以注册 `IWorkspaceEditingService`',
		);
	});

	test('★★ agents 布局入口必须把 workspace/configuration 换成隔离版', () => {
		const code = stripAllComments(readSource(AGENT_LAYOUT_DESKTOP_MAIN));

		assert.ok(
			code.includes('protected override async createWorkspaceService('),
			'必须覆写 `createWorkspaceService()` —— 否则标准 `DesktopMain` 会建标准 `WorkspaceService`',
		);
		assert.ok(
			code.includes('new AgentLayoutWorkspaceService('),
			'必须构造 `AgentLayoutWorkspaceService`（folder 模型恒空）',
		);
		// ★ 不得退回标准实现：标准 `WorkspaceService` 会加载 folder 配置模型
		// ⇒ 那个窗口就会读 `<folder>/.vscode/settings.json`（违反用户定的规则）。
		assert.ok(
			!code.includes('new WorkspaceService('),
			'不得构造标准 `WorkspaceService`',
		);
	});

	test('★★ agents 布局的配置服务必须把 folder 模型置空（不读 .vscode/settings.json）', () => {
		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKSPACE_SERVICE));

		assert.ok(
			code.includes('class AgentLayoutWorkspaceService extends WorkspaceService'),
			'必须继承**标准** `WorkspaceService`（标准底座才拿得到标准服务图）',
		);
		assert.ok(
			code.includes('protected override createConfiguration('),
			'必须覆写 `createConfiguration()` —— folder 配置模型的唯一接入点',
		);

		// ★ folder 模型必须**保留 key、清空内容**：
		// 直接传空 map 会让标准 `WorkspaceService` 的 folder 变更记账炸（`Unknown folder`，
		// 真机验证过）；保留 key + 空模型则记账正常、且 `.vscode/settings.json` 读不进来。
		assert.ok(code.includes('const emptiedFolders = new ResourceMap<ConfigurationModel>()'), '必须构造 emptiedFolders');
		assert.ok(
			code.includes('ConfigurationModel.createEmptyModel(logService)'),
			'必须把每个 folder 的模型置空（内容读不进来）',
		);
		const superCallIdx = code.indexOf('super.createConfiguration(');
		const emptiedIdx = code.indexOf('emptiedFolders,');
		assert.ok(superCallIdx >= 0, '必须委托 `super.createConfiguration(...)`');
		assert.ok(emptiedIdx > superCallIdx, '必须把 `emptiedFolders` 传给基类');
		assert.ok(
			!code.includes('new ResourceMap<ConfigurationModel>(),\n\t\t\tmemoryConfiguration'),
			'不得传空 map（会触发 `Unknown folder`）',
		);
	});

	test('★★ 标准 `createConfiguration` 必须可覆写，且所有构造都必须走它', () => {
		const code = stripAllComments(readSource(WORKBENCH_CONFIG_SERVICE));

		// 方案 C 第 4 条（folder 配置模型恒空）的唯一接入点。
		assert.ok(code.includes('protected createConfiguration('), '必须提供 `protected createConfiguration()`');
		assert.ok(code.includes('protected _configuration: Configuration;'), '`_configuration` 必须 `protected`');
		assert.ok(
			code.includes('protected readonly defaultConfiguration: DefaultConfiguration;'),
			'`defaultConfiguration` 必须 `protected`（`agentsWindow` 默认值覆写要用）',
		);

		// ★ 只允许工厂内部出现一次 `new Configuration(`。
		// 任何绕过工厂的构造点，子类都拦不到 ⇒ folder 配置模型会被重新装进 `Configuration`
		// ⇒ 又变成读 `<folder>/.vscode/settings.json`（方案 C 失效）。
		const constructions = code.match(/new Configuration\(/g) ?? [];
		assert.strictEqual(
			constructions.length,
			1,
			'`new Configuration(` 只应出现在 `createConfiguration()` 工厂里（其余构造点都必须走工厂）',
		);
	});

	test('★★ 标准 `createWorkspaceService` 必须可覆写（方案 C 隔离搬回标准底座的唯一接缝）', () => {
		// 它返回的**同一个** `WorkspaceService` 同时被注册成 `IWorkspaceContextService`
		// 与 `IWorkbenchConfigurationService` ⇒ 覆写一处即同时保住两侧行为。
		// 原本是 `private`，子类无法覆写 ⇒ 已改 `protected`。谁改回 `private`，
		// 「IDE 底座 + Agent 布局」就再也保不住方案 C 的配置隔离。
		const code = stripAllComments(readSource(DESKTOP_MAIN));
		assert.ok(
			code.includes('protected async createWorkspaceService('),
			'`createWorkspaceService` 必须是 `protected`',
		);
		assert.ok(
			!code.includes('private async createWorkspaceService('),
			'`createWorkspaceService` 不得回到 `private`',
		);
	});

	test('★★ agents 布局入口：不得引入整个 sessions 底座；按需引入的贡献必须列明', () => {
		const code = stripAllComments(readSource(AGENT_LAYOUT_DESKTOP_MAIN_ENTRY));

		// 标准底座：一行拿到全套标准贡献 + 服务。
		assert.ok(
			code.includes("import '../workbench/workbench.desktop.main.js'"),
			'入口必须 import 标准 `workbench.desktop.main.js`（贡献 + 服务）',
		);

		// ★ 仍然禁止的是**整个 sessions 底座**：`sessions.common.main.js` 里是 sessions 那批
		// **一次性覆盖标准 singleton** 的注册，而 `registerSingleton` 后注册者胜出
		// ⇒ 引入它就把底座抢回 sessions，"IDE 底座"这个前提直接失效。
		assert.ok(
			!code.includes('sessions.common.main.js'),
			'不得 import `sessions.common.main.js` —— 会一次性覆盖标准 singleton，底座被抢回 sessions',
		);
		assert.ok(
			!code.includes('sessions.main.js'),
			'不得 import `sessions.main.js` —— 那是 sessions 的窗口实现（SessionsMain）',
		);

		// ★ 允许**按需**引入具体贡献。当前恰好两处，各有明确理由（见入口注释）：
		//   - `agentStudio.contribution`：注册 Canvas / Chat 的 editor pane，
		//     否则右侧 `AGENT_EDITOR_PART` 只能是一块空编辑器水印（真机截图确认）；
		//   - `paneCompositePartService`：**确实是 singleton 覆盖**（有意例外），
		//     不加它 ChatBar 的 view container 注册会在标准 `PaneCompositePartService`
		//     上断言失败（`sessions.common.main.ts:496-500` 记录的真机结论）。
		//
		// 把它们**列明**：以后谁想再加第三个 sessions 侧 import，必须先改这条用例
		// —— 也就是必须写明理由，而不是悄悄扩大底座耦合面。
		const allowedSessionsImports = [
			"./contrib/agentStudio/browser/agentStudio.contribution.js",
			"./browser/paneCompositePartService.js",
		];
		for (const item of allowedSessionsImports) {
			assert.ok(code.includes(`import '${item}'`), `必须引入 \`${item}\``);
		}

		const actualSessionsImports = [...code.matchAll(/^import '\.\/(?!electron-browser)[^']+'/gm)].map(m => m[0]);
		assert.deepStrictEqual(
			actualSessionsImports.sort(),
			allowedSessionsImports.map(item => `import '${item}'`).sort(),
			'新增 sessions 侧 import 前必须更新本用例（= 强制写明理由）',
		);

		// 窗口实现必须换成 Agent 布局那个。
		assert.ok(
			code.includes("export { main } from './electron-browser/agentLayoutDesktopMain.js'"),
			'必须把 `main` 指向 `agentLayoutDesktopMain`',
		);
	});

	test('★★ 标准 workbench 复用时必须补上 Layout 记账所需的部件节点（隐藏）', () => {
		const profile = stripAllComments(readSource(LAYOUT_PROFILE));
		// 标准 `Layout` 的记账假设「部件全集都在 grid 里」：
		// `getMaximumEditorDimensions()` 读 activityBarPartView；
		// storage 处理器读 `getViewCachedVisibleSize(auxiliaryBarPartView)`（否则 `View not found`）。
		assert.ok(
			profile.includes('includeLayoutBookkeepingParts'),
			'必须提供 `includeLayoutBookkeepingParts` 开关',
		);
		assert.ok(profile.includes('visible: false'), '补上的节点必须是隐藏的（不占空间、不影响外观）');
		assert.ok(
			profile.includes('partIds.activityBar') && profile.includes('partIds.auxiliaryBar') && profile.includes('partIds.statusBar'),
			'必须补上 activity bar / aux bar / statusbar 三个节点',
		);

		// ★ sessions 窗口**不得**开启该开关 —— 它整套 `Layout` 都换掉了，
		// 不吃这套记账；开了反而会多出三个隐藏节点。
		assert.ok(
			!stripAllComments(readSource(SESSIONS_WORKBENCH)).includes('includeLayoutBookkeepingParts'),
			'sessions 窗口不得开启 `includeLayoutBookkeepingParts`（它不吃标准 Layout 的记账）',
		);
	});

	test('★★ agents 布局必须用 agents 默认（侧栏展开、panel 隐藏），不得复用标准窗口的折叠状态', () => {
		// 正确布局（真机对比截图确认）：`Sidebar(展开) | Editor(空) | AgentEditor(聊天)`，
		// 底部**没有** panel。
		//
		// ⚠ 标准 `LayoutStateKeys.SIDEBAR_HIDDEN / PANEL_HIDDEN` 属于**标准 IDE 窗口**的用法
		// （panel 常开、侧栏常收），照搬会得到正好相反的外观
		// （侧栏只剩 48px 图标条 + panel 占满左列）—— 实测踩过。
		const layout = stripAllComments(readSource(WORKBENCH_LAYOUT));
		const stateBlock = layout.slice(
			layout.indexOf('protected getAgentsLayoutState()'),
			layout.indexOf('protected createWorkbenchLayout()'),
		);
		assert.ok(stateBlock.length > 0, '未找到 `getAgentsLayoutState()`');
		assert.ok(stateBlock.includes('sidebarContentExpanded: true'), 'agents 布局侧栏必须**默认展开**');
		assert.ok(stateBlock.includes('panelVisible: false'), 'agents 布局 panel 必须**默认隐藏**');
		assert.ok(!stateBlock.includes('LayoutStateKeys.SIDEBAR_HIDDEN'), '不得复用标准窗口的侧栏折叠状态');
		assert.ok(!stateBlock.includes('LayoutStateKeys.PANEL_HIDDEN'), '不得复用标准窗口的 panel 折叠状态');

		// ★ 曾经的"折叠空编辑器"改动已**撤销**：它会让 panel 占满左列，
		// 而正确布局是"editor 可见（空）+ panel 隐藏"—— 两者正好相反。
		assert.ok(
			!layout.includes('shouldCollapseEmptyEditorOnStartup'),
			'不得再折叠空编辑器区（与正确布局相反）',
		);
		assert.ok(
			!stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH)).includes('shouldCollapseEmptyEditorOnStartup'),
			'`AgentLayoutWorkbench` 不得再覆写折叠行为',
		);
	});

	test('★★ agents 布局必须显式隐藏记账部件的 DOM（grid 的 visible:false 不隐藏 DOM）', () => {
		// `Part.setVisible()` **不碰 DOM** —— 它只 `this._onDidVisibilityChange.fire(visible)`
		// （`workbench/browser/part.ts:193`）。真正隐藏 DOM 的是 grid 内部的 `ViewItem`，
		// 而记账部件（activity bar / aux bar / statusbar）从未"可见过" ⇒ grid 不会对它们调
		// `ViewItem.setVisible(false)` ⇒ 元素留在容器里按自身 CSS（`.part { position:absolute }`）
		// 渲染出来（真机验证：窗口左侧多出一条 activity bar 图标条）。
		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH));
		assert.ok(
			code.includes('override createWorkbenchLayout()'),
			'必须覆写 `createWorkbenchLayout()` 来隐藏记账部件',
		);
		assert.ok(
			code.includes("style.display = 'none'"),
			'必须显式把记账部件的元素置 `display: none`',
		);
		// ★★ 必须判 `element`：`Part.element` **只在 `create()` 里赋值**，而 `renderWorkbench`
		// 的部件循环只 `create()` 标准 8 个 + 我们追加的那些 —— `CHATBAR_PART` 不在其中
		// ⇒ 它没有 element。不判空会崩在 `createWorkbenchLayout`（在 grid 创建**之前**）
		// ⇒ 窗口整块空白（真机验证过，2026-09-14）。
		assert.ok(
			code.includes('if (part?.element)'),
			'必须用 `if (part?.element)` 守卫 —— 否则未 `create()` 的部件会让窗口起不来',
		);
		for (const part of ['AUXILIARYBAR_PART', 'STATUSBAR_PART']) {
			assert.ok(code.includes(`Parts.${part}`), `必须隐藏 \`${part}\``);
		}
		// ★★ 但 `ACTIVITYBAR_PART` **必须保持可见**：入口引入 sessions 版
		// `paneCompositePartService` 后侧栏也变成 sessions 侧栏，而 sessions 侧栏
		// **把 activity bar 图标条折进自己内部** ⇒ 隐藏它的 DOM 会把侧栏图标条一起藏掉
		// （真机症状：「左侧 activitybar 缺失」）。这条与"记账部件要隐藏"是**两个方向**，
		// 容易被后人当成疏漏而"顺手补上"，所以专门锁住。
		// ⚠ 只能断言它**不在隐藏列表里** —— `Parts.ACTIVITYBAR_PART` 在
		// `createGridDescriptor()` 里是**合法出现**的（记账节点要用它）。
		assert.ok(
			/const partsToHide = \[Parts\.AUXILIARYBAR_PART, Parts\.STATUSBAR_PART, Parts\.CHATBAR_PART\]/.test(code),
			'隐藏列表不得含 `ACTIVITYBAR_PART` —— 它已折进 sessions 侧栏，隐藏会让左侧图标条整体消失',
		);
	});

	test('★★ agents 布局的 Workbench 子类：只注入额外 part，且不得自己 new（没有 DI）', () => {
		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH));
		assert.ok(
			code.includes('protected override createAdditionalPartViews()'),
			'必须覆写 `createAdditionalPartViews()`，否则 `Parts.AGENT_EDITOR_PART` 进不了 viewMap',
		);
		// `workbench/browser/layout.ts` 里没有 instantiationService ⇒ 子类拿不到 DI，
		// 只能走 `agentEditorParts.ts` 暴露的模块级访问器。
		assert.ok(code.includes('getAgentEditorParts()'), '必须通过 `getAgentEditorParts()` 取宿主（子类没有 DI）');
		assert.ok(
			!code.includes('createInstance('),
			'不得自己 `createInstance` —— `Layout`/`Workbench` 没有 instantiationService',
		);
		assert.ok(
			code.includes('[Parts.AGENT_EDITOR_PART]: agentEditorParts.agentPart'),
			'必须把 `agentPart` 作为 `Parts.AGENT_EDITOR_PART` 的视图返回',
		);
	});

	test('★★ 方案 2（入口换子类）：标准 DesktopMain 的默认路径必须仍是 upstream Workbench', () => {
		const entry = stripAllComments(readSource(AGENT_LAYOUT_DESKTOP_MAIN));
		assert.ok(
			entry.includes('class AgentLayoutDesktopMain extends DesktopMain'),
			'入口必须继承**标准** `DesktopMain`（拿到标准服务图，只换布局）',
		);
		assert.ok(entry.includes('return AgentLayoutWorkbench;'), '必须返回 `AgentLayoutWorkbench`');

		// 标准 IDE 窗口不受影响：默认实现必须原样返回 upstream 的 Workbench。
		const desktop = stripAllComments(readSource(DESKTOP_MAIN));
		assert.ok(
			desktop.includes('protected getWorkbenchConstructor(): typeof Workbench {'),
			'`desktop.main.ts` 必须提供 `getWorkbenchConstructor()` 接缝',
		);
		assert.ok(/return Workbench;\s*\}/.test(desktop), '默认实现必须返回 upstream `Workbench`（标准窗口行为不变）');
	});

	test('★★ agents grid 需要的额外 part 必须与注入的完全一致（这就是崩窗条件）', () => {
		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH));

		// grid 里引用的 part id —— 标准 viewMap 已含 TITLEBAR/SIDEBAR/EDITOR/PANEL，
		// 其余**必须**由 `createAdditionalPartViews()` 提供，否则
		// `SerializableGrid.deserialize` 会因 `fromJSON` 取到 `undefined` 而抛错。
		const gridBlock = code.slice(code.indexOf('protected override createGridDescriptor()'));
		assert.ok(gridBlock.length > 0, '必须覆写 `createGridDescriptor()`');

		// 标准 `Layout.createWorkbenchLayout()` 的 `viewMap` 覆盖这 8 个部件
		// （另外三个是"记账部件"，见 `includeLayoutBookkeepingParts`）。
		const STANDARD_PART_IDS = [
			'TITLEBAR_PART', 'BANNER_PART', 'ACTIVITYBAR_PART', 'SIDEBAR_PART',
			'EDITOR_PART', 'PANEL_PART', 'AUXILIARYBAR_PART', 'STATUSBAR_PART',
		];
		const gridPartIds = [...new Set([...gridBlock.matchAll(/Parts\.([A-Z_]+_PART)/g)].map(m => m[1]))];
		const extraNeeded = gridPartIds.filter(id => !STANDARD_PART_IDS.includes(id));

		const injected = [...new Set([...code.matchAll(/\[Parts\.([A-Z_]+_PART)\]/g)].map(m => m[1]))];

		assert.deepStrictEqual(
			extraNeeded,
			['AGENT_EDITOR_PART'],
			'agents grid 只应比标准 grid 多引用 `AGENT_EDITOR_PART`',
		);
		assert.ok(
			injected.includes('AGENT_EDITOR_PART'),
			'grid 引用的额外 part 必须全部在 `createAdditionalPartViews()` 里注入',
		);

		// 单一实现：grid 必须委托纯函数，不得在本类里手搓第二份（会漂移）。
		assert.ok(
			gridBlock.includes('createAgentsLayoutGridDescriptor('),
			'必须委托 `createAgentsLayoutGridDescriptor()`',
		);
		assert.ok(!gridBlock.includes('SerializableGrid'), '不得在本类里手搓 grid');
	});

	test('★★ agents 布局状态必须由 `Layout` 提供，子类不得直接读 stateModel', () => {
		const layout = stripAllComments(readSource(WORKBENCH_LAYOUT));
		assert.ok(
			layout.includes('protected getAgentsLayoutState()'),
			'`layout.ts` 必须提供 `getAgentsLayoutState()`（那些成员对子类未必可见）',
		);

		const code = stripAllComments(readSource(AGENT_LAYOUT_WORKBENCH));
		assert.ok(code.includes('...this.getAgentsLayoutState()'), '子类必须 spread 状态快照');
		assert.ok(
			!code.includes('stateModel') && !code.includes('LayoutStateKeys'),
			'子类不得直接读 `stateModel` / `LayoutStateKeys`',
		);
	});

	test('★★ 额外 part 注入必须早于 viewMap 组装（否则 fromJSON 取到 undefined 直接崩）', () => {
		const code = stripAllComments(readSource(WORKBENCH_LAYOUT));
		assert.ok(
			code.includes('protected createAdditionalPartViews(): Record<string, ISerializableView>'),
			'`layout.ts` 必须提供 `createAdditionalPartViews()` 接缝',
		);
		const hookIdx = code.indexOf('const additionalPartViews = this.createAdditionalPartViews()');
		const deserializeIdx = code.indexOf('SerializableGrid.deserialize(');
		assert.ok(hookIdx >= 0, '`createWorkbenchLayout()` 未调用 `createAdditionalPartViews()`');
		assert.ok(deserializeIdx >= 0, '未找到 `SerializableGrid.deserialize`');
		// `Part` 基类构造即注册，所以「取视图」就是「实例化」的唯一时机。
		// 一旦挪到 `createGridDescriptor()` 里就太晚：那时 viewMap 已建好。
		assert.ok(
			hookIdx < deserializeIdx,
			'`createAdditionalPartViews()` 必须早于 `SerializableGrid.deserialize`',
		);
		assert.ok(code.includes('...additionalPartViews'), '额外视图必须并入 `viewMap`');
	});

	test('★★ 标准窗口的 agent part 宿主：只加 agent part，不得改标准编辑器区', () => {
		// 乙方案的核心约束：`AgentEditorParts` 只能**新增** agent part，
		// 不得覆写 `createMainEditorPart()` —— 一旦覆写，标准窗口的
		// `MainEditorPart` 就会被换掉，编辑器区行为跟着变（那是甲方案）。
		const code = stripAllComments(readSource(AGENT_EDITOR_PARTS));
		assert.ok(
			!code.includes('createMainEditorPart'),
			'不得覆写 `createMainEditorPart`（会改变标准窗口的编辑器区行为）',
		);
		// 必须真的把自己注册成 `IEditorGroupsService`；否则只是个没人实例化的
		// 死类，`agentPart` 惰性 getter 永远不会被触发。
		assert.ok(
			code.includes('registerSingleton(IEditorGroupsService, AgentEditorParts'),
			'必须以 `IEditorGroupsService` 覆盖注册',
		);
	});

	test('★★ 覆盖注册必须晚于 common 导入（registerSingleton 后注册者胜出）', () => {
		// `registerSingleton` 只 push 不查重（`extensions.ts:32`），`ServiceCollection`
		// 是 Map ⇒ 后注册者胜出。放进 `workbench.common.main.ts` 会因同文件内的相对
		// 顺序不可控而随时失效，因此必须挂在 `workbench.desktop.main.ts` 的
		// `workbench.common.main.js` **之后**。
		assert.ok(
			!stripAllComments(readSource(WORKBENCH_COMMON_MAIN)).includes('agentEditorParts'),
			'不得在 `workbench.common.main.ts` 里导入（顺序不可控 ⇒ 覆盖会失效）',
		);
		const desktop = stripAllComments(readSource(WORKBENCH_DESKTOP_MAIN));
		const commonIdx = desktop.indexOf("import './workbench.common.main.js'");
		const overrideIdx = desktop.indexOf('agentEditorParts');
		assert.ok(commonIdx >= 0, '未找到 `workbench.common.main.js` 导入');
		assert.ok(overrideIdx >= 0, '`workbench.desktop.main.ts` 未导入 `agentEditorParts`');
		assert.ok(
			overrideIdx > commonIdx,
			'`agentEditorParts` 必须晚于 `workbench.common.main.js` 导入，否则覆盖不生效',
		);
	});

	test('★★ snippets 的「读」与「写」两个出口都要堵（只堵读会出现「能建但不生效」）', () => {
		const reader = readSource(SNIPPETS_SERVICE);
		assert.ok(
			reader.includes('isSessionsWindow'),
			'`snippetsService` 应跳过工作区 `.vscode/*.code-snippets` 的扫描',
		);
		const writer = readSource(CONFIGURE_SNIPPETS_COMMAND);
		assert.ok(
			writer.includes('isSessionsWindow'),
			'`configureSnippets` 命令不应再提供「为工作区新建 Snippets 文件」（那会写 `.vscode/`）',
		);
	});
});
