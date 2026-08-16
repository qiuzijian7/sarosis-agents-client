// @ts-nocheck
// No-op shiki grammar stub.
//
// Some curated grammars embed `cpp`/`cpp-macro` via shiki's `embeddedLangs`
// (e.g. `sql` embeds `cpp`, `c` embeds `glsl` which embeds `cpp`). Those
// embedded imports are resolved at highlight time and bypass our
// `bundledLanguagesInfo` allow-list, so `cpp` (≈437 KB) + `cpp-macro` (≈244 KB)
// would always be pulled into the IIFE bundle no matter what we drop from the
// allow-list.
//
// Redirecting `@shikijs/langs/cpp` and `@shikijs/langs/cpp-macro` here (see
// shikiLangStubPlugin in esbuild.kbblocks.config.mjs) keeps the embedder
// grammars working while dropping the 681 KB payload. The embedded C++ regions
// simply won't be tokenized (they degrade gracefully thanks to the
// `forgiving` JS regex engine); C++ is not a selectable language in the
// code-block dropdown either.
const stub = {
	name: 'C++',
	scopeName: 'source.cpp',
	patterns: [],
	embeddedLangs: [],
};

export default stub;
