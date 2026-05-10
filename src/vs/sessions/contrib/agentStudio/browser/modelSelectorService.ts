/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelSelectorService, IModelSelectorItem } from '../common/modelSelector.js';
import { IModelSelection } from '../common/providers.js';

export class ModelSelectorService extends Disposable implements IModelSelectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IModelSelection>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	constructor() {
		super();
	}

	getSelection(): IModelSelection | undefined { return undefined; }
	setSelection(s: IModelSelection): void { }
	getAvailableModels(): IModelSelectorItem[] { return []; }
	showQuickPick(): Promise<IModelSelection | undefined> { return Promise.resolve(undefined); }
	openSettings(_id?: string): void { }
}
