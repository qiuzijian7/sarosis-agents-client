/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 注册「dsh 插件页的编辑区承载」（2026-10-13，用户 D1=A）。
 *
 * 独立成文件 + 模块加载即注册（与 `agentStudio.contribution.ts` 那批 `registerEditorPane` 同款）：
 * 本模块被 `dshHarness.contribution.ts` **side-effect import** 一次即可，注册点不必散落在那份大文件里 ✓。
 *
 * ⚠ 编辑器的**类型描述**（第三个参数）只是注册表里的名字，用户在标签上看到的是输入自己的
 *   `getName()`（取自容器表的 title，如「主页」）⇒ 两者不是一个东西 ✓。
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { DshPluginPageEditorInput } from './dshPluginPageEditorInput.js';
import { DshPluginPageEditorPane } from './dshPluginPageEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DshPluginPageEditorPane, DshPluginPageEditorPane.ID, 'Dsh Module Page'),
	[new SyncDescriptor(DshPluginPageEditorInput)],
);
