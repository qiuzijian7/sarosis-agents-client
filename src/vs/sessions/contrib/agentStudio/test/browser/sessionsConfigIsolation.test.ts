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

/** 只剥**整行** `//` 注释（与 `guardrailWiring.test.ts` 同款手法，避免误吃代码）。 */
function stripComments(src: string): string {
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
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
