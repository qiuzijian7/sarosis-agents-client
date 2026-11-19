const ROUTE_OWNED_CALL_FIELDS = Object.freeze([
    'reasoningEffort',
    'temperature',
    'maxTokens',
    'stop',
]);
export function projectDelegatedCallConfig(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        return options;
    const record = options;
    if (!ROUTE_OWNED_CALL_FIELDS.some((field) => Object.hasOwn(record, field)))
        return options;
    const next = { ...record };
    for (const field of ROUTE_OWNED_CALL_FIELDS)
        delete next[field];
    return next;
}
export const delegatedRouteOwnedCallFields = ROUTE_OWNED_CALL_FIELDS;
