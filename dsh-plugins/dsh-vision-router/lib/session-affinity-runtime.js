import { AsyncLocalStorage } from 'node:async_hooks';
import { rawSessionIdentity } from './session-affinity.js';
const affinityRuntime = new AsyncLocalStorage();
function propertyBag(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        ? value
        : undefined;
}
function isPromiseLike(value) {
    return typeof propertyBag(value)?.then === 'function';
}
export function currentVisionSessionAffinityId() {
    const state = affinityRuntime.getStore();
    return state?.active === true ? state.affinityId : undefined;
}
export function runWithVisionSessionAffinity(affinityId, callback) {
    const raw = rawSessionIdentity(affinityId);
    if (raw === undefined)
        return callback();
    const state = {
        affinityId: raw,
        active: true,
    };
    let result;
    try {
        result = affinityRuntime.run(state, callback);
    }
    catch (error) {
        state.active = false;
        throw error;
    }
    if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(() => {
            state.active = false;
        });
    }
    state.active = false;
    return result;
}
export function streamWithVisionSessionAffinity(affinityId, streamFactory) {
    const raw = rawSessionIdentity(affinityId);
    if (raw === undefined)
        return streamFactory();
    return {
        [Symbol.asyncIterator]() {
            const state = {
                affinityId: raw,
                active: true,
            };
            let iteratorPromise;
            const retire = () => {
                state.active = false;
            };
            const ensure = () => {
                if (iteratorPromise === undefined) {
                    iteratorPromise = affinityRuntime.run(state, async () => {
                        const stream = await streamFactory();
                        if (stream === null
                            || (typeof stream !== 'object' && typeof stream !== 'function')
                            || typeof stream[Symbol.asyncIterator] !== 'function') {
                            throw new TypeError('scoped vision stream is not async iterable');
                        }
                        return stream[Symbol.asyncIterator]();
                    });
                }
                return iteratorPromise;
            };
            return {
                next(value) {
                    return affinityRuntime.run(state, async () => {
                        try {
                            const result = await (await ensure()).next(value);
                            if (result?.done === true)
                                retire();
                            return result;
                        }
                        catch (error) {
                            retire();
                            throw error;
                        }
                    });
                },
                return(value) {
                    if (iteratorPromise === undefined) {
                        retire();
                        return Promise.resolve({ done: true, value });
                    }
                    return affinityRuntime.run(state, async () => {
                        try {
                            const active = await ensure();
                            return typeof active.return === 'function'
                                ? await active.return(value)
                                : { done: true, value };
                        }
                        finally {
                            retire();
                        }
                    });
                },
                throw(error) {
                    if (iteratorPromise === undefined) {
                        retire();
                        return Promise.reject(error);
                    }
                    return affinityRuntime.run(state, async () => {
                        try {
                            const active = await ensure();
                            if (typeof active.throw === 'function')
                                return await active.throw(error);
                            throw error;
                        }
                        finally {
                            retire();
                        }
                    });
                },
            };
        },
    };
}
