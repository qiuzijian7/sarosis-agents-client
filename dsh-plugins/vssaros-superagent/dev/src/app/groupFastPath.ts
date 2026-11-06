/**
 * 2026-11-05 P0: a person asks the supervisor desk to make a group of Bots. That request used to wait for the orchestrator
 * model to classify it and call `orchestrator_team_create_group` (~44s in the 19:20 log). A group chat is a deterministic
 * side effect, so the desk intake now makes it at once and records the Trigger as ignored; the main Session never has to
 * reason about it. The Bots plugin reuses a group with the same `originTriggerId`, so the desk's automatic intake,
 * `superagent_submit`, and any later model tool call are all idempotent.
 *
 * The same intake also recognises `@已有群` with DSH's paired `session-reference` event: the Bots plugin owns the relay,
 * so SuperAgent only records an `ignore` decision and does not spend another main-Session model evaluation on it.
 */
import type { ReceiveResult, Trigger } from '../core/index.ts'
import type { GroupRouteKind } from './group-routes.ts'
import type { GroupView } from './team.ts'

/** A Bot the roster offers; `delegatable` is enough to decide who can join a group. */
export interface FastGroupBot { id: string; name: string; delegatable?: boolean }
export interface FastGroupPlan { members: string[]; name: string; notice: string; mode: 'admin' }
/** DSH 外壳把「引用会话」单独发成一条 `user/message`，`source.kind` 是它。 */
export const GROUP_REFERENCE_KIND = 'session-reference';
/**
 * 一条以 @ 开头的桌面消息最多等它的引用事件多久再走常规路径。原来是 40ms：引用事件晚到一点，
 * 消息就交给了主管模型，而 agents 插件（15 秒窗口）照样把它转进群——同一条消息两头都处理。
 */
export const GROUP_REFERENCE_WAIT_MS = 1500;
/** 引用事件晚于等待窗口到达时，仍按 @群 补记的最长间隔；与 agents 插件 rooms.js 的配对窗口相同。 */
export const GROUP_REFERENCE_LATE_MS = 15_000;
/** 只有以 @ 开头的消息才可能是群命令（`addressedGroupMessage` 的前提）；其它消息不必等引用事件。 */
export const mayBeGroupCommand = (text: string): boolean => String(text ?? '').trim().startsWith('@');
export interface GroupReference { room: GroupView; label: string }
/**
 * What the intake settles in one go: the group a Trigger went to, the ignore decision that keeps the main Session off it,
 * and (for a new group) the notice to the person. The runtime commits them in one transaction (see group-routes.ts).
 * @throws when the route or the notice could not be written; a decision that cannot be recorded (the Trigger was decided
 *   already) is only warned about, since the route still says where the message went.
 */
export interface GroupSettlement {
  reason: string
  route: { roomId: string; roomName: string; kind: GroupRouteKind; sourceMessageId?: string }
  notice?: { id: string; text: string }
}
export interface GroupCommandHost {
  receive(trigger: Trigger): ReceiveResult
  settle(triggerId: string, settlement: GroupSettlement): void
  requestPass(): void
  listGroups(): Promise<readonly GroupView[]>
  warn(message: string): void
}
export type GroupCommandResult = 'group-command' | 'fallback'

/** 从 DSH 的 `session-reference` 事件里认出已存在的群；`sessionId` 优先，label 兜底。 */
export function groupReferenceOf(event: unknown, groups: readonly GroupView[]): GroupReference | undefined {
	const source = (event as { data?: { source?: { kind?: unknown; references?: unknown[] } } })?.data?.source
	if (source?.kind !== GROUP_REFERENCE_KIND || !Array.isArray(source.references)) { return undefined }
	for (const item of source.references) {
		const ref = item as { sessionId?: unknown; label?: unknown }
		const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId : ''
		const label = typeof ref.label === 'string' ? ref.label : ''
		const room = (groups ?? []).find(group => (sessionId && (group.id === sessionId || group.sessionId === sessionId))
			|| (label && group.name === label))
		if (room) { return { room, label: label || room.name } }
	}
	return undefined
}

/** 纯文本 `@群名` 的兜底：必须真的以 @ 开头，最长群名优先，避免把背景引用当派活。 */
export function groupByNameMention(text: string, groups: readonly GroupView[]): GroupReference | undefined {
	const body = String(text ?? '').trim()
	if (!body.startsWith('@')) { return undefined }
	const room = [...(groups ?? [])].sort((a, b) => String(b.name).length - String(a.name).length)
		.find(group => group.name && (body.includes(`@${group.name}`) || body.includes(`@[${group.name}]`)))
	return room ? { room, label: room.name } : undefined
}

export function addressedGroupMessage(text: string, ref: GroupReference): boolean {
	const body = String(text ?? '').trim()
	const label = String(ref?.label || ref?.room?.name || '')
	return !!label && body.startsWith('@') && (body.includes(`@${label}`) || body.includes(`@[${label}]`))
}

