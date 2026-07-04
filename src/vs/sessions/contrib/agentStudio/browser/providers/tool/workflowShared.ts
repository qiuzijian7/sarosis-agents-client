/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared workflow utilities — extracted from builtinToolProvider.ts to break
 * a cyclic dependency between builtinToolProvider.ts ↔ workflowTools.ts.
 */

import { Emitter } from '../../../../../../base/common/event.js';
import type { IStoredWorkflow } from '../../../common/workflowStorage.js';

/**
 * Workflow applied event emitter.
 * The controller subscribes to `.event`; the workflow_apply handler fires it.
 */
export const workflowAppliedEmitter = new Emitter<{ workflow: IStoredWorkflow; description?: string }>();
