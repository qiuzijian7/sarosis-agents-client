"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOnChange = exports.ValueWithChangeEventFromObservable = exports.observableFromValueWithChangeEvent = exports.TransactionImpl = exports.transaction = exports.subtransaction = exports.globalTransaction = exports.asyncTransaction = exports.observableSignalFromEvent = exports.observableFromEventOpts = exports.observableSignal = exports.constObservable = exports.recordChangesLazy = exports.recordChanges = exports.isObservable = exports.wasEventTriggeredRecently = exports.throttledObservable = exports.signalFromObservable = exports.recomputeInitiallyAndOnChange = exports.observableFromPromise = exports.mapObservableArrayCached = exports.keepObserved = exports.derivedObservableWithWritableCache = exports.derivedObservableWithCache = exports.debouncedObservable2 = exports.debouncedObservable = exports.waitForState = exports.derivedWithCancellationToken = exports.PromiseResult = exports.ObservableResolvedPromise = exports.ObservablePromise = exports.ObservableLazyPromise = exports.ObservableLazy = exports.derivedWithStore = exports.derivedWithSetter = exports.derivedOpts = exports.derivedHandleChanges = exports.derivedDisposable = exports.derived = exports.disposableObservableValue = exports.autorunSelfDisposable = exports.autorunPerKeyedItem = exports.autorunIterableDelta = exports.autorunWithStoreHandleChanges = exports.autorunWithStore = exports.autorunOpts = exports.autorunHandleChanges = exports.autorunDelta = exports.autorun = exports.observableValueOpts = void 0;
exports.DebugLocation = exports.ObservableMap = exports.ObservableSet = exports.observableValue = exports.observableFromEvent = exports.latestChangedValue = exports.derivedConstOnceDefined = exports.runOnChangeWithStore = exports.runOnChangeWithCancellationToken = void 0;
// This is a facade for the observable implementation. Only import from here!
var observableValueOpts_js_1 = require("./observables/observableValueOpts.js");
Object.defineProperty(exports, "observableValueOpts", { enumerable: true, get: function () { return observableValueOpts_js_1.observableValueOpts; } });
var autorun_js_1 = require("./reactions/autorun.js");
Object.defineProperty(exports, "autorun", { enumerable: true, get: function () { return autorun_js_1.autorun; } });
Object.defineProperty(exports, "autorunDelta", { enumerable: true, get: function () { return autorun_js_1.autorunDelta; } });
Object.defineProperty(exports, "autorunHandleChanges", { enumerable: true, get: function () { return autorun_js_1.autorunHandleChanges; } });
Object.defineProperty(exports, "autorunOpts", { enumerable: true, get: function () { return autorun_js_1.autorunOpts; } });
Object.defineProperty(exports, "autorunWithStore", { enumerable: true, get: function () { return autorun_js_1.autorunWithStore; } });
Object.defineProperty(exports, "autorunWithStoreHandleChanges", { enumerable: true, get: function () { return autorun_js_1.autorunWithStoreHandleChanges; } });
Object.defineProperty(exports, "autorunIterableDelta", { enumerable: true, get: function () { return autorun_js_1.autorunIterableDelta; } });
Object.defineProperty(exports, "autorunPerKeyedItem", { enumerable: true, get: function () { return autorun_js_1.autorunPerKeyedItem; } });
Object.defineProperty(exports, "autorunSelfDisposable", { enumerable: true, get: function () { return autorun_js_1.autorunSelfDisposable; } });
var observableValue_js_1 = require("./observables/observableValue.js");
Object.defineProperty(exports, "disposableObservableValue", { enumerable: true, get: function () { return observableValue_js_1.disposableObservableValue; } });
var derived_js_1 = require("./observables/derived.js");
Object.defineProperty(exports, "derived", { enumerable: true, get: function () { return derived_js_1.derived; } });
Object.defineProperty(exports, "derivedDisposable", { enumerable: true, get: function () { return derived_js_1.derivedDisposable; } });
Object.defineProperty(exports, "derivedHandleChanges", { enumerable: true, get: function () { return derived_js_1.derivedHandleChanges; } });
Object.defineProperty(exports, "derivedOpts", { enumerable: true, get: function () { return derived_js_1.derivedOpts; } });
Object.defineProperty(exports, "derivedWithSetter", { enumerable: true, get: function () { return derived_js_1.derivedWithSetter; } });
Object.defineProperty(exports, "derivedWithStore", { enumerable: true, get: function () { return derived_js_1.derivedWithStore; } });
var promise_js_1 = require("./utils/promise.js");
Object.defineProperty(exports, "ObservableLazy", { enumerable: true, get: function () { return promise_js_1.ObservableLazy; } });
Object.defineProperty(exports, "ObservableLazyPromise", { enumerable: true, get: function () { return promise_js_1.ObservableLazyPromise; } });
Object.defineProperty(exports, "ObservablePromise", { enumerable: true, get: function () { return promise_js_1.ObservablePromise; } });
Object.defineProperty(exports, "ObservableResolvedPromise", { enumerable: true, get: function () { return promise_js_1.ObservableResolvedPromise; } });
Object.defineProperty(exports, "PromiseResult", { enumerable: true, get: function () { return promise_js_1.PromiseResult; } });
var utilsCancellation_js_1 = require("./utils/utilsCancellation.js");
Object.defineProperty(exports, "derivedWithCancellationToken", { enumerable: true, get: function () { return utilsCancellation_js_1.derivedWithCancellationToken; } });
Object.defineProperty(exports, "waitForState", { enumerable: true, get: function () { return utilsCancellation_js_1.waitForState; } });
var utils_js_1 = require("./utils/utils.js");
Object.defineProperty(exports, "debouncedObservable", { enumerable: true, get: function () { return utils_js_1.debouncedObservable; } });
Object.defineProperty(exports, "debouncedObservable2", { enumerable: true, get: function () { return utils_js_1.debouncedObservable2; } });
Object.defineProperty(exports, "derivedObservableWithCache", { enumerable: true, get: function () { return utils_js_1.derivedObservableWithCache; } });
Object.defineProperty(exports, "derivedObservableWithWritableCache", { enumerable: true, get: function () { return utils_js_1.derivedObservableWithWritableCache; } });
Object.defineProperty(exports, "keepObserved", { enumerable: true, get: function () { return utils_js_1.keepObserved; } });
Object.defineProperty(exports, "mapObservableArrayCached", { enumerable: true, get: function () { return utils_js_1.mapObservableArrayCached; } });
Object.defineProperty(exports, "observableFromPromise", { enumerable: true, get: function () { return utils_js_1.observableFromPromise; } });
Object.defineProperty(exports, "recomputeInitiallyAndOnChange", { enumerable: true, get: function () { return utils_js_1.recomputeInitiallyAndOnChange; } });
Object.defineProperty(exports, "signalFromObservable", { enumerable: true, get: function () { return utils_js_1.signalFromObservable; } });
Object.defineProperty(exports, "throttledObservable", { enumerable: true, get: function () { return utils_js_1.throttledObservable; } });
Object.defineProperty(exports, "wasEventTriggeredRecently", { enumerable: true, get: function () { return utils_js_1.wasEventTriggeredRecently; } });
Object.defineProperty(exports, "isObservable", { enumerable: true, get: function () { return utils_js_1.isObservable; } });
var changeTracker_js_1 = require("./changeTracker.js");
Object.defineProperty(exports, "recordChanges", { enumerable: true, get: function () { return changeTracker_js_1.recordChanges; } });
Object.defineProperty(exports, "recordChangesLazy", { enumerable: true, get: function () { return changeTracker_js_1.recordChangesLazy; } });
var constObservable_js_1 = require("./observables/constObservable.js");
Object.defineProperty(exports, "constObservable", { enumerable: true, get: function () { return constObservable_js_1.constObservable; } });
var observableSignal_js_1 = require("./observables/observableSignal.js");
Object.defineProperty(exports, "observableSignal", { enumerable: true, get: function () { return observableSignal_js_1.observableSignal; } });
var observableFromEvent_js_1 = require("./observables/observableFromEvent.js");
Object.defineProperty(exports, "observableFromEventOpts", { enumerable: true, get: function () { return observableFromEvent_js_1.observableFromEventOpts; } });
var observableSignalFromEvent_js_1 = require("./observables/observableSignalFromEvent.js");
Object.defineProperty(exports, "observableSignalFromEvent", { enumerable: true, get: function () { return observableSignalFromEvent_js_1.observableSignalFromEvent; } });
var transaction_js_1 = require("./transaction.js");
Object.defineProperty(exports, "asyncTransaction", { enumerable: true, get: function () { return transaction_js_1.asyncTransaction; } });
Object.defineProperty(exports, "globalTransaction", { enumerable: true, get: function () { return transaction_js_1.globalTransaction; } });
Object.defineProperty(exports, "subtransaction", { enumerable: true, get: function () { return transaction_js_1.subtransaction; } });
Object.defineProperty(exports, "transaction", { enumerable: true, get: function () { return transaction_js_1.transaction; } });
Object.defineProperty(exports, "TransactionImpl", { enumerable: true, get: function () { return transaction_js_1.TransactionImpl; } });
var valueWithChangeEvent_js_1 = require("./utils/valueWithChangeEvent.js");
Object.defineProperty(exports, "observableFromValueWithChangeEvent", { enumerable: true, get: function () { return valueWithChangeEvent_js_1.observableFromValueWithChangeEvent; } });
Object.defineProperty(exports, "ValueWithChangeEventFromObservable", { enumerable: true, get: function () { return valueWithChangeEvent_js_1.ValueWithChangeEventFromObservable; } });
var runOnChange_js_1 = require("./utils/runOnChange.js");
Object.defineProperty(exports, "runOnChange", { enumerable: true, get: function () { return runOnChange_js_1.runOnChange; } });
Object.defineProperty(exports, "runOnChangeWithCancellationToken", { enumerable: true, get: function () { return runOnChange_js_1.runOnChangeWithCancellationToken; } });
Object.defineProperty(exports, "runOnChangeWithStore", { enumerable: true, get: function () { return runOnChange_js_1.runOnChangeWithStore; } });
var utils_js_2 = require("./experimental/utils.js");
Object.defineProperty(exports, "derivedConstOnceDefined", { enumerable: true, get: function () { return utils_js_2.derivedConstOnceDefined; } });
Object.defineProperty(exports, "latestChangedValue", { enumerable: true, get: function () { return utils_js_2.latestChangedValue; } });
var observableFromEvent_js_2 = require("./observables/observableFromEvent.js");
Object.defineProperty(exports, "observableFromEvent", { enumerable: true, get: function () { return observableFromEvent_js_2.observableFromEvent; } });
var observableValue_js_2 = require("./observables/observableValue.js");
Object.defineProperty(exports, "observableValue", { enumerable: true, get: function () { return observableValue_js_2.observableValue; } });
var set_js_1 = require("./set.js");
Object.defineProperty(exports, "ObservableSet", { enumerable: true, get: function () { return set_js_1.ObservableSet; } });
var map_js_1 = require("./map.js");
Object.defineProperty(exports, "ObservableMap", { enumerable: true, get: function () { return map_js_1.ObservableMap; } });
var debugLocation_js_1 = require("./debugLocation.js");
Object.defineProperty(exports, "DebugLocation", { enumerable: true, get: function () { return debugLocation_js_1.DebugLocation; } });
const logging_js_1 = require("./logging/logging.js");
const consoleObservableLogger_js_1 = require("./logging/consoleObservableLogger.js");
const devToolsLogger_js_1 = require("./logging/debugger/devToolsLogger.js");
const process_js_1 = require("../process.js");
const baseObservable_js_1 = require("./observables/baseObservable.js");
const debugGetDependencyGraph_js_1 = require("./logging/debugGetDependencyGraph.js");
(0, baseObservable_js_1._setDebugGetObservableGraph)(debugGetDependencyGraph_js_1.debugGetObservableGraph);
(0, logging_js_1.setLogObservableFn)(consoleObservableLogger_js_1.logObservableToConsole);
// Remove "//" in the next line to enable logging
const enableLogging = false;
if (enableLogging) {
    (0, logging_js_1.addLogger)(new consoleObservableLogger_js_1.ConsoleObservableLogger());
}
if (process_js_1.env && process_js_1.env['VSCODE_DEV_DEBUG_OBSERVABLES']) {
    // To debug observables you also need the extension "ms-vscode.debug-value-editor"
    (0, logging_js_1.addLogger)(devToolsLogger_js_1.DevToolsLogger.getInstance());
}