/**
 * `@已有群 …` 由 agents 插件确定性转投到群会话；这里只把 SuperAgent Trigger 记为 ignore 并记下它去了哪个群，
 * 不让 main Session 再花一轮模型把它判成 ignore。失败时回到原 intake 路径。
 * `late`：引用事件在等待窗口之后才到，消息已经走了常规路径（Eval 可能已开始）。仍然记 ignore（结束那次 Eval），
 * 与 agents 插件 15 秒的配对窗口保持一致，避免「群在做、主管也在评估」两头都处理。
 */
export async function handleDeskGroupCommand(
	host: GroupCommandHost, trigger: Trigger, text: string, referenceEvent?: unknown,
	options: { sourceMessageId?: string; late?: boolean } = {},
): Promise<GroupCommandResult> {
	let ref: GroupReference | undefined
	try {
		const groups = await host.listGroups()
		ref = groupReferenceOf(referenceEvent, groups) ?? groupByNameMention(text, groups)
	} catch (error) {
		host.warn(`group command fast path could not read groups: ${String(error)}`)
		return 'fallback'
	}
	if (!ref || !addressedGroupMessage(text, ref)) { return 'fallback' }
	let received = false
	try {
		const result = host.receive(trigger)
		received = true
		if (result === 'filtered') { return 'fallback' }
		try {
			host.settle(trigger.id, {
				reason: `Routed to existing group${options.late ? ' (late reference)' : ''}: ${ref.room.name}`,
				route: { roomId: ref.room.id, roomName: ref.room.name, kind: 'routed',
					...options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {} },
			})
			host.requestPass()
		} catch (error) {
			host.warn(`group command fast path could not record where the message went: ${String(error)}`)
		}
		return 'group-command'
	} catch (error) {
		host.warn(`group command fast path failed: ${String(error)}`)
		return received ? 'group-command' : 'fallback'
	}
}

/**
 * Does this message ask for a group of Bots? Deliberately broad: 「创建开发团队，制作…」 was the real request that took
 * 44s, while 「@群名 开始制作」 is a command to an existing group and must not create another one.
 */
export function isGroupCreationRequest(text: string): boolean {
	const body = String(text ?? '').trim()
	if (!body || body.startsWith('@')) { return false }
	return /(?:建|拉|创建|组建|成立)[^，,。！!？?]{0,12}(?:群|团队)|群聊/u.test(body)
}

