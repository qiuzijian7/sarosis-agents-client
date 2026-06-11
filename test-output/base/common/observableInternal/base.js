"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBugIndicatingErrorRecovery = handleBugIndicatingErrorRecovery;
const deps_js_1 = require("./commonFacade/deps.js");
/**
 * This function is used to indicate that the caller recovered from an error that indicates a bug.
*/
function handleBugIndicatingErrorRecovery(message) {
    const err = new Error('BugIndicatingErrorRecovery: ' + message);
    (0, deps_js_1.onUnexpectedError)(err);
    console.error('recovered from an error that indicates a bug', err);
}
