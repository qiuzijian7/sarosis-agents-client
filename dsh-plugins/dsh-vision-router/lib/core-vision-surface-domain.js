import { resolveSessionSurfacePolicy, } from './session-surface-policy-domain.js';
export const CORE_VISION_SURFACE_KEYS = [
    'tool',
    'rewriteImages',
    'instantDescribe',
    'autoActivateOnImage',
    'structuredVisionBootstrap',
];
function objectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}
function coreFlags(values) {
    return {
        toolAvailable: values.tool !== false,
        rewriteEnabled: values.rewriteImages !== false,
        instantDescribe: values.instantDescribe === true,
        autoActivateOnImage: values.autoActivateOnImage !== false,
        structuredBootstrap: values.structuredVisionBootstrap === true,
    };
}
/**
 * Explicit Core-facing projection of SessionSurfacePolicy.
 *
 * Only the five historical Core switches cross this boundary. Unrelated plugin
 * Settings cannot masquerade as a Core config/Settings object.
 */
export function projectCoreVisionSurface(config = {}, sessionPolicy) {
    const value = objectRecord(config) ?? {};
    const policyRecord = objectRecord(sessionPolicy);
    const policy = policyRecord !== undefined
        ? policyRecord
        : resolveSessionSurfacePolicy({ config: value });
    const overrides = objectRecord(policy.legacyConfigOverrides) ?? {};
    const projected = {};
    for (const key of CORE_VISION_SURFACE_KEYS) {
        projected[key] = own(overrides, key)
            ? overrides[key]
            : value[key];
    }
    const values = Object.freeze(projected);
    return Object.freeze({
        ownership: typeof policy.ownership === 'string'
            ? policy.ownership
            : undefined,
        preserveRawImages: policy.preserveRawImages === true,
        rewriteCurrentImages: policy.rewriteCurrentImages === true,
        ...coreFlags(values),
        values,
    });
}
export function resolveCoreVisionSurface({ visionPolicy, config = {}, schemaBootstrapping = false, } = {}) {
    const value = objectRecord(config) ?? {};
    return projectCoreVisionSurface(value, resolveSessionSurfacePolicy({
        visionPolicy,
        config: value,
        schemaBootstrapping,
    }));
}
