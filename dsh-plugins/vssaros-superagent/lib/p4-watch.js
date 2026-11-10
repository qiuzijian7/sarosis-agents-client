import { R as liveTicket, o as health, r as pause, s as sourceContext } from "./poll-Btx7A8Qk.js";
import { d as readChange, l as p4Configured, r as changesOf, s as observeChange, t as P4ConfigSchema } from "./p4-change-BdyYHiZ1.js";
//#region src/sources/p4.ts
/** An error health once `failures` consecutive checks fail, as the GitHub Source does, so one network blip stays quiet. */
const pollFailure = (failures, threshold, error) => failures >= threshold ? health("error", "pollFailures", {
	count: String(failures),
	error: String(error)
}) : void 0;
const p4Kind = {
	kind: "p4",
	title: {
		zh: "P4",
		en: "P4"
	},
	description: {
		zh: "执行器在 Perforce 里签出和修改代码的服务器与账号。工单的 CL 由执行器 shelve 后报告；CL 提交后工单结束，删除后工单关闭。提交只在人审核同意后进行。",
		en: "The Perforce server and account the Executor checks out and edits code with. The Executor shelves and reports a ticket's CL; the ticket ends once the CL is submitted, and closes once it is deleted. A CL is submitted only after a person reviews and approves it."
	},
	schema: P4ConfigSchema,
	fields: [
		{
			key: "port",
			type: "text",
			label: {
				zh: "服务器（P4PORT）",
				en: "Server (P4PORT)"
			},
			hint: {
				zh: "例如 ssl:p4.example.com:1666。",
				en: "Such as ssl:p4.example.com:1666."
			}
		},
		{
			key: "user",
			type: "text",
			label: {
				zh: "执行账号（P4USER）",
				en: "Execution account (P4USER)"
			},
			hint: {
				zh: "执行器以它签出、修改和 shelve。这个账号在服务器上应当只有 open 权限：提交由人审核同意后进行。",
				en: "The Executor checks out, edits and shelves as this account. It should have only open access on the server: a person approves each submit."
			}
		},
		{
			key: "paths",
			type: "rows",
			label: {
				zh: "允许签出的路径",
				en: "Paths that may be checked out"
			},
			hint: {
				zh: "depot 路径，可以用 ... 和 *，例如 //GR/main/Source/...。CL 里有一个文件不在这些路径下，就不能关联到工单。",
				en: "Depot paths, with ... and *, such as //GR/main/Source/.... A CL with any file outside them cannot bind to a ticket."
			},
			columns: [{
				key: "path",
				type: "text",
				label: {
					zh: "路径",
					en: "Path"
				},
				pattern: "//\\S+"
			}]
		},
		{
			key: "submit",
			type: "select",
			label: {
				zh: "审核同意后怎样提交",
				en: "How an approved CL is submitted"
			},
			options: [{
				value: "pipeline",
				label: {
					zh: "交给流水线",
					en: "Hand to the pipeline"
				}
			}, {
				value: "host",
				label: {
					zh: "由本机提交",
					en: "Submit from this machine"
				}
			}],
			hint: {
				zh: "交给流水线：同意后在 CL 描述末尾加上面的标签，由服务器的提交流水线提交。由本机提交：dsh-superagent 以提交账号把这个 shelve unshelve 到提交工作区再提交。两种方式都只在人审核同意、且 shelve 内容与审核时一致之后进行。",
				en: "Hand to the pipeline: an approval adds the tags above to the CL description and the server's submit automation submits it. Submit from this machine: dsh-superagent unshelves the CL into the submit workspace and submits it as the submit account. Either happens only after a person approves it and the shelf still matches what they reviewed."
			}
		},
		{
			key: "pipelineTags",
			type: "text",
			label: {
				zh: "流水线标签",
				en: "Automation tags"
			},
			hint: {
				zh: "交给流水线时加到 CL 描述末尾，例如 #review #ShelveForSubmit。",
				en: "Added to the CL description when handing it over, such as #review #ShelveForSubmit."
			}
		},
		{
			key: "submitUser",
			type: "text",
			label: {
				zh: "提交账号",
				en: "Submit account"
			},
			hint: {
				zh: "由 dsh-superagent 提交时使用；通常是审核人本人，本机须已 p4 login。",
				en: "Used when dsh-superagent submits; usually the reviewer, signed in on this machine with p4 login."
			}
		},
		{
			key: "submitClient",
			type: "text",
			label: {
				zh: "提交工作区",
				en: "Submit workspace"
			},
			hint: {
				zh: "提交账号的工作区，CL 先 unshelve 到这里再提交。",
				en: "The submit account's workspace, which the CL is unshelved into before it is submitted."
			}
		},
		{
			key: "cli",
			type: "text",
			advanced: true,
			label: {
				zh: "p4 命令",
				en: "p4 command"
			},
			hint: {
				zh: "命令名或 p4.exe 的绝对路径。",
				en: "A command name or the absolute path of p4.exe."
			}
		},
		{
			key: "pollSeconds",
			type: "number",
			advanced: true,
			min: 30,
			max: 3600,
			label: {
				zh: "检查 CL 的间隔 / 秒",
				en: "CL check interval / seconds"
			}
		},
		{
			key: "failuresBeforeError",
			type: "number",
			advanced: true,
			min: 1,
			max: 20,
			label: {
				zh: "连续失败几次后报告异常",
				en: "Failed checks before reporting an error"
			}
		}
	],
	health: ["p4"],
	find: (query) => {
		const number = /^(?:cl|change|changelist)\s*#?(\d+)$/i.exec(query.trim())?.[1] ?? /^(\d+)@p4$/i.exec(query.trim())?.[1];
		return {
			threads: number ? [`p4:${number}`] : [],
			terms: []
		};
	},
	environment: {
		variables: [
			{
				key: "DSH_SUPERAGENT_P4_PORT",
				description: {
					zh: "P4 服务器；p4 命令都带 -p 它",
					en: "The P4 server; pass it to every p4 command as -p"
				}
			},
			{
				key: "DSH_SUPERAGENT_P4_USER",
				description: {
					zh: "执行账号；p4 命令都带 -u 它，不用其他账号。工作区名以 -$DSH_SUPERAGENT_NAME 结尾，CL 才能关联到工单",
					en: "The execution account; pass it to every p4 command as -u, never another account. A CL binds to the ticket only from a workspace whose name ends with -$DSH_SUPERAGENT_NAME"
				}
			},
			{
				key: "DSH_SUPERAGENT_P4_PATHS",
				description: {
					zh: "允许签出的 depot 路径，以空格分隔；不在其中的文件不要签出",
					en: "Depot paths that may be checked out, separated by spaces; check out no file outside them"
				}
			}
		],
		values: ({ config }) => ({
			DSH_SUPERAGENT_P4_PORT: config.port,
			DSH_SUPERAGENT_P4_USER: config.user,
			DSH_SUPERAGENT_P4_PATHS: config.paths.map((item) => item.path).join(" ")
		})
	}
};
const name = "dsh-superagent-p4";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(p4Kind), "p4: source kind");
	ctx.effect(() => {
		const source = sourceContext(ctx.orchestrator, p4Kind);
		const controller = new AbortController();
		const running = watch(source, controller.signal).catch((error) => {
			source.report("p4", {
				state: "error",
				detail: String(error)
			});
		});
		return async () => {
			controller.abort();
			await running;
		};
	});
}
async function watch(ctx, signal) {
	let failures = 0;
	await ctx.ready;
	if (!ctx.configured()) {
		ctx.report("p4", health("paused", "setupPending"));
		return;
	}
	while (!signal.aborted) {
		const config = ctx.config("p4");
		try {
			if (!config) ctx.report("p4", health("paused", "sourceOff"));
			else if (!p4Configured(config)) ctx.report("p4", health("paused", "p4Unset"));
			else {
				await pollChanges(ctx, config);
				ctx.report("p4", {
					state: "ready",
					detail: ""
				});
			}
			failures = 0;
		} catch (error) {
			failures += 1;
			const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error);
			if (!signal.aborted && failed) ctx.report("p4", failed);
		}
		await pause((ctx.config("p4")?.pollSeconds ?? 60) * 1e3, signal);
	}
}
/** Reads each open CL that an open ticket follows, and reports the ones that were submitted or deleted. */
async function pollChanges(ctx, config) {
	const numbers = [...new Set(ctx.tickets.open().filter(liveTicket).flatMap((ticket) => changesOf(ticket, true)))];
	for (const number of numbers) observeChange(ctx, number, await readChange(ctx.commands, config, number));
	return numbers.length;
}
//#endregion
export { apply, inject, name, p4Kind, pollChanges };
