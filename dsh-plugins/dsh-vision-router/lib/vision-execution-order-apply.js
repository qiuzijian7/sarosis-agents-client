function pairIdentity(pair) {
    const value = pair !== null && typeof pair === 'object'
        ? pair
        : {};
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    return provider !== '' && model !== '' ? `${provider}\u0000${model}` : undefined;
}
export function applyVisionExecutionOrder(basePairs, scopedOrder) {
    const base = Array.isArray(basePairs)
        ? basePairs.filter((pair) => pairIdentity(pair) !== undefined)
        : [];
    const baseById = new Map();
    for (const pair of base) {
        const id = pairIdentity(pair);
        if (id !== undefined && !baseById.has(id))
            baseById.set(id, pair);
    }
    if (!Array.isArray(scopedOrder) || scopedOrder.length === 0) {
        return [...baseById.values()];
    }
    const out = [];
    const seen = new Set();
    const addBasePair = (pair) => {
        const id = pairIdentity(pair);
        if (id === undefined || seen.has(id))
            return;
        seen.add(id);
        out.push(pair);
    };
    for (const requested of scopedOrder) {
        const id = pairIdentity(requested);
        if (id === undefined)
            continue;
        const pair = baseById.get(id);
        if (pair !== undefined)
            addBasePair(pair);
    }
    for (const pair of baseById.values())
        addBasePair(pair);
    return out;
}
export function sameVisionPairOrder(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1) {
        if (pairIdentity(left[index]) !== pairIdentity(right[index]))
            return false;
    }
    return true;
}
