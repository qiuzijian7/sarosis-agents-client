/*──────────────────────────────────────────────────────────────
 * 定时任务工具（cronjob）
 *
 * 2026-09-11 补全：与 `drawio` / `session_search` / `vision_analyze` /
 * `video_generate` / `text_to_speech` 同源的半成品 —— 调度能力**完整实现且已有 UI**，
 * 唯独缺 LLM 工具入口：
 *   - `IAgentSchedulerService`（`common/agentScheduler.ts`）：registerCron /
 *     listSchedules / pauseSchedule / resumeSchedule / removeSchedule / getExecutionHistory
 *   - Cron 解析与校验：`common/cronParser.ts`（`isValidCronExpression`）
 *   - 测试：`test/browser/agentSchedulerService.test.ts`
 *   - 设置 UI：`scheduleViewRenderer`（定时任务视图）
 *   - 工具名映射：`agentToolIsolator.ts` 的 `CRON: 'cronjob'`
 * 但 `name: 'cronjob'` 全仓只出现在 bundled 定义里 → 注册成 stub → `listTools`
 * 跳过 → **模型看不到**（无法用自然语言创建定时任务）。
 *
 * ★ 语义以**本地调度器能力**为准，而非 bundled 里 Hermes 的 action 枚举 ——
 * bundled 定义了 `trigger` 动作，但本地的 `triggerNow()` 只存在于 `IScheduleHandle`
 * 实例上（`registerCron` 的返回值），**没有「按 id 触发」的 API**，故本工具不提供
 * `trigger`（提供会是个永远失败的入口）。
 *──────────────────────────────────────────────────────────────*/

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentSchedulerService, IScheduleInfo } from '../../../common/agentScheduler.js';
import { isValidCronExpression } from '../../../common/cronParser.js';

export const CRONJOB_TOOL_NAME = 'cronjob';

/** 单次 list / history 返回的最大条数。 */
const MAX_LIST_ITEMS = 50;
const DEFAULT_HISTORY_LIMIT = 10;

