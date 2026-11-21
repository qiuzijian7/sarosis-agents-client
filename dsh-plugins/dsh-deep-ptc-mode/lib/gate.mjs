// Keep a registration alive only while a setting allows it, following live setting changes.
//
// @param ctx - the plugin context that owns the registration's lifetime.
// @param enabled - returns false to turn the feature off; anything else keeps it on.
// @param watch - subscribes a listener to setting changes and returns an unsubscribe function.
// @param register - performs the registration and returns its disposer.
export function gated(ctx, enabled, watch, register, label) {
  let dispose;
  const sync = () => {
    let on = true;
    try { on = enabled() !== false; } catch { /* an unreadable setting keeps the default */ }
    if (on && dispose === undefined) dispose = register() ?? (() => {});
    else if (!on && dispose !== undefined) { const stop = dispose; dispose = undefined; stop(); }
  };
  sync();
  const stop = typeof watch === 'function' ? watch(sync) : undefined;
  ctx.effect(() => () => { stop?.(); dispose?.(); dispose = undefined; }, label);
}
