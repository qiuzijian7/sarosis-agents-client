/**
 * Curated Prism language registry for the KB markdown code highlighter.
 *
 * We deliberately import `PrismLight` (and the specific `one-dark` style)
 * directly from their deep ESM paths instead of the package root. The root
 * re-exports the full `Prism` build, which bundles *every* refractor language
 * (~587KB of raw grammar definitions) into the webview bundle even when a
 * note has zero code blocks. `PrismLight` only pulls in `refractor/core`, and
 * each language is registered explicitly below — so the bundle carries only
 * the grammars we actually import.
 *
 * Languages outside this whitelist still render (unhighlighted) without
 * crashing; the `alias()` calls map common short names onto the registered
 * grammars.
 */
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';

import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import clike from 'react-syntax-highlighter/dist/esm/languages/prism/clike';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import json5 from 'react-syntax-highlighter/dist/esm/languages/prism/json5';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';

// Super-sets / extensions that build on the base grammars above.
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import cssExtras from 'react-syntax-highlighter/dist/esm/languages/prism/css-extras';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import objectivec from 'react-syntax-highlighter/dist/esm/languages/prism/objectivec';
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala';
import dart from 'react-syntax-highlighter/dist/esm/languages/prism/dart';
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua';
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl';
import haskell from 'react-syntax-highlighter/dist/esm/languages/prism/haskell';
import elixir from 'react-syntax-highlighter/dist/esm/languages/prism/elixir';
import erlang from 'react-syntax-highlighter/dist/esm/languages/prism/erlang';
import clojure from 'react-syntax-highlighter/dist/esm/languages/prism/clojure';
import julia from 'react-syntax-highlighter/dist/esm/languages/prism/julia';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import protobuf from 'react-syntax-highlighter/dist/esm/languages/prism/protobuf';
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile';
import nginx from 'react-syntax-highlighter/dist/esm/languages/prism/nginx';
import git from 'react-syntax-highlighter/dist/esm/languages/prism/git';
import http from 'react-syntax-highlighter/dist/esm/languages/prism/http';
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell';

const LANGUAGES: Record<string, unknown> = {
	markup,
	css,
	clike,
	c,
	javascript,
	json,
	json5,
	bash,
	yaml,
	python,
	markdown,
	jsx,
	typescript,
	tsx,
	'css-extras': cssExtras,
	scss,
	less,
	php,
	cpp,
	csharp,
	java,
	go,
	rust,
	ruby,
	kotlin,
	swift,
	objectivec,
	scala,
	dart,
	lua,
	r,
	perl,
	haskell,
	elixir,
	erlang,
	clojure,
	julia,
	sql,
	graphql,
	docker,
	ini,
	toml,
	diff,
	protobuf,
	makefile,
	nginx,
	git,
	http,
	powershell,
};

for (const [name, def] of Object.entries(LANGUAGES)) {
	PrismLight.registerLanguage(name, def as never);
}

// Common short aliases → registered grammar.
PrismLight.alias('markup', ['html', 'xml', 'svg', 'mathml', 'ssml', 'atom', 'rss']);
PrismLight.alias('javascript', ['js', 'jsx', 'mjs', 'cjs', 'tc39']);
PrismLight.alias('typescript', ['ts']);
PrismLight.alias('tsx', ['tsx']);
PrismLight.alias('bash', ['sh', 'shell', 'zsh', 'fish', 'console']);
PrismLight.alias('yaml', ['yml']);
PrismLight.alias('markdown', ['md', 'mkd']);
PrismLight.alias('python', ['py', 'py3', 'gyp']);
PrismLight.alias('ruby', ['rb', 'gemspec', 'podspec', 'thor', 'irb']);
PrismLight.alias('csharp', ['cs']);
PrismLight.alias('cpp', ['hpp', 'h++', 'c++', 'cc', 'hh']);
PrismLight.alias('c', ['h']);
PrismLight.alias('kotlin', ['kt', 'kts']);
PrismLight.alias('rust', ['rs']);
PrismLight.alias('perl', ['pl', 'pm']);
PrismLight.alias('elixir', ['ex', 'exs']);
PrismLight.alias('erlang', ['erl']);
PrismLight.alias('haskell', ['hs']);
PrismLight.alias('clojure', ['clj', 'edn']);
PrismLight.alias('lua', ['lua']);
PrismLight.alias('scala', ['sc', 'sbt']);
PrismLight.alias('dart', ['dart']);
PrismLight.alias('go', ['go']);
PrismLight.alias('json', ['jsonc']);
PrismLight.alias('sql', ['sqlite', 'postgres', 'postgresql', 'mysql', 'plsql']);

export { PrismLight, oneDark };
