"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservableMap = void 0;
const observableValueOpts_js_1 = require("./observables/observableValueOpts.js");
class ObservableMap {
    _data = new Map();
    _obs = (0, observableValueOpts_js_1.observableValueOpts)({ equalsFn: () => false }, this);
    observable = this._obs;
    get size() {
        return this._data.size;
    }
    has(key) {
        return this._data.has(key);
    }
    get(key) {
        return this._data.get(key);
    }
    set(key, value, tx) {
        const hadKey = this._data.has(key);
        const oldValue = this._data.get(key);
        if (!hadKey || oldValue !== value) {
            this._data.set(key, value);
            this._obs.set(this, tx);
        }
        return this;
    }
    delete(key, tx) {
        const result = this._data.delete(key);
        if (result) {
            this._obs.set(this, tx);
        }
        return result;
    }
    clear(tx) {
        if (this._data.size > 0) {
            this._data.clear();
            this._obs.set(this, tx);
        }
    }
    forEach(callbackfn, thisArg) {
        this._data.forEach((value, key, _map) => {
            callbackfn.call(thisArg, value, key, this);
        });
    }
    *entries() {
        yield* this._data.entries();
    }
    *keys() {
        yield* this._data.keys();
    }
    *values() {
        yield* this._data.values();
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    get [Symbol.toStringTag]() {
        return 'ObservableMap';
    }
}
exports.ObservableMap = ObservableMap;
