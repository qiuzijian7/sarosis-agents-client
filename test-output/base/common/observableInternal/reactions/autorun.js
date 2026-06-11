"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.autorun = autorun;
exports.autorunOpts = autorunOpts;
exports.autorunHandleChanges = autorunHandleChanges;
exports.autorunWithStoreHandleChanges = autorunWithStoreHandleChanges;
exports.autorunWithStore = autorunWithStore;
exports.autorunDelta = autorunDelta;
exports.autorunIterableDelta = autorunIterableDelta;
exports.autorunPerKeyedItem = autorunPerKeyedItem;
exports.autorunSelfDisposable = autorunSelfDisposable;
const deps_js_1 = require("../commonFacade/deps.js");
const debugName_js_1 = require("../debugName.js");
const autorunImpl_js_1 = require("./autorunImpl.js");
const debugLocation_js_1 = require("../debugLocation.js");
const observableValue_js_1 = require("../observables/observableValue.js");
const transaction_js_1 = require("../transaction.js");
/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 */
function autorun(fn, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    return new autorunImpl_js_1.AutorunObserver(new debugName_js_1.DebugNameData(undefined, undefined, fn), fn, undefined, debugLocation);
}
/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 */
function autorunOpts(options, fn, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    return new autorunImpl_js_1.AutorunObserver(new debugName_js_1.DebugNameData(options.owner, options.debugName, options.debugReferenceFn ?? fn), fn, undefined, debugLocation);
}
/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 *
 * Use `changeTracker.createChangeSummary` to create a "change summary" that can collect the changes.
 * Use `changeTracker.handleChange` to add a reported change to the change summary.
 * The run function is given the last change summary.
 * The change summary is discarded after the run function was called.
 *
 * @see autorun
 */
function autorunHandleChanges(options, fn, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    return new autorunImpl_js_1.AutorunObserver(new debugName_js_1.DebugNameData(options.owner, options.debugName, options.debugReferenceFn ?? fn), fn, options.changeTracker, debugLocation);
}
/**
 * @see autorunHandleChanges (but with a disposable store that is cleared before the next run or on dispose)
 */
function autorunWithStoreHandleChanges(options, fn) {
    const store = new deps_js_1.DisposableStore();
    const disposable = autorunHandleChanges({
        owner: options.owner,
        debugName: options.debugName,
        debugReferenceFn: options.debugReferenceFn ?? fn,
        changeTracker: options.changeTracker,
    }, (reader, changeSummary) => {
        store.clear();
        fn(reader, changeSummary, store);
    });
    return (0, deps_js_1.toDisposable)(() => {
        disposable.dispose();
        store.dispose();
    });
}
/**
 * @see autorun (but with a disposable store that is cleared before the next run or on dispose)
 *
 * @deprecated Use `autorun(reader => { reader.store.add(...) })` instead!
 */
function autorunWithStore(fn) {
    const store = new deps_js_1.DisposableStore();
    const disposable = autorunOpts({
        owner: undefined,
        debugName: undefined,
        debugReferenceFn: fn,
    }, reader => {
        store.clear();
        fn(reader, store);
    });
    return (0, deps_js_1.toDisposable)(() => {
        disposable.dispose();
        store.dispose();
    });
}
function autorunDelta(observable, handler) {
    let _lastValue;
    return autorunOpts({ debugReferenceFn: handler }, (reader) => {
        const newValue = observable.read(reader);
        const lastValue = _lastValue;
        _lastValue = newValue;
        handler({ lastValue, newValue });
    });
}
function autorunIterableDelta(getValue, handler, getUniqueIdentifier = v => v) {
    const lastValues = new Map();
    return autorunOpts({ debugReferenceFn: getValue }, (reader) => {
        const newValues = new Map();
        const removedValues = new Map(lastValues);
        for (const value of getValue(reader)) {
            const id = getUniqueIdentifier(value);
            if (lastValues.has(id)) {
                removedValues.delete(id);
            }
            else {
                newValues.set(id, value);
                lastValues.set(id, value);
            }
        }
        for (const id of removedValues.keys()) {
            lastValues.delete(id);
        }
        if (newValues.size || removedValues.size) {
            handler({ addedValues: [...newValues.values()], removedValues: [...removedValues.values()] });
        }
    });
}
/**
 * For each key-stable item in {@link items}, runs {@link setup} once when the
 * key is first observed and disposes the per-key {@link DisposableStore} when
 * the key is no longer present in the array (or when the returned disposable
 * is disposed).
 *
 * The {@link IObservable} handed to {@link setup} fires whenever the array
 * still contains an item with the same key but the item value itself has
 * changed (e.g. because the upstream state is immutable and produced a new
 * object with the same id). All per-key value updates triggered by a single
 * change to {@link items} are batched into one transaction, so dependent
 * autoruns observe a consistent snapshot.
 *
 * Per-key state should be stored in closures or in disposables registered
 * against the per-key {@link DisposableStore}. {@link setup} should not call
 * `.read()` on the outer {@link items} observable from its body (use the
 * provided per-key value observable, or create inner autoruns).
 */
function autorunPerKeyedItem(items, keyFn, setup, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    const cells = new Map();
    const ar = autorunOpts({ debugReferenceFn: setup }, reader => {
        const arr = items.read(reader);
        const seen = new Set();
        const additions = [];
        (0, transaction_js_1.transaction)(tx => {
            for (const item of arr) {
                const key = keyFn(item);
                seen.add(key);
                const existing = cells.get(key);
                if (existing) {
                    existing.value.set(item, tx);
                }
                else {
                    const store = new deps_js_1.DisposableStore();
                    const value = (0, observableValue_js_1.observableValue)('keyedItem', item);
                    const cell = { value, store };
                    cells.set(key, cell);
                    additions.push({ key, cell });
                }
            }
            for (const [k, cell] of cells) {
                if (!seen.has(k)) {
                    cell.store.dispose();
                    cells.delete(k);
                }
            }
        });
        // Setup runs after the transaction so per-key autoruns observe the
        // final cell values on their first read.
        for (const { key, cell } of additions) {
            setup(key, cell.value, cell.store);
        }
    }, debugLocation);
    return (0, deps_js_1.toDisposable)(() => {
        ar.dispose();
        for (const cell of cells.values()) {
            cell.store.dispose();
        }
        cells.clear();
    });
}
/**
 * An autorun with a `dispose()` method on its `reader` which cancels the autorun.
 * It it safe to call `dispose()` synchronously.
 */
function autorunSelfDisposable(fn, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    let ar;
    let disposed = false;
    // eslint-disable-next-line prefer-const
    ar = autorun(reader => {
        fn({
            delayedStore: reader.delayedStore,
            store: reader.store,
            readObservable: reader.readObservable.bind(reader),
            dispose: () => {
                ar?.dispose();
                disposed = true;
            }
        });
    }, debugLocation);
    if (disposed) {
        ar.dispose();
    }
    return ar;
}
