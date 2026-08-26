import { Firestore, Timestamp } from '@google-cloud/firestore'
import type { RoomDoc, RoomStore } from './store'

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
    const expireAt = data.expireAt instanceof Timestamp ? data.expireAt.toMillis() : Number(data.expireAt ?? 0)
    return { ...(data as unknown as RoomDoc), expireAt }
  }

  async save(doc: RoomDoc): Promise<void> {
    await this.rooms.doc(doc.roomId).set({ ...doc, expireAt: Timestamp.fromMillis(doc.expireAt) })
  }

  async delete(roomId: string): Promise<void> {
    await this.rooms.doc(roomId).delete()
  }

  async listActive(limit: number): Promise<RoomDoc[]> {
    // Single-field filter — no composite index needed; sort in memory.
    const snapshot = await this.rooms.where('status', '==', 'playing').limit(50).get()
    const docs: RoomDoc[] = []
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>
      if (data.version !== 1 || typeof data.stateJson !== 'string') continue
      const expireAt = data.expireAt instanceof Timestamp ? data.expireAt.toMillis() : Number(data.expireAt ?? 0)
      docs.push({ ...(data as unknown as RoomDoc), expireAt })
    }
    return docs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  }
}
