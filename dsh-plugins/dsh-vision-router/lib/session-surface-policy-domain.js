const OWNERSHIP = Object.freeze({
    PLUGIN_OWNED: 'vision-router-owned',
    NATIVE: 'native-image',
    TEXT_ONLY: 'text-only',
    UNKNOWN: 'unknown',
});
const KNOWN_OWNERSHIP = new Set(Object.values(OWNERSHIP));
function objectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function normalizedOwnership(policy) {
    const source = objectRecord(policy);
    if (source === undefined)
        return undefined;
    return typeof source.ownership === 'string'
        && KNOWN_OWNERSHIP.has(source.ownership)
        ? source.ownership
        : OWNERSHIP.UNKNOWN;
}
/**
 * Resolve one immutable Core-facing capability snapshot for the current Session.
 *
 * Image ownership and Vision-mode authority remain separate facts. Durable
 * transcript preservation is fail-safe: every real Session policy preserves
 * the user-owned image, while the step authority alone decides whether DVR
 * automatic/tool surfaces are active.
 */
export function resolveSessionSurfacePolicy({ visionPolicy, visionModeAuthority, config = {}, schemaBootstrapping = false, } = {}) {
    const source = objectRecord(visionPolicy);
    const authority = objectRecord(visionModeAuthority);
    const value = objectRecord(config) ?? {};
    const ownership = normalizedOwnership(source);
    const pluginOwned = ownership === OWNERSHIP.PLUGIN_OWNED;
    const visionModeEnabled = authority !== undefined
        ? authority.enabled === true
        : source === undefined
            ? true
            : pluginOwned;
    const preserveRawImages = source !== undefined;
    const rewriteCurrentImages = false;
    const allowStructuredBootstrap = visionModeEnabled;
    const allowGenericAutoMount = visionModeEnabled;
    const surface = Object.freeze({
        preserveRawImages,
        rewriteCurrentImages,
        visionTools: value.tool !== false && visionModeEnabled,
        structuredBootstrap: value.structuredVisionBootstrap === true && visionModeEnabled,
        genericAutoMount: value.autoActivateOnImage !== false && visionModeEnabled,
        instantDescribe: value.instantDescribe !== false && visionModeEnabled,
    });
    const overrides = {};
    if (schemaBootstrapping === true
        && source === undefined
        && value.tool === false) {
        overrides.tool = true;
    }
    if (source !== undefined && value.rewriteImages !== false) {
        overrides.rewriteImages = false;
    }
    if (source !== undefined && !visionModeEnabled) {
        if (value.tool !== false)
            overrides.tool = false;
        if (value.instantDescribe !== false)
            overrides.instantDescribe = false;
        if (value.autoActivateOnImage !== false) {
            overrides.autoActivateOnImage = false;
        }
        if (value.structuredVisionBootstrap !== false) {
            overrides.structuredVisionBootstrap = false;
        }
    }
    return Object.freeze({
        ownership,
        visionModeEnabled,
        participates: source !== undefined,
        preserveRawImages,
        rewriteCurrentImages,
        allowStructuredBootstrap,
        allowGenericAutoMount,
        surface,
        legacyConfigOverrides: Object.freeze(overrides),
    });
}
