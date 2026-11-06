/**
 * VsSaros addition (2026-11-06): which group chat a desk message went to.
 *
 * A group chat runs in `@vssaros/dsh-agents`, outside the orchestrator's model, so the desk intake records the Trigger as
 * `ignore` when it makes a group or routes `@group …` to one. On its own that decision reads as "the supervisor did not take
 * this message". This table is the link between the two models: it says which group took the Trigger, so the desk's flow
 * card can show the group (and its live run) instead of a refusal.
 *
 * The runtime writes a route in the same `Store.atomic` transaction as the ignore decision and the "group made" notice, so
 * a crash never leaves a group recorded without its notice, or the reverse. The first route for a Trigger wins.
 */
import type { DatabaseSync } from 'node:sqlite'

export type GroupRouteKind = 'created' | 'routed' | 'updated'

export interface GroupRoute {
  triggerId: string
  roomId: string
  roomName: string
  /**
   * `created`: the message asked for a new group; `routed`: it was an `@group` command to an existing one; `updated`
   * (2026-11-06): it asked for a group whose name an existing one has, which was edited instead.
   */
  kind: GroupRouteKind
  /** The DSH message id of the person's message; the agents plugin records the same id on the group's run. */
  sourceMessageId?: string
  at: string
}

/** The `group_route` table in the orchestrator database; writes happen inside the caller's `Store.atomic` transaction. */
export class GroupRoutes {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS group_route (trigger_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, room_name TEXT NOT NULL,
      kind TEXT NOT NULL, source_message_id TEXT, at TEXT NOT NULL)`)
  }
  /** Records where a Trigger went; recording the same Trigger again changes nothing. */
  record(route: GroupRoute): void {
    this.db.prepare('INSERT OR IGNORE INTO group_route (trigger_id, room_id, room_name, kind, source_message_id, at) VALUES (?,?,?,?,?,?)')
      .run(route.triggerId, route.roomId, route.roomName, route.kind, route.sourceMessageId ?? null, route.at)
  }
  get(triggerId: string): GroupRoute | undefined {
    const row = this.db.prepare('SELECT trigger_id, room_id, room_name, kind, source_message_id, at FROM group_route WHERE trigger_id=?').get(triggerId)
    if (!row) return undefined
    const kind: GroupRouteKind = row.kind === 'created' || row.kind === 'updated' ? row.kind : 'routed'
    return { triggerId: String(row.trigger_id), roomId: String(row.room_id), roomName: String(row.room_name), kind,
      ...row.source_message_id ? { sourceMessageId: String(row.source_message_id) } : {}, at: String(row.at) }
  }
}
