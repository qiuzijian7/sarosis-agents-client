"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisposableObservableValue = exports.ObservableValue = void 0;
exports.observableValue = observableValue;
exports.disposableObservableValue = disposableObservableValue;
const transaction_js_1 = require("../transaction.js");
const baseObservable_js_1 = require("./baseObservable.js");
const deps_js_1 = require("../commonFacade/deps.js");
const debugName_js_1 = require("../debugName.js");
const logging_js_1 = require("../logging/logging.js");
const debugLocation_js_1 = require("../debugLocation.js");
function observableValue(nameOrOwner, initialValue, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    let debugNameData;
    if (typeof nameOrOwner === 'string') {
        debugNameData = new debugName_js_1.DebugNameData(undefined, nameOrOwner, undefined);
    }
    else {
        debugNameData = new debugName_js_1.DebugNameData(nameOrOwner, undefined, undefined);
    }
    return new ObservableValue(debugNameData, initialValue, deps_js_1.strictEquals, debugLocation);
}
class ObservableValue extends baseObservable_js_1.BaseObservable {
    _debugNameData;
    _equalityComparator;
    _value;
    get debugName() {
        return this._debugNameData.getDebugName(this) ?? 'ObservableValue';
    }
    constructor(_debugNameData, initialValue, _equalityComparator, debugLocation) {
        super(debugLocation);
        this._debugNameData = _debugNameData;
        this._equalityComparator = _equalityComparator;
        this._value = initialValue;
        (0, logging_js_1.getLogger)()?.handleObservableUpdated(this, { hadValue: false, newValue: initialValue, change: undefined, didChange: true, oldValue: undefined });
    }
    get() {
        return this._value;
    }
    set(value, tx, change) {
        if (change === undefined && this._equalityComparator(this._value, value)) {
            return;
        }
        let _tx;
        if (!tx) {
            tx = _tx = new transaction_js_1.TransactionImpl(() => { }, () => `Setting ${this.debugName}`);
        }
        try {
            const oldValue = this._value;
            this._setValue(value);
            (0, logging_js_1.getLogger)()?.handleObservableUpdated(this, { oldValue, newValue: value, change, didChange: true, hadValue: true });
            for (const observer of this._observers) {
                tx.updateObserver(observer, this);
                observer.handleChange(this, change);
            }
        }
        finally {
            if (_tx) {
                _tx.finish();
            }
        }
    }
    toString() {
        return `${this.debugName}: ${this._value}`;
    }
    _setValue(newValue) {
        this._value = newValue;
    }
    debugGetState() {
        return {
            value: this._value,
        };
    }
    debugSetValue(value) {
        this._value = value;
    }
}
exports.ObservableValue = ObservableValue;
/**
 * A disposable observable. When disposed, its value is also disposed.
 * When a new value is set, the previous value is disposed.
 */
function disposableObservableValue(nameOrOwner, initialValue, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    let debugNameData;
    if (typeof nameOrOwner === 'string') {
        debugNameData = new debugName_js_1.DebugNameData(undefined, nameOrOwner, undefined);
    }
    else {
        debugNameData = new debugName_js_1.DebugNameData(nameOrOwner, undefined, undefined);
    }
    return new DisposableObservableValue(debugNameData, initialValue, deps_js_1.strictEquals, debugLocation);
}
class DisposableObservableValue extends ObservableValue {
    _setValue(newValue) {
        if (this._value === newValue) {
            return;
        }
        if (this._value) {
            this._value.dispose();
        }
        this._value = newValue;
    }
    dispose() {
        this._value?.dispose();
    }
}
exports.DisposableObservableValue = DisposableObservableValue;
