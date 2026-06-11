"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.observableSignal = observableSignal;
const transaction_js_1 = require("../transaction.js");
const debugName_js_1 = require("../debugName.js");
const baseObservable_js_1 = require("./baseObservable.js");
const debugLocation_js_1 = require("../debugLocation.js");
function observableSignal(debugNameOrOwner, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    if (typeof debugNameOrOwner === 'string') {
        return new ObservableSignal(debugNameOrOwner, undefined, debugLocation);
    }
    else {
        return new ObservableSignal(undefined, debugNameOrOwner, debugLocation);
    }
}
class ObservableSignal extends baseObservable_js_1.BaseObservable {
    _debugName;
    _owner;
    get debugName() {
        return new debugName_js_1.DebugNameData(this._owner, this._debugName, undefined).getDebugName(this) ?? 'Observable Signal';
    }
    toString() {
        return this.debugName;
    }
    constructor(_debugName, _owner, debugLocation) {
        super(debugLocation);
        this._debugName = _debugName;
        this._owner = _owner;
    }
    trigger(tx, change) {
        if (!tx) {
            (0, transaction_js_1.transaction)(tx => {
                this.trigger(tx, change);
            }, () => `Trigger signal ${this.debugName}`);
            return;
        }
        for (const o of this._observers) {
            tx.updateObserver(o, this);
            o.handleChange(this, change);
        }
    }
    get() {
        // NO OP
    }
}
