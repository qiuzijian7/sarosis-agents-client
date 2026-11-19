function propertyBag(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        ? value
        : undefined;
}
/**
 * Read the released Session-local event snapshot used only when the Host does
 * not advertise the asynchronous SessionQuery capability.
 *
 * Durable-data compatibility is intentionally separate from the current Host
 * floor: this helper feature-detects historical Session shapes at runtime and
 * never claims that either shape exists through a static Host type.
 */
export function legacySessionEvents(session) {
    const source = propertyBag(session);
    if (source === undefined)
        return undefined;
    try {
        const snapshotEvents = source.snapshotEvents;
        if (typeof snapshotEvents === 'function') {
            const events = snapshotEvents.call(session);
            return Array.isArray(events) ? events : undefined;
        }
        const events = source.events;
        return Array.isArray(events) ? events : undefined;
    }
    catch {
        return undefined;
    }
}
