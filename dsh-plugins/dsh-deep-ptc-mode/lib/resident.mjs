// Which external tools stay in the initial PTC SDK and are never quarantined.
// Any plugin can opt in with `resident: true`. Screen-control tools are recognised
// from their own definition or provider string, not from a pinned package list.

const SCREEN_NAMES = new Set(['intent', 'collect', 'tap_xy']);
const PROVIDER_MARK = /dsh-go|screen-control|computer-use|phone-control/iu;

function presentationOf(definition) {
  const presentation = definition.presentationMeta ?? definition.presentation;
  return presentation && typeof presentation === 'object' ? presentation : undefined;
}

/**
 * @param {object | null | undefined} definition live tool definition
 * @param {string} [provider] module or plugin that declared it
 * @returns {boolean}
 */
export function staysResident(definition, provider = '') {
  if (!definition || typeof definition !== 'object') return false;
  if (definition.resident === true || definition.deepPtc?.resident === true) return true;
  const presentation = presentationOf(definition);
  if (presentation && Object.prototype.hasOwnProperty.call(presentation, 'dsh-go/view')) return true;
  const name = typeof definition.name === 'string' ? definition.name : '';
  if (SCREEN_NAMES.has(name) || name.startsWith('screen_')) return true;
  const owner = `${provider}\n${typeof definition.deepPtc?.provider === 'string' ? definition.deepPtc.provider : ''}`;
  return PROVIDER_MARK.test(owner);
}
