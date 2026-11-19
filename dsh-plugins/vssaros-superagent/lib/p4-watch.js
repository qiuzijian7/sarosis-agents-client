import { R as liveTicket, o as health, r as pause, s as sourceContext } from "./poll-DRgTfbJS.js";
import { d as p4Configured, i as changesOf, l as observeChange, n as P4ConfigSchema, p as readChange, t as DEFAULT_RECONCILE_IGNORE } from "./p4-change-cDDNQSBm.js";
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
		zh: "执行器在 Perforce 里签出和修改代码的服务器与账号。默认把本单改动统一归集到一个命名好的 pending CL 并 shelve，工单即完成；不自动提交，人在 P4V 自行决定何时提交。也保留需人工逐单审核的旧提交模式。",
		en: "The Perforce server and account the Executor edits code with. By default it consolidates the ticket changes into one named pending CL, re-shelves it and completes the ticket; nothing is submitted automatically, so a person decides in P4V. Legacy review-and-submit modes remain available."
	},
	schema: P4ConfigSchema,
	fields: [
		{
			key: "syncBeforeWork",
			type: "switch",
			label: {
				zh: "执行前同步到最新",
				en: "Sync to head before work"
			},
			hint: {
				zh: "默认关闭：本机 UE 工作区的 sync -n 预览有 16283 个待更新文件，其后的 diff -se 全工程扫描超过 10 分钟超时，工单会卡在启动前、看不到 worker 会话。关闭后沿用现场、不自动更新，worker 可直接启动。若要开启，请先把「允许签出的路径」收窄到本单相关文件，并确认没有未签出的本地修改；开启后由 Host 执行 sync -n 预览、resolve -am 自动合并，发现覆盖风险或冲突会停止工单。worker 仍不能执行 sync/revert/unshelve。",
				en: "Off by default: on this UE client sync -n previews 16283 updates and the following full-tree diff -se exceeded the 10-minute Host timeout, leaving tickets stuck before their worker session exists. When on, narrow the allowed paths first and clear unopened local edits; the Host previews with sync -n, merges with resolve -am and stops on any clobber risk or conflict. Workers never gain sync permission."
			}
		},
		{
			key: "checkUnopenedDiffs",
			type: "switch",
			label: {
				zh: "严格检查未签出的本地修改",
				en: "Strictly check unopened local differences"
			},
			hint: {
				zh: "默认关闭。共享工作区里的 Python 缓存、Binaries、资源文件常因 allwrite 与 depot 不一致，扫描会挡住无关生成物；CL 仍必须经 p4 edit、shelve 与人工审核。开启后启动前才执行 p4 diff -se，发现差异就列出前几个并受阻。只由人工在设置面板修改，变更会记入配置历史。",
				en: "Off by default: generated files in an allwrite client differ from the depot without being opened. Delivery still requires p4 edit, shelve and review. When on, preflight runs p4 diff -se and blocks with example files. Panel-only and recorded in config history."
			}
		},
		{
			key: "requireDelivery",
			type: "switch",
			label: {
				zh: "新 TAPD 缺陷要求 P4 交付",
				en: "Require P4 delivery for new TAPD bugs"
			},
			hint: {
				zh: "新缺陷需真实已同步的工作区和本单 shelved CL；可显式复用当前工作区，不要求独立 client。缺项受阻，不允许引用旧 CL 报完成。只影响新工单。",
				en: "New bugs require a synchronized authorized workspace and ticket-owned shelf; an explicitly configured current client is supported."
			}
		},
		{
			key: "workspaceMode",
			type: "select",
			label: {
				zh: "执行工作区模式",
				en: "Execution workspace mode"
			},
			options: [{
				value: "ticket",
				label: {
					zh: "独立工单",
					en: "Per ticket"
				}
			}, {
				value: "current",
				label: {
					zh: "当前配置",
					en: "Configured current"
				}
			}],
			hint: {
				zh: "当前配置：复用下方 client 和 Root，不运行准备命令、不自动 sync。只支持单 worker；工单及审核串行，已有他单或人工修改时先受阻。旧工单不自动迁移。",
				en: "Current uses the client and Root below without prepare/sync. Single-worker tickets and reviews are serialized; existing edits block work. No historical migration."
			}
		},
		{
			key: "executionClient",
			type: "text",
			label: {
				zh: "执行工作区（P4CLIENT）",
				en: "Execution workspace (P4CLIENT)"
			},
			hint: {
				zh: "填写 P4V 中的工作区名称，例如 GR_qiuzijian_main。不要填写 F:\\GR_qiuzijian_main 等磁盘路径；磁盘目录填在下方 Root。",
				en: "Enter the workspace name shown in P4V, such as GR_qiuzijian_main, not a disk path. Enter the local directory in Root below."
			},
			note: {
				zh: "填工作区名称，例如 GR_qiuzijian_main；不是磁盘路径。",
				en: "Workspace name, e.g. GR_qiuzijian_main; not a disk path."
			}
		},
		{
			key: "workspaceRoot",
			type: "text",
			label: {
				zh: "执行工作区 Root",
				en: "Execution workspace Root"
			},
			hint: {
				zh: "本地绝对路径，必须与 P4 client 的 Root 相同；例如 F:\\GR_qiuzijian_main。",
				en: "Absolute local path matching the client Root."
			}
		},
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
				zh: "交付方式",
				en: "Delivery mode"
			},
			options: [
				{
					value: "pending",
					label: {
						zh: "仅保留 pending（不提交）",
						en: "Pending only (never submit)"
					}
				},
				{
					value: "pipeline",
					label: {
						zh: "交给流水线",
						en: "Hand to the pipeline"
					}
				},
				{
					value: "host",
					label: {
						zh: "由本机提交",
						en: "Submit from this machine"
					}
				}
			],
			hint: {
				zh: "默认「仅保留 pending」：Host 把本单所有修改统一归集到一个按下方模板命名的 pending CL 并重新 shelve，工单随即完成；系统不 submit、不 unshelve，也不创建提交审核。人在 P4V 审阅后自行决定何时提交。另两种为旧自动提交模式，需人逐单审核同意。",
				en: "Default pending only: the Host consolidates all changed files into one named pending CL, re-shelves it, and the ticket completes. Nothing is submitted or unshelved and no review is created; a person submits in P4V. The other two are legacy submit modes requiring per-CL approval."
			}
		},
		{
			key: "pendingName",
			type: "text",
			label: {
				zh: "Pending CL 名称",
				en: "Pending CL name"
			},
			hint: {
				zh: "支持 {ticket}（工单号）和 {title}（工单标题）。系统会自动补上工单归属标记；该 CL 永远保持 pending。",
				en: "Supports {ticket} and {title}. The ticket marker is appended automatically; the CL always stays pending."
			}
		},
		{
			key: "reconcileFallback",
			type: "switch",
			label: {
				zh: "交付时兜底 reconcile 已 opened 文件",
				en: "Reconcile opened files on delivery"
			},
			hint: {
				zh: "默认关闭。关闭时交付只读取 p4 opened 并用 p4 reopen 归集，不遍历工程、不执行 reconcile。开启后才对 p4 opened 报出的具体文件分批执行 reconcile -e -a -d -c（绝不传 ... 或 * 通配），用于兜底修正文件类型/删除状态。UE 大工程切勿用通配路径扫描。仅人工面板可改，变更留痕。",
				en: "Off by default. Delivery then only reads p4 opened and uses p4 reopen: no tree walk, no reconcile. When on, reconcile -e -a -d -c runs in batches on the exact files p4 opened reported, never a wildcard path. Panel-only; changes are recorded."
			}
		},
		{
			key: "reconcileIgnore",
			type: "rows",
			label: {
				zh: "不执行 reconcile 的目录／文件",
				en: "Paths excluded from reconcile"
			},
			defaults: DEFAULT_RECONCILE_IGNORE,
			hint: {
				zh: "下面显示的是内置默认清单（未单独保存时也照此生效），可直接增删并保存。可填目录名（Binaries、__pycache__）、文件名后缀（*.pyc）或完整 //depot/... 路径。命中的文件不会传给 reconcile、reopen，也不会进入 pending CL。",
				en: "The built-in default list below is shown explicitly and applies even before it is saved; edit and save to customize. Use directory names (Binaries, __pycache__), file suffixes (*.pyc) or full //depot/... patterns. Matches are never passed to reconcile/reopen or added to the pending CL."
			},
			columns: [{
				key: "path",
				type: "text",
				label: {
					zh: "目录名／文件规则",
					en: "Directory or file rule"
				}
			}]
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
					zh: "执行账号；p4 命令都带 -u 它，不用其他账号。工作区按工单快照授权；当前模式用精确 client，独立模式用工单后缀",
					en: "The execution account; pass it to every p4 command as -u, never another account. Use the ticket-authorized client; per-ticket mode requires the ticket suffix"
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
