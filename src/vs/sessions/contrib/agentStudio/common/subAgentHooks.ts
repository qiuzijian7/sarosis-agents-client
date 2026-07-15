/*---------------------------------------------------------------------------------------------
 *  Sub-Agent ReAct Hooks: postStop (MiMo-Code-inspired)
 *
 *  MiMo-Code lets plugins drive an extra ReAct round after a sub-agent "finishes"
 *  (preStop/postStop hooks, bounded by MAX_PRE_REACT / MAX_POST_REACT). We implement the
 *  practical, high-value half: a `postStop` self-verification round. After the sub-agent's
 *  main execution completes and the Completion Gate runs, if a `postStop` hook is
 *  configured AND the structured result is not already a clean success-with-acceptance, we
 *  append a verification prompt as a follow-up user message and run one more bounded turn.
 *
 *  The decision helper (`defaultPostStopDecision`) is pure + dependency-free → unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { ISubAgentStructuredResult } from './completionGate.js';

export interface ISubAgentPostStopHook {
	/** Verification prompt injected as a follow-up user message. */
	readonly verifyPrompt: string;
	/** Max additional self-verify rounds (default 1). Bounded to avoid infinite loops. */
	readonly maxRounds?: number;
}

export type PostStopDecision =
	| { readonly kind: 'return' }
	| { readonly kind: 'retry'; readonly followUpMessage: string };

export const DEFAULT_VERIFY_PROMPT =
	'Self-verify: re-read the files you modified and confirm the task is actually complete. ' +
	'If anything is missing or broken, fix it now. Then end with a <result status="..."> marker.';

/**
 * Decide whether to return the result or run another self-verification round.
 * Bounded by `maxRounds`. A clean success-with-acceptance never re-verifies.
 */
export function defaultPostStopDecision(
	result: { readonly structured?: ISubAgentStructuredResult | undefined },
	round: number,
	maxRounds: number,
): PostStopDecision {
	if (round >= maxRounds) {
		return { kind: 'return' };
	}
	const s = result.structured;
	// Already a clean success with acceptance met → no need to re-verify.
	if (s && s.status === 'success' && s.acceptanceMet) {
		return { kind: 'return' };
	}
	return { kind: 'retry', followUpMessage: DEFAULT_VERIFY_PROMPT };
}
