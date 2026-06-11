"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.constObservable = constObservable;
const baseObservable_js_1 = require("./baseObservable.js");
/**
 * Represents an efficient observable whose value never changes.
 */
function constObservable(value) {
    return new ConstObservable(value);
}
class ConstObservable extends baseObservable_js_1.ConvenientObservable {
    value;
    constructor(value) {
        super();
        this.value = value;
    }
    get debugName() {
        return this.toString();
    }
    get() {
        return this.value;
    }
    addObserver(observer) {
        // NO OP
    }
    removeObserver(observer) {
        // NO OP
    }
    log() {
        return this;
    }
    toString() {
        return `Const: ${this.value}`;
    }
}
