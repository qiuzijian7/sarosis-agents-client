// @ts-nocheck
// Stub for `shiki/wasm` (the ~623 KB oniguruma wasm loader).
//
// The kbblocks bundle uses the pure-JS regex engine (see shiki-curated.ts's
// wrapped `createHighlighterCore`, which strips `loadWasm`). BlockSuite still
// does `import getWasm from 'shiki/wasm'`, so we provide a harmless default that
// is never actually invoked — keeping the wasm blob out of the IIFE bundle.
export default function getWasm() {
	throw new Error('[shiki-wasm-stub] oniguruma wasm is disabled; JS regex engine is used instead.');
}
