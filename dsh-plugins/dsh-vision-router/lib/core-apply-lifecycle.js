export function runCoreApplyLifecycle(invoke, { onSuccess, onFailure } = {}) {
    if (typeof invoke !== 'function')
        throw new TypeError('Core apply lifecycle requires an invoke function');
    const succeed = typeof onSuccess === 'function' ? onSuccess : () => { };
    const fail = (error) => {
        try {
            onFailure?.(error);
        }
        catch {
            // Cleanup/diagnostic failure must not replace the Core apply error.
        }
        throw error;
    };
    let result;
    try {
        result = invoke();
    }
    catch (error) {
        return fail(error);
    }
    if (result !== null
        && (typeof result === 'object' || typeof result === 'function')
        && typeof result.then === 'function') {
        return Promise.resolve(result).then((value) => {
            try {
                succeed();
                return value;
            }
            catch (error) {
                return fail(error);
            }
        }, fail);
    }
    try {
        succeed();
        return result;
    }
    catch (error) {
        return fail(error);
    }
}
