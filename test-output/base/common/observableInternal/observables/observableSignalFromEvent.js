"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.observableSignalFromEvent = observableSignalFromEvent;
const transaction_js_1 = require("../transaction.js");
const debugName_js_1 = require("../debugName.js");
const baseObservable_js_1 = require("./baseObservable.js");
const debugLocation_js_1 = require("../debugLocation.js");
function observableSignalFromEvent(owner, event, debugLocation = debugLocation_js_1.DebugLocation.ofCaller()) {
    return new FromEventObservableSignal(typeof owner === 'string' ? owner : new debugName_js_1.DebugNameData(owner, undefined, undefined), event, debugLocation);
}
class FromEventObservableSignal extends baseObservable_js_1.BaseObservable {
    event;
    subscription;
    debugName;
    constructor(debugNameDataOrName, event, debugLocation) {
        super(debugLocation);
        this.event = event;
        this.debugName = typeof debugNameDataOrName === 'string'
            ? debugNameDataOrName
            : debugNameDataOrName.getDebugName(this) ?? 'Observable Signal From Event';
    }
    onFirstObserverAdded() {
        this.subscription = this.event(this.handleEvent);
    }
    handleEvent = () => {
        (0, transaction_js_1.transaction)((tx) => {
            for (const o of this._observers) {
                tx.updateObserver(o, this);
                o.handleChange(this, undefined);
            }
        }, () => this.debugName);
    };
    onLastObserverRemoved() {
        this.subscription.dispose();
        this.subscription = undefined;
    }
    get() {
        // NO OP
    }
}
