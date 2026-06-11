"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeepAliveObserver = void 0;
exports.observableFromPromise = observableFromPromise;
exports.signalFromObservable = signalFromObservable;
exports.debouncedObservable = debouncedObservable;
exports.throttledObservable = throttledObservable;
exports.debouncedObservable2 = debouncedObservable2;
exports.wasEventTriggeredRecently = wasEventTriggeredRecently;
exports.keepObserved = keepObserved;
exports.recomputeInitiallyAndOnChange = recomputeInitiallyAndOnChange;
exports.derivedObservableWithCache = derivedObservableWithCache;
exports.derivedObservableWithWritableCache = derivedObservableWithWritableCache;
exports.mapObservableArrayCached = mapObservableArrayCached;
exports.isObservable = isObservable;
const autorun_js_1 = require("../reactions/autorun.js");
const observableValue_js_1 = require("../observables/observableValue.js");
const deps_js_1 = require("../commonFacade/deps.js");
const derived_js_1 = require("../observables/derived.js");
const observableFromEvent_js_1 = require("../observables/observableFromEvent.js");
const observableSignal_js_1 = require("../observables/observableSignal.js");
const baseObservable_js_1 = require("../observables/baseObservable.js");
const debugLocation_js_1 = require("../debugLocation.js");
function observableFromPromise(promise) {
    const observable = (0, observableValue_js_1.observableValue)('promiseValue', {});
    promise.then((value) => {
        observable.set({ value }, undefined);
    });
    return observable;
}
function signalFromObservable(owner, observable) {
    return (0, derived_js_1.derivedOpts)({
        owner,
        equalsFn: () => false,
    }, reader => {
        observable.read(reader);
    });
}
/**
 * Creates an observable that debounces the input observable.
 */
function debouncedObservable(observable, debounceMs, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    let hasValue = false;
    let lastValue;
    let timeout = undefined;
    return (0, observableFromEvent_js_1.observableFromEvent)(undefined, cb => {
        const d = (0, autorun_js_1.autorun)(reader => {
            const value = observable.read(reader);
            if (!hasValue) {
                hasValue = true;
                lastValue = value;
            }
            else {
                if (timeout) {
                    clearTimeout(timeout);
                }
                const debounceDuration = typeof debounceMs === 'number' ? debounceMs : debounceMs(lastValue, value);
                if (debounceDuration === 0) {
                    lastValue = value;
                    cb();
                    return;
                }
                timeout = setTimeout(() => {
                    lastValue = value;
                    cb();
                }, debounceDuration);
            }
        });
        return {
            dispose() {
                d.dispose();
                hasValue = false;
                lastValue = undefined;
            },
        };
    }, () => {
        if (hasValue) {
            return lastValue;
        }
        else {
            return observable.get();
        }
    }, debugLocation);
}
/**
 * Creates an observable that throttles the input observable.
 * Unlike {@link debouncedObservable}, the timer starts on the first change
 * and is not reset by subsequent changes, preventing starvation.
 */
function throttledObservable(observable, throttleMs, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    let hasValue = false;
    let lastValue;
    let timeout = undefined;
    return (0, observableFromEvent_js_1.observableFromEvent)(undefined, cb => {
        const d = (0, autorun_js_1.autorun)(reader => {
            const value = observable.read(reader);
            if (!hasValue) {
                hasValue = true;
                lastValue = value;
            }
            else if (!timeout) {
                // Only start a timer if one isn't already running
                timeout = setTimeout(() => {
                    timeout = undefined;
                    lastValue = observable.read(undefined);
                    cb();
                }, throttleMs);
            }
        });
        return {
            dispose() {
                d.dispose();
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                hasValue = false;
                lastValue = undefined;
            },
        };
    }, () => {
        if (hasValue) {
            return lastValue;
        }
        else {
            return observable.get();
        }
    }, debugLocation);
}
/**
 * Creates an observable that debounces the input observable.
 */
function debouncedObservable2(observable, debounceMs, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    const s = (0, observableSignal_js_1.observableSignal)('handleTimeout');
    let currentValue = undefined;
    let timeout = undefined;
    const d = (0, derived_js_1.derivedOpts)({
        owner: undefined,
        onLastObserverRemoved: () => {
            currentValue = undefined;
        }
    }, reader => {
        const val = observable.read(reader);
        s.read(reader);
        if (val !== currentValue) {
            const debounceDuration = typeof debounceMs === 'number' ? debounceMs : debounceMs(currentValue, val);
            if (debounceDuration === 0) {
                currentValue = val;
                return val;
            }
            if (timeout) {
                clearTimeout(timeout);
            }
            timeout = setTimeout(() => {
                currentValue = val;
                s.trigger(undefined);
            }, debounceDuration);
        }
        return currentValue;
    }, debugLocation);
    return d;
}
function wasEventTriggeredRecently(event, timeoutMs, disposableStore) {
    const observable = (0, observableValue_js_1.observableValue)('triggeredRecently', false);
    let timeout = undefined;
    disposableStore.add(event(() => {
        observable.set(true, undefined);
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            observable.set(false, undefined);
        }, timeoutMs);
    }));
    return observable;
}
/**
 * This makes sure the observable is being observed and keeps its cache alive.
 */
