import type { PlaylistEntry } from '../types/track.js'

/**
 * Holds the ordered playlist and the id of whatever's currently playing.
 * Tracks the "current" position by id rather than array index, so dropping a
 * failed upcoming entry never has to worry about shifting an index that
 * points at something else.
 */
export class PlaylistManager {
  private entries: PlaylistEntry[]
  private currentId: string | null = null
  private readonly loop: boolean

  constructor(entries: PlaylistEntry[], loop: boolean) {
    this.entries = [...entries]
    this.loop = loop
  }

  get size(): number {
    return this.entries.length
  }

  getCurrent(): PlaylistEntry | undefined {
    if (this.currentId === null) return undefined
    return this.entries.find(entry => entry.id === this.currentId)
  }

  /** The entry that should play first. Does not mutate state. */
  peekFirst(): PlaylistEntry | undefined {
    return this.entries[0]
  }

  /** The entry after the current one, honoring `loop`. Does not mutate state. */
  peekNext(): PlaylistEntry | undefined {
    if (this.entries.length === 0) return undefined

    const currentIndex =
      this.currentId === null ? -1 : this.entries.findIndex(entry => entry.id === this.currentId)
    const nextIndex = currentIndex + 1

    if (nextIndex >= this.entries.length) {
      return this.loop ? this.entries[0] : undefined
    }
    return this.entries[nextIndex]
  }

  /** Commits `entryId` as the track that's now playing. */
  commitCurrent(entryId: string): void {
    this.currentId = entryId
  }

  /** Permanently removes an entry that failed to resolve after every retry. */
  dropEntry(entryId: string): void {
    this.entries = this.entries.filter(entry => entry.id !== entryId)
  }
}
