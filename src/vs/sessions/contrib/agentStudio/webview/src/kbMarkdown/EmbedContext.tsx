/* Cycle-detection context for note embeds (`![[note]]`). Mirrors Glyph's
 * `EmbedContext`: each rendered document extends the ancestor chain with its own
 * file path, so a nested embed pointing back at an already-rendering file is
 * caught and rendered as broken instead of recursing forever. */

import { createContext, useContext } from 'react';
import type { WorkspaceFile } from './types';

export interface EmbedContextValue {
	workspaceFiles: WorkspaceFile[];
	onOpenWikilink?: (uri: string, heading?: string) => void;
	chain: string[];
}

const EmbedContext = createContext<EmbedContextValue>({ workspaceFiles: [], chain: [] });

export const EmbedProvider = EmbedContext.Provider;

export function useEmbedContext(): EmbedContextValue {
	return useContext(EmbedContext);
}
