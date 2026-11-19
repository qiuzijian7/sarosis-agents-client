/** Delivered pending CLs remain intact while the shared client processes unrelated later tickets. */
import type { Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import type { ChangeFile } from '../sources/p4-change.ts'

export interface RetainedChange { ticketId: string; change: number; files: ChangeFile[]; fingerprint: string }
export function retainedChanges(store: Pick<Store, 'get' | 'keys' | 'tickets'>, ticket: Ticket): RetainedChange[] {
  const workspace = ticket.execution?.p4Workspace
  if (!workspace) return []
  return store.keys(KV.reviews.review).flatMap(key => {
    const review = store.get(key), previous = review && store.tickets.get(review.ticketId)
    const other = previous?.execution?.p4Workspace
    if (!review || review.state !== 'delivered_pending' || previous?.ended?.outcome !== 'completed' || previous.id === ticket.id
      || !other || other.root !== workspace.root || other.client !== workspace.client || other.port !== workspace.port || other.user !== workspace.user) return []
    return [{ ticketId: previous.id, change: review.change, files: review.files, fingerprint: review.fingerprint }]
  })
}
