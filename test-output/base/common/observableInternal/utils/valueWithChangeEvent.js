"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValueWithChangeEventFromObservable = void 0;
exports.observableFromValueWithChangeEvent = observableFromValueWithChangeEvent;
const deps_js_1 = require("../commonFacade/deps.js");
const observableFromEvent_js_1 = require("../observables/observableFromEvent.js");
class ValueWithChangeEventFromObservable {
    observable;
    constructor(observable) {
        this.observable = observable;
    }
    get onDidChange() {
        return deps_js_1.Event.fromObservableLight(this.observable);
    }
    get value() {
        return this.observable.get();
    }
}
exports.ValueWithChangeEventFromObservable = ValueWithChangeEventFromObservable;
function observableFromValueWithChangeEvent(owner, value) {
    if (value instanceof ValueWithChangeEventFromObservable) {
        return value.observable;
    }
    return (0, observableFromEvent_js_1.observableFromEvent)(owner, value.onDidChange, () => value.value);
}