export interface SchedulerToolContext {
	register: (descriptor: { definition: any; handler: any }) => void;
	logService: ILogService;
	scheduler: IAgentSchedulerService;
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function formatSchedule(s: IScheduleInfo): string {
	const cfg = s.config as { cronExpression?: string };
	const when = cfg.cronExpression ? ` @ ${cfg.cronExpression}` : '';
	const next = s.nextFireAt ? new Date(s.nextFireAt).toISOString() : 'n/a';
	return `- 「${s.name}」 id=${s.id} [${s.type}${when}] state=${s.state} `
		+ `next=${next} runs=${s.totalExecutions} failures=${s.totalFailures}`;
}

export function registerSchedulerTools(ctx: SchedulerToolContext): void {
	ctx.register({
		definition: {
			name: CRONJOB_TOOL_NAME,
			description: 'Manage scheduled tasks (cron jobs) that run this agent automatically. '
				+ 'Use this when the user asks for something recurring ("每天早上 9 点提醒我…", "every Monday…", "每小时检查一次…").\n\n'
				+ 'Parameters:\n'
				+ '- `action` (required): one of `create` | `list` | `pause` | `resume` | `remove` | `history`.\n'
				+ '- `name` (create): a short human-readable job name.\n'
				+ '- `schedule` (create): standard cron expression, 5 or 6 fields (e.g. `0 9 * * 1-5` = weekdays 09:00).\n'
				+ '- `task` (create): the message/instruction to send to this agent when the job fires.\n'
				+ '- `timezone` (create, optional): IANA timezone, e.g. `Asia/Shanghai` (default: system local).\n'
				+ '- `schedule_id` (pause/resume/remove/history): the id returned by `create` or listed by `list`.\n\n'
				+ 'Notes:\n'
				+ '- The job targets **this agent**, so `task` should be phrased as an instruction to yourself.\n'
				+ '- Call `list` first if you need the `schedule_id` to pause/resume/remove.\n'
				+ '- Scheduling is literal cron; verify the expression matches what the user asked for.',
			inputSchema: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: ['create', 'list', 'pause', 'resume', 'remove', 'history'],
						description: 'Operation to perform.',
					},
					name: { type: 'string', description: 'Job name (create).' },
					schedule: { type: 'string', description: 'Standard cron expression, 5 or 6 fields (create), e.g. "0 9 * * 1-5".' },
					task: { type: 'string', description: 'Instruction to send to this agent when the job fires (create).' },
					timezone: { type: 'string', description: 'IANA timezone (create, optional), e.g. "Asia/Shanghai".' },
					schedule_id: { type: 'string', description: 'Target schedule id (pause/resume/remove/history).' },
				},
				required: ['action'],
			},
			category: 'cronjob',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const action = asString(args.action);
			if (!action) {
				return [{ type: 'text', text: 'cronjob error: "action" is required.' }];
			}
			if (!agentId) {
				return [{ type: 'text', text: 'cronjob error: no agent context available.' }];
			}

			try {
				switch (action) {
					case 'create': {
						const name = asString(args.name);
						const schedule = asString(args.schedule);
						const task = asString(args.task);
						if (!name || !schedule || !task) {
							return [{ type: 'text', text: 'cronjob error: create requires "name", "schedule" and "task".' }];
						}
						// 提前校验 cron：非法表达式在注册时才报错的话，模型已无从修正。
						if (!isValidCronExpression(schedule)) {
							return [{
								type: 'text',
								text: `cronjob error: "${schedule}" is not a valid cron expression. `
									+ 'Use standard 5-field syntax (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5".',
							}];
						}
						const handle = ctx.scheduler.registerCron({
							name,
							instanceId: agentId,
							cronExpression: schedule,
							timezone: asString(args.timezone),
							inputTemplate: { messageTemplate: task },
							enabled: true,
						});
						const next = handle.getNextFireTime();
						ctx.logService.info(`[cronjob] created schedule ${handle.scheduleId} (${schedule}) for agent ${agentId}`);
						return [{
							type: 'text',
							text: `[Cron] Scheduled job created.\n`
								+ `  name: ${name}\n  schedule: ${schedule}${asString(args.timezone) ? ` (${asString(args.timezone)})` : ''}\n`
								+ `  schedule_id: ${handle.scheduleId}\n`
								+ `  next run: ${next ? new Date(next).toISOString() : 'unknown'}\n`
								+ `  task: ${task}`,
						}];
					}

					case 'list': {
						const all = ctx.scheduler.listSchedules(agentId);
						if (all.length === 0) {
							return [{ type: 'text', text: '[Cron] No scheduled jobs for this agent.' }];
						}
						const shown = all.slice(0, MAX_LIST_ITEMS);
						return [{
							type: 'text',
							text: `[Cron] ${all.length} scheduled job(s)${all.length > shown.length ? ` (showing first ${shown.length})` : ''}:\n`
								+ shown.map(formatSchedule).join('\n'),
						}];
					}

					case 'pause':
					case 'resume':
					case 'remove': {
						const id = asString(args.schedule_id);
						if (!id) {
							return [{ type: 'text', text: `cronjob error: "${action}" requires "schedule_id".` }];
						}
						if (action === 'pause') { ctx.scheduler.pauseSchedule(id); }
						else if (action === 'resume') { ctx.scheduler.resumeSchedule(id); }
						else { ctx.scheduler.removeSchedule(id); }
						const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'removed';
						ctx.logService.info(`[cronjob] ${verb} schedule ${id}`);
						return [{ type: 'text', text: `[Cron] Schedule ${id} ${verb}.` }];
					}

					case 'history': {
						const id = asString(args.schedule_id);
						if (!id) {
							return [{ type: 'text', text: 'cronjob error: "history" requires "schedule_id".' }];
						}
						const runs = ctx.scheduler.getExecutionHistory(id, { limit: DEFAULT_HISTORY_LIMIT });
						if (runs.length === 0) {
							return [{ type: 'text', text: `[Cron] No execution history for schedule ${id}.` }];
						}
						const lines = runs.map(r => {
							const started = new Date(r.startedAt).toISOString();
							const err = r.error ? ` error=${r.error}` : '';
							return `  - ${started} ${r.status}${r.retryCount ? ` (retry ${r.retryCount})` : ''}${err}`;
						});
						return [{ type: 'text', text: `[Cron] Last ${runs.length} run(s) for ${id}:\n${lines.join('\n')}` }];
					}

					default:
						return [{
							type: 'text',
							text: `cronjob error: unknown action "${action}". Valid: create, list, pause, resume, remove, history.`,
						}];
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[cronjob] action=${action} failed: ${msg}`);
				return [{ type: 'text', text: `cronjob error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[SchedulerTools] Registered cronjob tool');
}