/** Derive a stable group name and shared notice from the request, and pick up to three suitable Bots. */
export function fastGroupPlan(text: string, roster: readonly FastGroupBot[]): FastGroupPlan | undefined {
	if (!isGroupCreationRequest(text)) { return undefined }
	const pool = (Array.isArray(roster) ? roster : []).filter(bot => bot?.id && bot.id !== 'superagent' && bot.delegatable !== false)
	const ids: string[] = []
	const take = (match: RegExp): FastGroupBot | undefined => {
		const hit = pool.find(bot => !ids.includes(bot.id) && match.test(`${bot.id} ${bot.name}`))
		if (hit) { ids.push(hit.id) }
		return hit
	}
	const coder = take(/^(?:coder|developer|front[- ]?end|开发|前端|工程师|code)/i)
	const designer = take(/^(?:designer|ui|ux|设计|产品)/i)
	const reviewer = take(/^(?:code[- ]?reviewer|reviewer|审查|评审)/i)
	// VsSaros addition (2026-11-06): a request to build something also gets the tester, who previews it in the browser.
	const tester = BUILD_WORDS.test(text) ? take(/^(?:tester|qa\b|测试)/i) : undefined
	if (!reviewer && !tester) take(/^(?:qa\b|tester|测试)/i)
	const size = tester ? 4 : 3
	for (const bot of pool) {
		if (ids.length >= size) { break }
		if (!ids.includes(bot.id)) { ids.push(bot.id) }
	}
	if (ids.length < 2) { return undefined }
	const explicit = /(?:群名|名称|叫|名为)\s*[「"']?([^」"'\n，,。]{2,40})/u.exec(text)
	const body = String(text).replace(/^(?:请|帮我|麻烦)?(?:建|拉|创建|组建|成立)[^，,。]*?(?:群|团队)[，,：:\s]*/u, '').trim()
	const goal = body.replace(/^(?:制作|开发|做|实现|完成)(?:一个)?/u, '').trim().replace(/[。！!？?，,]+$/u, '')
	const name = (explicit?.[1]?.trim() || (goal ? `${goal.slice(0, 40)} 开发团队` : '开发团队群')).slice(0, 60)
	const nameOf = (bot: FastGroupBot | undefined) => bot?.name
	const flow = coder && tester ? groupFlowNotice({ coder: nameOf(coder)!, tester: nameOf(tester)!, designer: nameOf(designer), reviewer: nameOf(reviewer) }) : ''
	const request = (body || text).slice(0, 2000 - (flow ? flow.length + 2 : 0))
	return { members: ids.slice(0, size), name, notice: flow ? `${request}\n\n${flow}` : request, mode: 'admin' }
}

/** Words of a request to build something, which then gets a tester in its group. */
const BUILD_WORDS = /开发|制作|做一?个|实现|应用|app\b|h5|网页|页面|小程序|游戏|测试|预览|验收|上线/iu

/**
 * VsSaros addition (2026-11-06): the group's notice that chains the members (design → develop → review → test in a browser,
 * bugs back to the developer, re-test at most 3 times), as DeepSeek-Bot's groups follow their notice. The Bots plugin calls
 * a member back when the work it handed on is done, so each step's hand-over is one @.
 */
export function groupFlowNotice(names: { coder: string; tester: string; designer?: string | undefined; reviewer?: string | undefined }): string {
	const { coder, tester, designer, reviewer } = names
	return [`协作流程（每位成员都按这个接力；管理员 ${coder} 先用 group_goal 把下面几步设成群目标的阶段，每阶段写明完成标准，之后按阶段派活、验收、不过就打回）：`,
		designer ? `1. 管理员 ${coder} 先 @${designer} 出设计方案（页面、交互、样式）；${designer} 完成后 @${coder}。` : `1. ${coder} 先确认需求与方案。`,
		`2. ${coder} 开发完成后${reviewer ? ` @${reviewer} 评审；评审有问题 @${coder} 修改，评审通过后 @${tester}` : ` @${tester}`}。`,
		`3. ${tester} 在后台起本地预览服务，用浏览器打开逐项点测；有问题 @${coder}，写清「操作步骤 → 期望 → 实际」。`,
		`4. ${coder} 修完后 @${tester} 复测；最多复测 3 轮，仍有问题就列给用户决定。`,
		`5. 全部通过后由 ${tester} 向用户汇报：测过哪些功能、各自的结果。`].join('\n')
}

/**
 * The desk's notice for a group a message asked for. VsSaros addition (2026-11-06): when a group of that name existed, the
 * Bots plugin edited it (`reused`), so the notice says which members joined or left, under an id of its own per message
 * (`group-created:<room>` would be the first one's, which the desk outbox already holds and would drop).
 */
export function groupMadeNotice(group: GroupView, triggerId: string): { id: string; text: string } {
	const names = group.members.map(member => member.name)
	const admin = group.members.find(member => member.id === group.admin)?.name
	const how = `在左侧栏「Bots」页签里点开它就能在群里说话${group.mode === 'admin' ? '（普通消息先给管理员，@名字 可以直接点人）' : '（每位成员依次回答）'}。`
	if (!group.reused) {
		return { id: `group-created:${group.id}`, text: `已建群「${group.name}」：${names.join('、')}${admin ? `，管理员 ${admin}` : ''}。${how}` }
	}
	const changes = [group.added?.length ? `加入 ${group.added.join('、')}` : '', group.removed?.length ? `移出 ${group.removed.join('、')}` : ''].filter(Boolean)
	return { id: `group-updated:${group.id}:${triggerId}`,
		text: `已有同名群「${group.name}」，没有另建，${changes.length ? `已${changes.join('，')}` : '成员没有变化'}。现在的成员：${names.join('、')}${admin ? `，管理员 ${admin}` : ''}。${how}` }
}

export interface GroupFastPathHost {
  receive(trigger: Trigger): ReceiveResult
  /** Records the group, the ignore decision and the notice together (see `GroupSettlement`). */
  settle(triggerId: string, settlement: GroupSettlement): void
  /** Carries out the recorded decision without relaying the candidate to the main Session. */
  requestPass(): void
  bots(): Promise<readonly FastGroupBot[]>
  createGroup(input: FastGroupPlan & { originTriggerId: string }): Promise<GroupView>
  warn(message: string): void
  fallback(trigger: Trigger): unknown
}

export type GroupFastPathResult = 'group' | 'fallback' | 'failed'

/** Handles one desk message: group requests are made here; everything else follows the original intake path. */
export async function handleDeskMessage(host: GroupFastPathHost, trigger: Trigger, text: string): Promise<GroupFastPathResult> {
	let plan: FastGroupPlan | undefined
	try { plan = fastGroupPlan(text, await host.bots()) } catch (error) {
		host.warn(`group fast path could not read the Bot roster: ${String(error)}`)
	}
	if (!plan) { host.fallback(trigger); return 'fallback' }
	let received = false
	let created = false
	try {
		const result = host.receive(trigger)
		received = true
		if (result === 'filtered') { host.warn('group fast path: the desk Source is off; left the trigger to the normal path') }
		const group = await host.createGroup({ ...plan, originTriggerId: trigger.id })
		created = true
		try {
			host.settle(trigger.id, {
				reason: `Synchronous group chat ${group.reused ? 'updated' : 'created'}: ${group.name}`,
				route: { roomId: group.id, roomName: group.name, kind: group.reused ? 'updated' : 'created' },
				notice: groupMadeNotice(group, trigger.id),
			})
			host.requestPass()
		} catch (error) {
			host.warn(`group fast path could not record the new group: ${String(error)}`)
		}
		return 'group'
	} catch (error) {
		host.warn(`group fast path failed: ${String(error)}`)
		if (!received || !created) { host.fallback(trigger) }
		return 'failed'
	}
}
