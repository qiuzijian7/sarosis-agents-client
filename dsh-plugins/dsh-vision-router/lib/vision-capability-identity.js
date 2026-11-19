import { createHash } from 'node:crypto';
import { capabilityBenchmarkFingerprint } from './vision-capability-fingerprint.js';
function propertyBag(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        ? value
        : undefined;
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function contextGetter(ctx) {
    const get = propertyBag(ctx)?.get;
    return typeof get === 'function'
        ? (name) => get.call(ctx, name)
        : undefined;
}
function credentialValue(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
export function visionCredentialFingerprint(value) {
    const text = typeof value === 'string' ? value : '';
    if (text === '')
        return 'none';
    return `cred_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}
/**
 * Capability identity deliberately excludes credential identity.
 *
 * Credentials decide whether a route can be accessed right now; they do not
 * define what the same model deployment is capable of. Deployment/project
 * identity belongs in endpoint/config when it actually changes the served
 * model, never in secret material.
 */
export function capabilityEvidenceFingerprint({ provider, model, endpoint, config, } = {}) {
    return capabilityBenchmarkFingerprint({ provider, model, endpoint, config });
}
export async function resolveVisionCredential(ctx, ref) {
    const key = nonEmpty(ref);
    if (key === undefined) {
        return {
            required: false,
            value: undefined,
            fingerprint: 'none',
            source: 'none',
        };
    }
    let credentials;
    try {
        credentials = contextGetter(ctx)?.('credentials');
    }
    catch {
        credentials = undefined;
    }
    if (credentials !== undefined) {
        try {
            const resolve = propertyBag(credentials)?.resolve;
            const hit = typeof resolve === 'function'
                ? await resolve.call(credentials, key)
                : undefined;
            const value = credentialValue(propertyBag(hit)?.value);
            return {
                required: true,
                value,
                fingerprint: value === undefined
                    ? 'unresolved'
                    : visionCredentialFingerprint(value),
                source: value === undefined ? 'credentials-miss' : 'credentials',
            };
        }
        catch {
            return {
                required: true,
                value: undefined,
                fingerprint: 'unresolved',
                source: 'credentials-error',
            };
        }
    }
    let launchEnvironment;
    try {
        launchEnvironment = contextGetter(ctx)?.('launchEnvironment');
    }
    catch {
        return {
            required: true,
            value: undefined,
            fingerprint: 'unresolved',
            source: 'launch-environment-error',
        };
    }
    if (launchEnvironment !== undefined) {
        try {
            const get = propertyBag(launchEnvironment)?.get;
            const hit = typeof get === 'function'
                ? get.call(launchEnvironment, key)
                : undefined;
            const value = credentialValue(propertyBag(hit)?.value);
            return {
                required: true,
                value,
                fingerprint: value === undefined
                    ? 'unresolved'
                    : visionCredentialFingerprint(value),
                source: value === undefined
                    ? 'launch-environment-miss'
                    : 'launch-environment',
            };
        }
        catch {
            return {
                required: true,
                value: undefined,
                fingerprint: 'unresolved',
                source: 'launch-environment-error',
            };
        }
    }
    const ambient = process.env[key];
    const value = typeof ambient === 'string' && ambient !== '' ? ambient : undefined;
    return {
        required: true,
        value,
        fingerprint: value === undefined
            ? 'unresolved'
            : visionCredentialFingerprint(value),
        source: value === undefined ? 'ambient-miss' : 'ambient',
    };
}
