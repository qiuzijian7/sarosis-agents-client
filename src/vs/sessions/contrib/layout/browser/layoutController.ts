/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';

/**
 * Layout controller for the sessions workbench.
 * In the current two-column layout (Sidebar | Editor), there are no Panel or AuxiliaryBar
 * parts to manage. Agent Studio views are EditorPanes in the editor area.
 */
export class LayoutController extends Disposable {

	static readonly ID = 'workbench.contrib.sessionsLayoutController';

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ISessionsManagementService private readonly _sessionManagementService: ISessionsManagementService,
		@IChatService private readonly _chatService: IChatService,
		@IViewsService private readonly _viewsService: IViewsService,
	) {
		super();
		// No-op: In the two-column layout, there are no Panel/AuxiliaryBar parts to control.
		// Agent Studio panels (Chat, TaskBoard, Canvas) are permanent EditorPanes in the editor area.
		void this._layoutService;
		void this._sessionManagementService;
		void this._chatService;
		void this._viewsService;
	}
}
