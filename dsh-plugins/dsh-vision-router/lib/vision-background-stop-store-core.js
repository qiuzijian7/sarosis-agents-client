import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { BENCHMARK_AXES, } from './vision-capability-evidence.js';
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from './vision-capability-fingerprint.js';
const CACHE_VERSION = 3;
const MAX_ENTRIES = 256;
function propertyBag(value) {
    return value !== null && typeof value === 'object'
        ? value
        : undefined;
}
function cleanText(value, max = 256) {
    return typeof value === 'string' && value.trim() !== ''
        ? value.trim().slice(0, max)
        : '';
}
function benchmarkAxis(value) {
    return BENCHMARK_AXES.includes(value)
        ? value
        : undefined;
}
function persistentFailureClass(value) {
    return value === 'unavailable' || value === 'protocol'
        ? value
        : undefined;
}
function cleanStop(value) {
    const record = propertyBag(value);
    if (record === undefined)
        return undefined;
    if (Number(record.suiteRevision) !== CAPABILITY_BENCHMARK_SUITE_REVISION) {
        return undefined;
    }
    const fingerprint = cleanText(record.fingerprint, 64);
    if (!/^ep2_[0-9a-f]{32}$/.test(fingerprint))
        return undefined;
    const key = cleanText(record.key);
    const provider = cleanText(record.provider);
    const model = cleanText(record.model);
    const axis = benchmarkAxis(cleanText(record.axis, 32));
    const errorClass = persistentFailureClass(cleanText(record.errorClass, 48));
    const errorCode = cleanText(record.errorCode, 96);
    const recordedAt = Number(record.recordedAt);
    const expiresAt = Number(record.expiresAt);
    if (!key || !provider || !model || axis === undefined || errorClass === undefined) {
        return undefined;
    }
    if (!Number.isFinite(recordedAt) || recordedAt <= 0)
        return undefined;
    if (!Number.isFinite(expiresAt) || expiresAt <= recordedAt)
        return undefined;
    return {
        fingerprint,
        key,
        provider,
        model,
        axis,
        errorClass,
        ...(errorCode ? { errorCode } : {}),
        recordedAt,
        expiresAt,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
    };
}
function recordKey(value) {
    return `${value.fingerprint}\u0000${value.axis}`;
}
function selectRetainedStops(values, at, maxEntries = MAX_ENTRIES) {
    const seen = new Set();
    return [...values]
        .map(cleanStop)
        .filter((item) => item !== undefined && item.expiresAt > at)
        .sort((a, b) => b.recordedAt - a.recordedAt
        || recordKey(a).localeCompare(recordKey(b)))
        .filter((item) => {
        const key = recordKey(item);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    })
        .slice(0, maxEntries);
}
function retainedStopMap(values, at, maxEntries = MAX_ENTRIES) {
    return new Map(selectRetainedStops(values, at, maxEntries)
        .map((item) => [recordKey(item), item]));
}
async function save(file, records, fsOps, at) {
    const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const stops = selectRetainedStops(records.values(), at);
    await fsOps.mkdir(path.dirname(file), { recursive: true });
    await fsOps.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, stops }), { encoding: 'utf8', mode: 0o600 });
    await fsOps.rename(temporary, file);
}
async function load(file, fsOps, at) {
    try {
        const raw = await fsOps.readFile(file, 'utf8');
        const body = propertyBag(JSON.parse(raw));
        const stops = body?.stops;
        const version = Number(body?.version);
        if (!Array.isArray(stops)
            || (version !== 2 && version !== CACHE_VERSION)) {
            return new Map();
        }
        const records = retainedStopMap(stops, at);
        // Rewrite whenever loading changed the persisted set: v2 stored raw entries
        // that this version must drop, and any later retention rule (category,
        // expiry, fingerprint shape) has to reach the file the same way instead of
        // leaving a stale record that only the runtime filter happens to hide.
        if (version === 2 || records.size !== stops.length) {
            try {
                await save(file, records, fsOps, at);
            }
            catch {
                // This rewrite is opportunistic: a read-only or full disk must not discard the records
                // the load could still read (the catch below returns an empty map). The store's own
                // persist() retries the write and reports it through the logger.
            }
        }
        return records;
    }
    catch (error) {
        if (propertyBag(error)?.code === 'ENOENT')
            return new Map();
        return new Map();
    }
}
/**
 * Durable stop owner for unattended capability measurement.
 *
 * Only endpoint/model evidence that is benchmark-axis-scoped and safe to
 * persist (protocol or unavailable) can enter this store. AUTH remains a
 * process-local access condition and is rejected by runtime validation even
 * when legacy v2 cache data contains it.
 */
export function createBackgroundBenchmarkStopStoreCore(options) {
    const file = options.file;
    const fsOps = {
        readFile: options.fsOps?.readFile ?? readFile,
        mkdir: options.fsOps?.mkdir ?? mkdir,
        writeFile: options.fsOps?.writeFile ?? writeFile,
        rename: options.fsOps?.rename ?? rename,
    };
    const logger = options.logger;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    let records = new Map();
    let saveTail = Promise.resolve();
    const ready = load(file, fsOps, Number(now()))
        .then((loaded) => {
        records = loaded;
    });
    const persist = () => {
        const at = Number(now());
        saveTail = saveTail
            .then(() => save(file, records, fsOps, at))
            .catch((error) => {
            logger?.warn?.('vision-router: background stop cache write failed: %s', cleanText(propertyBag(error)?.message ?? error, 240));
        });
        return saveTail;
    };
    const reconcile = () => {
        const at = Number(now());
        const retained = retainedStopMap(records.values(), at);
        const changed = retained.size !== records.size
            || [...retained.keys()].some((key) => !records.has(key));
        records = retained;
        return changed;
    };
    return {
        file,
        async list() {
            await ready;
            if (reconcile())
                await persist();
            return [...records.values()]
                .sort((a, b) => b.recordedAt - a.recordedAt);
        },
        async mark({ fingerprint, key, provider, model, axis, errorClass, errorCode, recordedAt = Number(now()), expiresAt, } = {}) {
            await ready;
            reconcile();
            const clean = cleanStop({
                fingerprint,
                key,
                provider,
                model,
                axis,
                errorClass,
                errorCode,
                recordedAt,
                expiresAt,
                suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
            });
            if (clean === undefined)
                return undefined;
            const keyOfStop = recordKey(clean);
            records.set(keyOfStop, clean);
            reconcile();
            await persist();
            return records.get(keyOfStop);
        },
        async clearStop(fingerprint, axis) {
            await ready;
            const removed = records.delete(`${String(fingerprint ?? '')}\u0000${String(axis ?? '')}`);
            if (removed)
                await persist();
            return removed;
        },
        async clearFingerprint(fingerprint) {
            await ready;
            const wanted = String(fingerprint ?? '');
            let removed = false;
            for (const [key, record] of records.entries()) {
                if (record.fingerprint !== wanted)
                    continue;
                records.delete(key);
                removed = true;
            }
            if (removed)
                await persist();
            return removed;
        },
        async flush() {
            await ready;
            await saveTail;
        },
    };
}
