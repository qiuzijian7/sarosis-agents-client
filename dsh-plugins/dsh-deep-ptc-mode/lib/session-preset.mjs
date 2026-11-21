// The host records blank-session selections after the immutable creation header.
// Use its current projection when available, including an explicit empty selection.
export function isDeepPtcSession(ctx, session) {
  if (!session) return false;
  const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : ctx.agentPresets;
  const preset = typeof registry?.presetForSession === 'function'
    ? registry.presetForSession(session) : session.header?.agentPreset;
  return preset === 'deep-ptc';
}
