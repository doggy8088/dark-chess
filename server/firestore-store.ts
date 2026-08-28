import { Firestore, Timestamp } from '@google-cloud/firestore'
import { isLobbyListable, byLobbyOrder, type RoomDoc, type RoomStore } from './store'

/**
 * One document per room in `rooms/{roomId}`. GameState and chat are stored
 * as JSON strings (Firestore rejects `undefined` fields, which the optional
 * HistoryEntry/ChatMessage members would produce). `expireAt` is a Timestamp
 * so a collection TTL policy can garbage-collect stale rooms:
 *   gcloud firestore fields ttls update expireAt \
 *     --collection-group=rooms --enable-ttl
 */
export class FirestoreStore implements RoomStore {
  private readonly db = new Firestore()
  private readonly rooms = this.db.collection('rooms')

  async load(roomId: string): Promise<RoomDoc | null> {
    const snapshot = await this.rooms.doc(roomId).get()
    if (!snapshot.exists) return null
    const data = snapshot.data() as Record<string, unknown>
    if (data.version !== 1 || typeof data.stateJson !== 'string') return null
    return this.toDoc(data)
  }

  async save(doc: RoomDoc): Promise<void> {
    await this.rooms.doc(doc.roomId).set({ ...doc, expireAt: Timestamp.fromMillis(doc.expireAt) })
  }

  async delete(roomId: string): Promise<void> {
    await this.rooms.doc(roomId).delete()
  }

  async listActive(limit: number, now: number): Promise<RoomDoc[]> {
    // Single-field filter — no composite index needed; sort in memory.
    // Finished games are listed too while they linger on the live board.
    const snapshot = await this.rooms.where('status', 'in', ['playing', 'finished']).limit(200).get()
    const docs: RoomDoc[] = []
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>
      if (data.version !== 1 || typeof data.stateJson !== 'string') continue
      const normalized = this.toDoc(data)
      if (isLobbyListable(normalized, now)) docs.push(normalized)
    }
    return docs.sort(byLobbyOrder).slice(0, limit)
  }

  /** Normalizes Firestore-native fields back to the RoomDoc shape. */
  private toDoc(data: Record<string, unknown>): RoomDoc {
    const expireAt = data.expireAt instanceof Timestamp ? data.expireAt.toMillis() : Number(data.expireAt ?? 0)
    const finishedAt = typeof data.finishedAt === 'number' ? data.finishedAt : null
    return { ...(data as unknown as RoomDoc), expireAt, finishedAt }
  }
}