function keepObserved(observable) {
    const o = new KeepAliveObserver(false, undefined);
    observable.addObserver(o);
    return (0, deps_js_1.toDisposable)(() => {
        observable.removeObserver(o);
    });
}
(0, baseObservable_js_1._setKeepObserved)(keepObserved);
/**
 * This converts the given observable into an autorun.
 */
function recomputeInitiallyAndOnChange(observable, handleValue) {
    const o = new KeepAliveObserver(true, handleValue);
    observable.addObserver(o);
    try {
        o.beginUpdate(observable);
    }
    finally {
        o.endUpdate(observable);
    }
    return (0, deps_js_1.toDisposable)(() => {
        observable.removeObserver(o);
    });
}
(0, baseObservable_js_1._setRecomputeInitiallyAndOnChange)(recomputeInitiallyAndOnChange);
class KeepAliveObserver {
    _forceRecompute;
    _handleValue;
    _counter = 0;
    constructor(_forceRecompute, _handleValue) {
        this._forceRecompute = _forceRecompute;
        this._handleValue = _handleValue;
    }
    beginUpdate(observable) {
        this._counter++;
    }
    endUpdate(observable) {
        if (this._counter === 1 && this._forceRecompute) {
            if (this._handleValue) {
                this._handleValue(observable.get());
            }
            else {
                observable.reportChanges();
            }
        }
        this._counter--;
    }
    handlePossibleChange(observable) {
        // NO OP
    }
    handleChange(observable, change) {
        // NO OP
    }
}
exports.KeepAliveObserver = KeepAliveObserver;
function derivedObservableWithCache(owner, computeFn) {
    let lastValue = undefined;
    const observable = (0, derived_js_1.derivedOpts)({ owner, debugReferenceFn: computeFn }, reader => {
        lastValue = computeFn(reader, lastValue);
        return lastValue;
    });
    return observable;
}
function derivedObservableWithWritableCache(owner, computeFn) {
    let lastValue = undefined;
    const onChange = (0, observableSignal_js_1.observableSignal)('derivedObservableWithWritableCache');
    const observable = (0, derived_js_1.derived)(owner, reader => {
        onChange.read(reader);
        lastValue = computeFn(reader, lastValue);
        return lastValue;
    });
    return Object.assign(observable, {
        clearCache: (tx) => {
            lastValue = undefined;
            onChange.trigger(tx);
        },
        setCache: (newValue, tx) => {
            lastValue = newValue;
            onChange.trigger(tx);
        }
    });
}
/**
 * When the items array changes, referential equal items are not mapped again.
 */
function mapObservableArrayCached(owner, items, map, keySelector) {
    let m = new ArrayMap(map, keySelector);
    const self = (0, derived_js_1.derivedOpts)({
        debugReferenceFn: map,
        owner,
        onLastObserverRemoved: () => {
            m.dispose();
            m = new ArrayMap(map);
        }
    }, (reader) => {
        const i = items.read(reader);
        m.setItems(i);
        return m.getItems();
    });
    return self;
}
class ArrayMap {
    _map;
    _keySelector;
    _cache = new Map();
    _items = [];
    constructor(_map, _keySelector) {
        this._map = _map;
        this._keySelector = _keySelector;
    }
    dispose() {
        this._cache.forEach(entry => entry.store.dispose());
        this._cache.clear();
    }
    setItems(items) {
        const newItems = [];
        const itemsToRemove = new Set(this._cache.keys());
        for (const item of items) {
            const key = this._keySelector ? this._keySelector(item) : item;
            let entry = this._cache.get(key);
            if (!entry) {
                const store = new deps_js_1.DisposableStore();
                const out = this._map(item, store);
                entry = { out, store };
                this._cache.set(key, entry);
            }
            else {
                itemsToRemove.delete(key);
            }
            newItems.push(entry.out);
        }
        for (const item of itemsToRemove) {
            const entry = this._cache.get(item);
            entry.store.dispose();
            this._cache.delete(item);
        }
        this._items = newItems;
    }
    getItems() {
        return this._items;
    }
}
function isObservable(obj) {
    return !!obj && obj.read !== undefined && obj.reportChanges !== undefined;
}
