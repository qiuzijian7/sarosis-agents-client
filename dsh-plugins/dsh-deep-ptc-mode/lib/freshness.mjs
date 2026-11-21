// Confirm the upstream declarations once before a Deep PTC conversation is created or resumed,
// instead of polling. The host resolves a session's preset right before mounting it; wrapping that
// call lets a changed declaration be re-derived first, so the new conversation gets the fresh preset.
const FRESH_MARK = Symbol.for('dsh-deep-ptc-mode.freshness');
export const CHECK_TIMEOUT_MS = 5000;

/**
 * Run `check` before the registry resolves one of `ids` (or the default when it is one of them).
 * The check never blocks a conversation longer than `timeoutMs`, and its failures are ignored.
 * @returns a disposer that restores the original method.
 */
export function checkBeforeResolve(registry, check, { ids = ['deep-ptc'], timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const original = registry?.resolve;
  if (typeof original !== 'function' || original[FRESH_MARK] === true) return () => {};
  const hadOwn = Object.hasOwn(registry, 'resolve');
  const patched = async function resolve(id, ...rest) {
    if (ids.includes(id ?? registry.defaultId)) {
      let timer;
      const timeout = new Promise(done => { timer = setTimeout(done, timeoutMs); timer.unref?.(); });
      try { await Promise.race([Promise.resolve().then(check).catch(() => {}), timeout]); } finally { clearTimeout(timer); }
    }
    return original.call(registry, id, ...rest);
  };
  Object.defineProperty(patched, FRESH_MARK, { value: true });
  Object.defineProperty(registry, 'resolve', { value: patched, configurable: true, writable: true });
  return () => {
    if (registry.resolve !== patched) return;
    if (hadOwn) Object.defineProperty(registry, 'resolve', { value: original, configurable: true, writable: true });
    else delete registry.resolve;
  };
}
