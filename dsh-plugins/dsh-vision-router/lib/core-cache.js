export function cacheWeight(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return value.byteLength;
    if (typeof value === 'string')
        return Buffer.byteLength(value, 'utf8');
    try {
        const encoded = JSON.stringify(value);
        return Buffer.byteLength(encoded === undefined ? String(value) : encoded, 'utf8');
    }
    catch {
        return Buffer.byteLength(String(value), 'utf8');
    }
}
/**
 * LRU+TTL cache bounded by both entry count and retained bytes.
 *
 * Keys are normalized to strings at the ownership boundary. A rejected write
 * never remains resident, and every eviction updates retained-byte accounting
 * before the entry is released.
 */
export function createCache(maxEntries, ttlMsValue, options = {}) {
    const entries = new Map();
    const entryLimit = Math.max(0, Math.floor(Number(maxEntries) || 0));
    const ttlMs = ttlMsValue;
    const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) >= 0
        ? Math.floor(Number(options.maxBytes))
        : 8 * 1024 * 1024;
    const maxEntryBytes = Number.isFinite(Number(options.maxEntryBytes)) && Number(options.maxEntryBytes) >= 0
        ? Math.floor(Number(options.maxEntryBytes))
        : Math.min(maxBytes, 1024 * 1024);
    let retainedBytes = 0;
    const remove = (key) => {
        const entry = entries.get(key);
        if (entry === undefined)
            return;
        retainedBytes = Math.max(0, retainedBytes - entry.weight);
        entries.delete(key);
    };
    const evict = () => {
        while (entries.size > entryLimit || retainedBytes > maxBytes) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined)
                break;
            remove(oldest);
        }
    };
    return {
        get(key) {
            const rawKey = key;
            const entry = entries.get(rawKey);
            if (entry === undefined)
                return undefined;
            if (entry.expiresAt <= Date.now()) {
                remove(rawKey);
                return undefined;
            }
            entries.delete(rawKey);
            entries.set(rawKey, entry);
            return entry.value;
        },
        set(key, value) {
            const normalizedKey = String(key);
            const weight = Buffer.byteLength(normalizedKey, 'utf8') + cacheWeight(value);
            remove(normalizedKey);
            if (entryLimit === 0
                || maxBytes === 0
                || weight > maxEntryBytes
                || weight > maxBytes) {
                return false;
            }
            entries.set(normalizedKey, {
                value,
                weight,
                expiresAt: ttlMs <= 0 ? Infinity : Date.now() + ttlMs,
            });
            retainedBytes += weight;
            evict();
            return entries.has(normalizedKey);
        },
        get size() {
            return entries.size;
        },
        get bytes() {
            return retainedBytes;
        },
    };
}
