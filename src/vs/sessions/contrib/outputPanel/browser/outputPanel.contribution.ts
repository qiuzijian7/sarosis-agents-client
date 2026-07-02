/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions } from '../../../../workbench/common/views.js';
import { OUTPUT_VIEW_ID } from '../../../../workbench/services/output/common/output.js';
import { OutputViewPane } from '../../../../workbench/contrib/output/browser/outputView.js';
import { Codicon } from '../../../../base/common/codicons.js';

// [Sarosis] Register Output as a ViewContainer in the Panel (bottom area)
// In native VS Code, Output can be shown as an editor pane or in the Panel.
// This contribution registers it as a Panel viewlet so it appears in the Panel tab bar.
// NOTE: Container ID must differ from view ID — sharing the same ID breaks
// getViewContainerByViewId() because the registry can't distinguish them.

const OUTPUT_PANEL_CONTAINER_ID = 'sarosis.panel.output';
const OUTPUT_VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: OUTPUT_PANEL_CONTAINER_ID,
	title: nls.localize2('output', "Output"),
	icon: Codicon.output,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [OUTPUT_PANEL_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: OUTPUT_PANEL_CONTAINER_ID,
	hideIfEmpty: false,
	order: 1,
	windowEnablement: 3, // WindowEnablement.Both
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true, isDefault: true });

// Register the Output view inside the container
// Note: openCommandActionDescriptor is NOT set here because
// output.contribution.ts already registers the toggleOutput command.
// Setting it here would cause "Cannot register two commands with the same id" error.
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: OUTPUT_VIEW_ID,
	name: nls.localize2('output', "Output"),
	containerIcon: Codicon.output,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(OutputViewPane),
	windowEnablement: 3, // WindowEnablement.Both — required for Sessions window
}], OUTPUT_VIEW_CONTAINER);
