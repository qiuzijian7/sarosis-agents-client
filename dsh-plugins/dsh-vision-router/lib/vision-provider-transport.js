import { ERROR_RESPONSE_MAX_BYTES, MODEL_RESPONSE_MAX_BYTES, readResponseJsonBounded, readResponseTextBounded, } from './http-body-limit.js';
import { effectiveProxyUrlForUndici } from './proxy-url-compat.js';
import { createProxyDispatcherPool } from './proxy-dispatcher-pool.js';
import { createPerHopProxyDispatcher, proxyDispatcherLike, proxyHostMatchesAny, visionProxyOverrideConfigured, } from './proxy-routing.js';
const DEFAULT_PROXY_HOSTS = Object.freeze([
    'api.openrouter.ai',
    'openrouter.ai',
    'api.openai.com',
    'api.anthropic.com',
    'api.groq.com',
    'api.mistral.ai',
    'api.together.xyz',
    'generativelanguage.googleapis.com',
    'api.x.ai',
]);
const capturedHostFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined;
const moduleFetch = capturedHostFetch
    ? (input, init) => capturedHostFetch(input, init)
    : undefined;
function objectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function live(value) {
    return typeof value === 'function' ? value() : value;
}
function asObject(value) {
    return objectRecord(value) ?? {};
}
function asUrl(input) {
    try {
        if (input instanceof URL)
            return input;
        if (typeof input === 'string')
            return new URL(input);
        const raw = objectRecord(input)?.url;
        return typeof raw === 'string' ? new URL(raw) : undefined;
    }
    catch {
        return undefined;
    }
}
function proxySettings(config) {
    const value = asObject(live(config));
    const rawProxy = value.proxy;
    const proxy = visionProxyOverrideConfigured(value) && typeof rawProxy === 'string'
        ? rawProxy.trim()
        : undefined;
    const proxyHosts = Array.isArray(value.proxyHosts)
        ? value.proxyHosts
            .filter((host) => typeof host === 'string' && host.trim() !== '')
            .map((host) => host.trim())
        : [...DEFAULT_PROXY_HOSTS];
    return { proxy, proxyHosts };
}
function credentialService(ctx) {
    try {
        const service = ctx?.get?.('credentials');
        return service !== null && (typeof service === 'object' || typeof service === 'function')
            ? service
            : undefined;
    }
    catch {
        return undefined;
    }
}
function envCredential(ref) {
    const value = process.env[ref];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * Router-owned provider transport.
 *
 * It owns only direct visual-provider HTTP mechanics: the Host fetch function,
 * optional provider-scoped proxy OVERRIDE dispatch, credential lookup helpers,
 * bounded response readers and cancellation propagation. With no explicit plugin
 * proxy, fetch is forwarded without a dispatcher so DSH/Host's ambient network
 * policy remains authoritative. It intentionally does not cover update checks,
 * GitHub/npm maintenance traffic or Host-owned LLM adapter requests.
 */
export function createVisionProviderTransport({ ctx, config = {}, fetchImpl = moduleFetch, importUndici = () => import('undici'), } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('vision provider transport requires fetch');
    }
    let disposed = false;
    let disposePromise;
    const dispatcherPool = createProxyDispatcherPool({
        importUndici,
        label: 'vision provider transport',
    });
    const fetchProvider = async (input, init = {}, context = {}) => {
        if (disposed)
            return fetchImpl(input, init);
        const url = asUrl(input);
        const { proxy, proxyHosts } = proxySettings(config);
        const effectiveProxyUrl = proxy ? effectiveProxyUrlForUndici(proxy) : undefined;
        dispatcherPool.reconcile(effectiveProxyUrl);
        if (!url
            || !effectiveProxyUrl
            || context.allowProxy === false
            || !proxyHostMatchesAny(url.hostname, proxyHosts)) {
            return fetchImpl(input, init);
        }
        const lease = await dispatcherPool.acquire(effectiveProxyUrl);
        try {
            const fallbackDispatcher = proxyDispatcherLike(init.dispatcher)
                ? init.dispatcher
                : lease.getGlobalDispatcher();
            const dispatcher = createPerHopProxyDispatcher(lease.dispatcher, fallbackDispatcher, proxyHosts);
            return await fetchImpl(input, { ...init, dispatcher });
        }
        finally {
            lease.release();
        }
    };
    const dispose = () => {
        if (disposePromise)
            return disposePromise;
        disposed = true;
        disposePromise = dispatcherPool.dispose();
        return disposePromise;
    };
    return Object.freeze({
        fetch: fetchProvider,
        dispose,
        async resolveCredential(ref) {
            const name = typeof ref === 'string' ? ref.trim() : '';
            if (!name)
                return undefined;
            const credentials = credentialService(ctx);
            try {
                const resolve = credentials?.resolve;
                if (typeof resolve === 'function') {
                    const hit = await Reflect.apply(resolve, credentials, [name]);
                    const value = objectRecord(hit)?.value;
                    if (typeof value === 'string' && value !== '')
                        return value;
                }
            }
            catch {
                // A missing/partial/throwing Host credential service must not suppress
                // the supported environment-variable compatibility fallback.
            }
            return envCredential(name);
        },
        readErrorText(response, options = {}) {
            return readResponseTextBounded(response, options.maxBytes ?? ERROR_RESPONSE_MAX_BYTES, { label: options.label ?? 'vision provider error response' });
        },
        readModelJson(response, options = {}) {
            return readResponseJsonBounded(response, options.maxBytes ?? MODEL_RESPONSE_MAX_BYTES, { label: options.label ?? 'vision provider response' });
        },
        proxyDecision(input) {
            const url = asUrl(input);
            const { proxy, proxyHosts } = proxySettings(config);
            return Object.freeze({
                proxied: Boolean(url && proxy && proxyHostMatchesAny(url.hostname, proxyHosts)),
                proxy,
                hostname: url?.hostname,
            });
        },
    });
}
