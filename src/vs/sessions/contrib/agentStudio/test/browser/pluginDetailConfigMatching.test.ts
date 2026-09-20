/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件详情页（Plugins 视图 → Installed 页签）的 Configuration 区 —— 宿主扩展匹配回归测试。
 *
 * 背景（2026-09-20）：详情页配置项取自「插件宿主扩展」的 `contributes.configuration`，
 * 而匹配用的是 `plugin.label` 与扩展 ID / 显示名的**模糊包含**。可 `plugin.label` 在本地插件的
 * 情况下只是 `basename(插件目录的父目录)`（见 `agentPluginServiceImpl.ts` 的
 * `label: fromMarketplace?.name ?? basename(parentUri)`）——一旦扩展的**目录名与包名不一致**
 * （内置 pocket：目录 `saros-pocket` / 包名 `saros-agents-pocket`），模糊匹配全部落空，
 * 配置区就静默变成空（无报错、无提示）。codebuddy / lightai 恰好目录名与 ID 尾段一致，所以从未暴露。
 *
 * 修复：以「插件目录是否位于该扩展目录内」（URI 包含关系）作为**确定性**归属判定，模糊匹配降级为兜底。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/pluginDetailConfigMatching.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';

const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/pluginDetailEditorPane.ts';
const DISCOVERY_REL = 'src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts';

/** 复刻发现器的 label 规则：本地插件的 label = 插件目录的父目录名。 */
function pluginLabelFor(pluginDirFsPath: string): string {
	return path.basename(path.dirname(pluginDirFsPath));
}

/** 复刻**修复前**的模糊匹配（保留下来是为了记录根因；它对「目录名 ≠ 包名」必然失配）。 */
function legacyFuzzyMatch(pluginLabel: string, pluginUri: string, extId: string, extName: string): boolean {
	const label = pluginLabel.toLowerCase();
	const id = extId.toLowerCase();
	const name = extName.toLowerCase();
	const uri = pluginUri.toLowerCase();
	return id.includes(label) || label.includes(id)
		|| name.includes(label) || label.includes(name)
		|| uri.includes(id.replace(/\./g, '-'));
}

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

suite('pluginDetail · 宿主扩展匹配（Installed 页签的 Configuration 区）', () => {

	// 内置 pocket：扩展目录 saros-pocket，包名 saros-agents-pocket
	const extLocation = URI.file('g:/ws/extensions/saros-pocket');
	const pluginUri = URI.file('g:/ws/extensions/saros-pocket/plugin');
	const extId = 'saros.saros-agents-pocket';
	const extName = 'Saros Pocket';

	test('label 来自插件目录的父目录名（目录名与包名不一致是常态）', () => {
		assert.strictEqual(pluginLabelFor(pluginUri.fsPath), 'saros-pocket');
	});

	test('旧模糊匹配对 pocket 必然失配 —— 这正是配置区为空的根因', () => {
		assert.strictEqual(
			legacyFuzzyMatch(pluginLabelFor(pluginUri.fsPath), pluginUri.toString(), extId, extName),
			false,
			'目录名 saros-pocket 与包名 saros-agents-pocket 互相不包含，模糊匹配无从命中',
		);
	});

	test('目录名与 ID 尾段一致的扩展（codebuddy）旧逻辑能命中 —— 所以 bug 只在 pocket 这类命名下暴露', () => {
		assert.strictEqual(
			legacyFuzzyMatch('codebuddy-provider', 'g:/ws/extensions/codebuddy-provider/plugin', 'saros.saros-codebuddy-provider', 'CodeBuddy Provider'),
			true,
		);
	});

	test('确定性归属判定：插件目录位于扩展目录之内', () => {
		assert.strictEqual(isEqualOrParent(pluginUri, extLocation), true, '插件 /plugin 子目录属于宿主扩展');
		assert.strictEqual(isEqualOrParent(extLocation, extLocation), true, '扩展目录自身（path 指向扩展根）也算宿主');
		assert.strictEqual(isEqualOrParent(URI.file('g:/ws/extensions/other/plugin'), extLocation), false, '别的扩展不得被认作宿主');
	});

	test('接线：详情页以宿主关系为最高优先级，两处查找都走候选列表', () => {
		const src = readSource(PANE_REL);
		assert.ok(src.includes("import { isEqualOrParent } from '../../../../base/common/resources.js'"), '必须用 URI 包含关系判定归属');
		assert.ok(src.includes('return isEqualOrParent(plugin.uri, extensionLocation);'), '宿主判定实现');
		assert.strictEqual(
			(src.match(/_candidateExtensions\(plugin\)/g) ?? []).length,
			2,
			'配置项与 model.json 两处查找都必须走候选列表（宿主扩展优先）',
		);
		assert.ok(
			!src.includes('for (const ext of this.extensionService.extensions)'),
			'不得回退为直接遍历全部扩展 —— 模糊匹配覆盖不了「目录名 ≠ 包名」',
		);
	});

	test('label 语义来自发现器：上游若改动，本测试会提醒重新评估匹配策略', () => {
		const src = readSource(DISCOVERY_REL);
		assert.ok(src.includes('label: fromMarketplace?.name ?? basename(parentUri)'), 'label = basename(插件目录的父目录)');
	});
});
