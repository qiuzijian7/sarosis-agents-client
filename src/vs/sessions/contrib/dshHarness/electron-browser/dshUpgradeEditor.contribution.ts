/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 注册「系统与更新」面板的编辑区承载（2026-10-30）。
 *
 * 独立成文件 + 模块加载即注册（与 `dshPluginPageEditor.contribution.ts` 同款）：
 * 被 `dshHarness.contribution.ts` **side-effect import** 一次即可。
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { DshUpgradeEditorInput } from './dshUpgradeEditorInput.js';
import { DshUpgradeEditorPane } from './dshUpgradeEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DshUpgradeEditorPane, DshUpgradeEditorPane.ID, 'System & Updates'),
	[new SyncDescriptor(DshUpgradeEditorInput)],
);
