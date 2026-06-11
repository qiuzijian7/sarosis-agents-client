"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.toResource = toResource;
exports.suiteRepeat = suiteRepeat;
exports.testRepeat = testRepeat;
exports.assertThrowsAsync = assertThrowsAsync;
exports.ensureNoDisposablesAreLeakedInTestSuite = ensureNoDisposablesAreLeakedInTestSuite;
exports.throwIfDisposablesAreLeaked = throwIfDisposablesAreLeaked;
exports.throwIfDisposablesAreLeakedAsync = throwIfDisposablesAreLeakedAsync;
const lifecycle_js_1 = require("../../common/lifecycle.js");
const path_js_1 = require("../../common/path.js");
const platform_js_1 = require("../../common/platform.js");
const uri_js_1 = require("../../common/uri.js");
function toResource(path) {
    if (platform_js_1.isWindows) {
        return uri_js_1.URI.file((0, path_js_1.join)('C:\\', btoa(this.test.fullTitle()), path));
    }
    return uri_js_1.URI.file((0, path_js_1.join)('/', btoa(this.test.fullTitle()), path));
}
function suiteRepeat(n, description, callback) {
    for (let i = 0; i < n; i++) {
        suite(`${description} (iteration ${i})`, callback);
    }
}
function testRepeat(n, description, callback) {
    for (let i = 0; i < n; i++) {
        test(`${description} (iteration ${i})`, callback);
    }
}
async function assertThrowsAsync(block, message = 'Missing expected exception') {
    try {
        await block();
    }
    catch {
        return;
    }
    const err = message instanceof Error ? message : new Error(message);
    throw err;
}
/**
 * Use this function to ensure that all disposables are cleaned up at the end of each test in the current suite.
 *
 * Use `markAsSingleton` if disposable singletons are created lazily that are allowed to outlive the test.
 * Make sure that the singleton properly registers all child disposables so that they are excluded too.
 *
 * @returns A {@link DisposableStore} that can optionally be used to track disposables in the test.
 * This will be automatically disposed on test teardown.
*/
function ensureNoDisposablesAreLeakedInTestSuite() {
    let tracker;
    let store;
    setup(() => {
        store = new lifecycle_js_1.DisposableStore();
        tracker = new lifecycle_js_1.DisposableTracker();
        (0, lifecycle_js_1.setDisposableTracker)(tracker);
    });
    teardown(function () {
        store.dispose();
        (0, lifecycle_js_1.setDisposableTracker)(null);
        if (this.currentTest?.state !== 'failed') {
            const result = tracker.computeLeakingDisposables();
            if (result) {
                console.error(result.details);
                throw new Error(`There are ${result.leaks.length} undisposed disposables!${result.details}`);
            }
        }
    });
    // Wrap store as the suite function is called before it's initialized
    const testContext = {
        add(o) {
            return store.add(o);
        }
    };
    return testContext;
}
function throwIfDisposablesAreLeaked(body, logToConsole = true) {
    const tracker = new lifecycle_js_1.DisposableTracker();
    (0, lifecycle_js_1.setDisposableTracker)(tracker);
    body();
    (0, lifecycle_js_1.setDisposableTracker)(null);
    computeLeakingDisposables(tracker, logToConsole);
}
async function throwIfDisposablesAreLeakedAsync(body) {
    const tracker = new lifecycle_js_1.DisposableTracker();
    (0, lifecycle_js_1.setDisposableTracker)(tracker);
    await body();
    (0, lifecycle_js_1.setDisposableTracker)(null);
    computeLeakingDisposables(tracker);
}
function computeLeakingDisposables(tracker, logToConsole = true) {
    const result = tracker.computeLeakingDisposables();
    if (result) {
        if (logToConsole) {
            console.error(result.details);
        }
        throw new Error(`There are ${result.leaks.length} undisposed disposables!${result.details}`);
    }
}
