import { z } from 'zod';
import { SESSION_VISION_POLICY_REVISION, parseSessionVisionPolicy, } from './session-vision-policy.js';
const policySchema = z.discriminatedUnion('source', [
    z.object({
        revision: z.literal(SESSION_VISION_POLICY_REVISION),
        enabled: z.boolean(),
        source: z.literal('user'),
    }).strict(),
    z.object({
        revision: z.literal(SESSION_VISION_POLICY_REVISION),
        enabled: z.boolean(),
        source: z.literal('delegation'),
        inheritedFrom: z.string().trim().min(1),
    }).strict(),
]);
/**
 * Plugin-owned Session sidecar. The shape intentionally satisfies DSH's
 * public DomainSpec contract without importing storage-domain at runtime:
 * older Hosts may not mount that optional capability at all.
 */
export const sessionVisionPolicyDomainSpec = {
    name: 'vision_router_session_policy',
    version: 1,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables: {
        policies: {
            valueSchema: policySchema,
        },
    },
};
function normalizedSessionId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('session vision policy requires a non-empty session id');
    }
    return value.trim();
}
function storageDomainOf(ctx) {
    // storageDomain is optional across the supported Host window. Reading the
    // Cordis service property without inject() turns capability detection into a
    // hard dependency; Context#get is the non-owning, live lookup seam here.
    try {
        const candidate = ctx.get?.('storageDomain');
        return candidate && typeof candidate.open === 'function' ? candidate : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Create a synchronous-read policy store with lazy official DSH sidecar
 * hydration. No storage capability means ordinary volatile operation.
 *
 * Domain ownership is bound to the consumer fiber before any asynchronous open
 * begins. That ordering is deliberate: an HMR/unload racing a slow open must
 * await/close the eventual handle instead of leaving a same-name domain behind
 * in the longer-lived storageDomain facility. Live facility replacement also
 * retires the previous handle before opening against the replacement.
 *
 * Once a storage failure is observed, this store degrades to volatile for the
 * rest of its lifetime. Vision availability must not depend on auxiliary
 * persistence health; a later plugin generation can retry the durable seam.
 */
export function createSessionVisionPolicyRuntimeStore(ctx) {
    const cache = new Map();
    const closedDomains = new WeakSet();
    let activeFacility;
    let domainPromise;
    let transition = Promise.resolve();
    const mutationTails = new Map();
    const activeMutations = new Set();
    const hydrationTokens = new Map();
    let durableDisabled = false;
    let lifecycleClosed = false;
    let lifecycleBound = false;
    let warned = false;
    const warnDegraded = (error) => {
        if (warned)
            return;
        warned = true;
        try {
            ctx.logger?.warn?.('vision-router: Session Vision policy persistence unavailable; using process-local fallback: %s', error instanceof Error ? error.message : String(error));
        }
        catch { }
    };
    const markDurabilityFailed = (error) => {
        durableDisabled = true;
        warnDegraded(error);
    };
    const closeDomainOnce = async (domain) => {
        const key = domain;
        if (closedDomains.has(key))
            return;
        closedDomains.add(key);
        try {
            await domain.close();
        }
        catch (error) {
            warnDegraded(error);
        }
    };
    const retireActiveDomain = async () => {
        const pending = domainPromise;
        domainPromise = undefined;
        activeFacility = undefined;
        if (pending === undefined)
            return;
        try {
            const domain = await pending;
            if (domain !== undefined)
                await closeDomainOnce(domain);
        }
        catch (error) {
            warnDegraded(error);
        }
    };
    const enqueueRetire = () => {
        transition = transition.then(retireActiveDomain, retireActiveDomain);
        return transition;
    };
    if (typeof ctx.effect === 'function') {
        try {
            ctx.effect(() => {
                lifecycleBound = true;
                return async () => {
                    lifecycleClosed = true;
                    // No new durable mutation is admitted after lifecycleClosed flips.
                    // Wait every mutation that was already admitted before closing the
                    // shared domain underneath it.
                    await Promise.allSettled([...activeMutations]);
                    await enqueueRetire();
                };
            }, 'vision-router: Session Vision policy domain lifecycle');
        }
        catch (error) {
            markDurabilityFailed(error);
        }
    }
    const ensureDomainFor = async (facility, allowClosed = false) => {
        if ((lifecycleClosed && !allowClosed) || durableDisabled)
            return;
        if (activeFacility === facility && domainPromise !== undefined)
            return;
        if (domainPromise !== undefined || activeFacility !== undefined) {
            await retireActiveDomain();
        }
        if ((lifecycleClosed && !allowClosed) || durableDisabled)
            return;
        activeFacility = facility;
        let opening;
        opening = facility.open(sessionVisionPolicyDomainSpec)
            .then(async (domain) => {
            if ((lifecycleClosed && !allowClosed)
                || durableDisabled
                || activeFacility !== facility
                || domainPromise !== opening) {
                await closeDomainOnce(domain);
                return undefined;
            }
            return domain;
        })
            .catch((error) => {
            if (domainPromise === opening) {
                domainPromise = undefined;
                activeFacility = undefined;
                markDurabilityFailed(error);
            }
            return undefined;
        });
        domainPromise = opening;
    };
    const openDomain = async (allowClosed = false) => {
        if (!lifecycleBound || (lifecycleClosed && !allowClosed) || durableDisabled)
            return undefined;
        const facility = storageDomainOf(ctx);
        if (facility === undefined)
            return undefined;
        transition = transition.then(() => ensureDomainFor(facility, allowClosed), () => ensureDomainFor(facility, allowClosed));
        await transition;
        return await domainPromise;
    };
    const table = async (allowClosed = false) => {
        const domain = await openDomain(allowClosed);
        if (domain === undefined)
            return undefined;
        return domain.table('policies');
    };
    const failDurabilityAndRetire = async (error) => {
        markDurabilityFailed(error);
        await enqueueRetire();
    };
    const enqueueMutation = (key, mutate) => {
        if (lifecycleClosed)
            return Promise.resolve();
        const previous = mutationTails.get(key) ?? Promise.resolve();
        let current;
        // Admission is decided above. Once admitted, a mutation must run even if
        // lifecycle shutdown begins while it is queued behind an earlier mutation;
        // the disposer waits activeMutations before retiring the domain.
        current = previous.then(mutate, mutate);
        mutationTails.set(key, current);
        activeMutations.add(current);
        void current.then(() => {
            activeMutations.delete(current);
            if (mutationTails.get(key) === current)
                mutationTails.delete(key);
        }, () => {
            activeMutations.delete(current);
            if (mutationTails.get(key) === current)
                mutationTails.delete(key);
        });
        return current;
    };
    return {
        get durable() {
            return lifecycleBound
                && !lifecycleClosed
                && !durableDisabled
                && storageDomainOf(ctx) !== undefined;
        },
        get(sessionId) {
            return cache.get(normalizedSessionId(sessionId));
        },
        async hydrate(sessionId) {
            const key = normalizedSessionId(sessionId);
            const existing = cache.get(key);
            if (existing !== undefined)
                return existing;
            const token = {};
            hydrationTokens.set(key, token);
            try {
                const handle = await table();
                if (hydrationTokens.get(key) !== token)
                    return cache.get(key);
                if (handle === undefined)
                    return undefined;
                const policy = parseSessionVisionPolicy(handle.get(key));
                if (hydrationTokens.get(key) !== token)
                    return cache.get(key);
                if (policy !== undefined)
                    cache.set(key, policy);
                return policy;
            }
            catch (error) {
                await failDurabilityAndRetire(error);
                return undefined;
            }
            finally {
                if (hydrationTokens.get(key) === token)
                    hydrationTokens.delete(key);
            }
        },
        release(sessionId) {
            const key = normalizedSessionId(sessionId);
            hydrationTokens.delete(key);
            // A durable row can be rehydrated on the next Agent creation. Keep the
            // process-local copy when durability is unavailable so volatile support
            // does not lose the only Session-scoped truth it has.
            if (this.durable)
                cache.delete(key);
        },
        async set(sessionId, policy) {
            const key = normalizedSessionId(sessionId);
            hydrationTokens.delete(key);
            const normalized = parseSessionVisionPolicy(policy);
            if (normalized === undefined)
                throw new TypeError('invalid session vision policy');
            // Publish process-local authority before the first await. A committed
            // model/selection event must affect the next prompt immediately even if
            // sidecar I/O is still settling; delegation still awaits this method and
            // therefore preserves its stronger durability-before-child-release rule.
            cache.set(key, normalized);
            await enqueueMutation(key, async () => {
                try {
                    // This mutation was admitted before lifecycle close; the disposer
                    // waits it before retiring the domain, so it may finish durable I/O.
                    const handle = await table(true);
                    if (handle !== undefined)
                        await handle.put(key, normalized);
                }
                catch (error) {
                    await failDurabilityAndRetire(error);
                }
            });
            return normalized;
        },
        async delete(sessionId) {
            const key = normalizedSessionId(sessionId);
            hydrationTokens.delete(key);
            cache.delete(key);
            await enqueueMutation(key, async () => {
                try {
                    // Same admission rule as set(): pre-close deletes must not be lost.
                    const handle = await table(true);
                    if (handle !== undefined)
                        await handle.delete(key);
                }
                catch (error) {
                    await failDurabilityAndRetire(error);
                }
            });
        },
    };
}
