"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.equals = void 0;
exports.strictEquals = strictEquals;
exports.strictEqualsC = strictEqualsC;
exports.arrayEquals = arrayEquals;
exports.arrayEqualsC = arrayEqualsC;
exports.structuralEquals = structuralEquals;
exports.structuralEqualsC = structuralEqualsC;
exports.getStructuralKey = getStructuralKey;
exports.jsonStringifyEquals = jsonStringifyEquals;
exports.jsonStringifyEqualsC = jsonStringifyEqualsC;
exports.thisEqualsC = thisEqualsC;
exports.equalsIfDefined = equalsIfDefined;
exports.equalsIfDefinedC = equalsIfDefinedC;
const arrays = __importStar(require("./arrays.js"));
/**
 * Compares two items for equality using strict equality.
*/
function strictEquals(a, b) {
    return a === b;
}
function strictEqualsC() {
    return (a, b) => a === b;
}
/**
 * Checks if the items of two arrays are equal.
 * By default, strict equality is used to compare elements, but a custom equality comparer can be provided.
 */
function arrayEquals(a, b, itemEquals) {
    return arrays.equals(a, b, itemEquals ?? strictEquals);
}
/**
 * Checks if the items of two arrays are equal.
 * By default, strict equality is used to compare elements, but a custom equality comparer can be provided.
 */
function arrayEqualsC(itemEquals) {
    return (a, b) => arrays.equals(a, b, itemEquals ?? strictEquals);
}
/**
 * Drills into arrays (items ordered) and objects (keys unordered) and uses strict equality on everything else.
*/
function structuralEquals(a, b) {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!structuralEquals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    if (a && typeof a === 'object' && b && typeof b === 'object') {
        if (Object.getPrototypeOf(a) === Object.prototype && Object.getPrototypeOf(b) === Object.prototype) {
            const aObj = a;
            const bObj = b;
            const keysA = Object.keys(aObj);
            const keysB = Object.keys(bObj);
            const keysBSet = new Set(keysB);
            if (keysA.length !== keysB.length) {
                return false;
            }
            for (const key of keysA) {
                if (!keysBSet.has(key)) {
                    return false;
                }
                if (!structuralEquals(aObj[key], bObj[key])) {
                    return false;
                }
            }
            return true;
        }
    }
    return false;
}
function structuralEqualsC() {
    return (a, b) => structuralEquals(a, b);
}
/**
 * `getStructuralKey(a) === getStructuralKey(b) <=> structuralEquals(a, b)`
 * (assuming that a and b are not cyclic structures and nothing extends globalThis Array).
*/
function getStructuralKey(t) {
    return JSON.stringify(toNormalizedJsonStructure(t));
}
let objectId = 0;
const objIds = new WeakMap();
function toNormalizedJsonStructure(t) {
    if (Array.isArray(t)) {
        return t.map(toNormalizedJsonStructure);
    }
    if (t && typeof t === 'object') {
        if (Object.getPrototypeOf(t) === Object.prototype) {
            const tObj = t;
            const res = Object.create(null);
            for (const key of Object.keys(tObj).sort()) {
                res[key] = toNormalizedJsonStructure(tObj[key]);
            }
            return res;
        }
        else {
            let objId = objIds.get(t);
            if (objId === undefined) {
                objId = objectId++;
                objIds.set(t, objId);
            }
            // Random string to prevent collisions
            return objId + '----2b76a038c20c4bcc';
        }
    }
    return t;
}
/**
 * Two items are considered equal, if their stringified representations are equal.
*/
function jsonStringifyEquals(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
/**
 * Two items are considered equal, if their stringified representations are equal.
*/
function jsonStringifyEqualsC() {
    return (a, b) => JSON.stringify(a) === JSON.stringify(b);
}
/**
 * Uses `item.equals(other)` to determine equality.
 */
function thisEqualsC() {
    return (a, b) => a.equals(b);
}
/**
 * Checks if two items are both null or undefined, or are equal according to the provided equality comparer.
*/
function equalsIfDefined(v1, v2, equals) {
    if (v1 === undefined || v1 === null || v2 === undefined || v2 === null) {
        return v2 === v1;
    }
    return equals(v1, v2);
}
/**
 * Returns an equality comparer that checks if two items are both null or undefined, or are equal according to the provided equality comparer.
*/
function equalsIfDefinedC(equals) {
    return (v1, v2) => {
        if (v1 === undefined || v1 === null || v2 === undefined || v2 === null) {
            return v2 === v1;
        }
        return equals(v1, v2);
    };
}
/**
 * Each function in this file which offers an equality comparison, has an accompanying
 * `*C` variant which returns an EqualityComparer function.
 *
 * The `*C` variant allows for easier composition of equality comparers and improved type-inference.
*/
var equals;
(function (equals) {
    equals.strict = strictEquals;
    equals.strictC = strictEqualsC;
    equals.array = arrayEquals;
    equals.arrayC = arrayEqualsC;
    equals.structural = structuralEquals;
    equals.structuralC = structuralEqualsC;
    equals.jsonStringify = jsonStringifyEquals;
    equals.jsonStringifyC = jsonStringifyEqualsC;
    equals.thisC = thisEqualsC;
    equals.ifDefined = equalsIfDefined;
    equals.ifDefinedC = equalsIfDefinedC;
})(equals || (exports.equals = equals = {}));
