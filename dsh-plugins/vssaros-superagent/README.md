# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [dev/docs/000-philosophy.md](dev/docs/000-philosophy.md) explains the principle and what it asks of the operator.

## In VsSaros

VsSaros ships it as the built-in `@vssaros/dsh-superagent` (the SuperAgent workbench, `vssaros:superagent`): the supervisor of the VsSaros Bots. Requests from Feishu, GitHub, TAPD and its own desk are evaluated under a Policy, a team of Bots is staffed and agreed to by a person, each step runs in its Bot's Session, and skills and team workflows are left behind.

This directory is the plugin as it ships (`lib/`, `cordis.patch.yml`, `prompts/`, `skills/`, `locale/`) plus `dev/`, its development workspace, which is never shipped: the source, tests, documents, examples and build tools.

- `pnpm --dir dev install` installs the toolchain; `pnpm --dir dev check` runs the typecheck, the tests and the build, which writes `lib/`. `lib/` is committed: the release pipeline builds no plugin, and `node dev/scripts/build.mjs --check` (part of the repository's `check:dsh-plugins`) says when it lags the source.
- The plugin tracks its upstream, dsh-superagent-prototype: `node dev/scripts/upstream-patches.mjs` writes `dev/vssaros-patches.diff` in the upstream's layout (see `vssarosPatches` in `package.json`).

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [dev/SETUP.md](dev/SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](dev/docs/000-philosophy.md)
- [001 Domain model](dev/docs/001-domain.md)
- [002 Authorization](dev/docs/002-authorization.md)
- [003 Execution](dev/docs/003-execution.md)
- [004 Prompts](dev/docs/004-prompts.md)
- [005 Panel](dev/docs/005-panel.md)
- [006 Deployment](dev/docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](dev/docs/007-architecture.md)
- [008 Cookbook](dev/docs/008-cookbook.md): adding a Source

## Development

`pnpm check` (in `dev/`) runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
