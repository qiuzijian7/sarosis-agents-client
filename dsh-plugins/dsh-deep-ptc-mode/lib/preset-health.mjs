// Reading the host's mount diagnosis of the deep-ptc preset.
//
// `agentPresets.compositionInventory()` reports one line per unusable row (see the registry's
// `diagnostic`). A row that failed to start is final. A row whose injected service has not appeared
// yet ("<id> (<module>): waiting for <services>") may still come up by itself, so it is not a reason
// to give up the full preset.

const WAITING = /^.+ \(.+\): waiting for .+$/u;

/**
 * Split a host diagnosis into failed and waiting rows.
 * @param broken - the `broken` text of an inventory row, or undefined.
 * @returns `{ failed, pending }`, one line each.
 */
export function classifyDiagnosis(broken) {
  const failed = [];
  const pending = [];
  if (typeof broken !== 'string') return { failed, pending };
  for (const line of broken.split(/\r?\n/u).map(text => text.trim()).filter(Boolean)) {
    (WAITING.test(line) ? pending : failed).push(line);
  }
  return { failed, pending };
}

// Rows of Deep PTC's execution group: the group, its executor, shell tool and instructions.
const EXECUTION_ROW = /^(?:execution(?:-\d+)?|executor|tool-(?:bash|pwsh|zsh)|execution-instructions)\b|\((?:dsh-deep-ptc-mode\/(?:executor|terminal|environment)|cordis:group)\)/u;

/**
 * Whether a failed diagnosis line belongs to the execution group. Safe mode keeps the selected
 * shell unless one of these failed, so a broken unrelated row never switches the shell.
 * @param line - one failed line, `<id> (<module>): <reason>`.
 */
export function touchesExecution(line) {
  return EXECUTION_ROW.test(String(line ?? ''));
}
