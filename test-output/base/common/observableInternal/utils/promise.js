"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservableLazyPromise = exports.ObservableResolvedPromise = exports.PromiseResult = exports.ObservablePromise = exports.ObservableLazy = void 0;
const autorun_js_1 = require("../reactions/autorun.js");
const transaction_js_1 = require("../transaction.js");
const derived_js_1 = require("../observables/derived.js");
const observableValue_js_1 = require("../observables/observableValue.js");
class ObservableLazy {
    _computeValue;
    _value = (0, observableValue_js_1.observableValue)(this, undefined);
    /**
     * The cached value.
     * Does not force a computation of the value.
     */
    get cachedValue() { return this._value; }
    constructor(_computeValue) {
        this._computeValue = _computeValue;
    }
    /**
     * Returns the cached value.
     * Computes the value if the value has not been cached yet.
     */
    getValue() {
        let v = this._value.get();
        if (!v) {
            v = this._computeValue();
            this._value.set(v, undefined);
        }
        return v;
    }
}
exports.ObservableLazy = ObservableLazy;
/**
 * A promise whose state is observable.
 */
class ObservablePromise {
    static fromFn(fn) {
        return new ObservablePromise(fn());
    }
    static resolved(value) {
        return new ObservablePromise(Promise.resolve(value));
    }
    _value = (0, observableValue_js_1.observableValue)(this, undefined);
    /**
     * The promise that this object wraps.
     */
    promise;
    /**
     * The current state of the promise.
     * Is `undefined` if the promise didn't resolve yet.
     */
    promiseResult = this._value;
    constructor(promise) {
        this.promise = promise.then(value => {
            (0, transaction_js_1.transaction)(tx => {
                /** @description onPromiseResolved */
                this._value.set(new PromiseResult(value, undefined), tx);
            });
            return value;
        }, error => {
            (0, transaction_js_1.transaction)(tx => {
                /** @description onPromiseRejected */
                this._value.set(new PromiseResult(undefined, error), tx);
            });
            throw error;
        });
    }
    resolvedValue = (0, derived_js_1.derived)(this, reader => {
        const result = this.promiseResult.read(reader);
        if (!result) {
            return undefined;
        }
        return result.getDataOrThrow();
    });
}
exports.ObservablePromise = ObservablePromise;
class PromiseResult {
    data;
    error;
    constructor(
    /**
     * The value of the resolved promise.
     * Undefined if the promise rejected.
     */
    data, 
    /**
     * The error in case of a rejected promise.
     * Undefined if the promise resolved.
     */
    error) {
        this.data = data;
        this.error = error;
    }
    /**
     * Returns the value if the promise resolved, otherwise throws the error.
     */
    getDataOrThrow() {
        if (this.error) {
            throw this.error;
        }
        return this.data;
    }
}
exports.PromiseResult = PromiseResult;
/**
 * Tracks a changing {@link ObservablePromise}, exposing the last resolved value
 * and whether a newer promise is still pending.
 */
class ObservableResolvedPromise {
    _lastResolved;
    lastResolved;
    _isResolving = (0, observableValue_js_1.observableValue)(this, false);
    isResolving = this._isResolving;
    _runningPromise;
    constructor(source, initialValue, store) {
        this._lastResolved = (0, observableValue_js_1.observableValue)(this, initialValue);
        this.lastResolved = this._lastResolved;
        store.add((0, autorun_js_1.autorun)(reader => {
            const current = source.read(reader);
            this._runningPromise = current;
            const result = current.promiseResult.read(reader);
            if (result) {
                if (current === this._runningPromise) {
                    this._isResolving.set(false, undefined);
                    this._lastResolved.set(result.getDataOrThrow(), undefined);
                }
            }
            else {
                this._isResolving.set(true, undefined);
            }
        }));
    }
}
exports.ObservableResolvedPromise = ObservableResolvedPromise;
/**
 * A lazy promise whose state is observable.
 */
class ObservableLazyPromise {
    _computePromise;
    _lazyValue = new ObservableLazy(() => new ObservablePromise(this._computePromise()));
    /**
     * Does not enforce evaluation of the promise compute function.
     * Is undefined if the promise has not been computed yet.
     */
    cachedPromiseResult = (0, derived_js_1.derived)(this, reader => this._lazyValue.cachedValue.read(reader)?.promiseResult.read(reader));
    constructor(_computePromise) {
        this._computePromise = _computePromise;
    }
    getPromise() {
        return this._lazyValue.getValue().promise;
    }
}
exports.ObservableLazyPromise = ObservableLazyPromise;
