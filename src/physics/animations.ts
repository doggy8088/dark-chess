/** Small tween engine plus a serial animation queue, driven by the render loop. */

export type EaseFunction = (t: number) => number

export const easeOutCubic: EaseFunction = (t) => 1 - Math.pow(1 - t, 3)
export const easeInOutQuad: EaseFunction = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
export const easeInQuad: EaseFunction = (t) => t * t
export const easeOutBack: EaseFunction = (t) => {
  const c1 = 1.35
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

interface ActiveTween {
  elapsed: number
  duration: number
  ease: EaseFunction
  onUpdate: (t: number) => void
  resolve: () => void
}

/** Advances active tweens; update(dt) must be called once per frame. */
export class Ticker {
  private tweens: ActiveTween[] = []

  tween(duration: number, onUpdate: (t: number) => void, ease: EaseFunction = easeInOutQuad): Promise<void> {
    if (duration <= 0) {
      onUpdate(1)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.tweens.push({ elapsed: 0, duration, ease, onUpdate, resolve })
    })
  }

  delay(duration: number): Promise<void> {
    return this.tween(duration, () => {})
  }

  update(dt: number): void {
    if (this.tweens.length === 0) return
    const finished: ActiveTween[] = []
    for (const tween of this.tweens) {
      tween.elapsed += dt
      const t = Math.min(1, tween.elapsed / tween.duration)
      tween.onUpdate(tween.ease(t))
      if (t >= 1) finished.push(tween)
    }
    if (finished.length > 0) {
      this.tweens = this.tweens.filter((tween) => !finished.includes(tween))
      for (const tween of finished) tween.resolve()
    }
  }

  clear(): void {
    const pending = this.tweens
    this.tweens = []
    for (const tween of pending) {
      tween.onUpdate(1)
      tween.resolve()
    }
  }
}

/**
 * Serial queue for presentation animations. Gameplay input stays locked while
 * the queue is busy; the authoritative game state has already been updated
 * before any animation is enqueued, so a broken animation can never corrupt
 * the game.
 */
export class AnimationQueue {
  private chain: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly onIdleChange?: (busy: boolean) => void) {}

  get busy(): boolean {
    return this.pending > 0
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1
    if (this.pending === 1) this.onIdleChange?.(true)
    const run = this.chain.then(task).catch((error) => {
      // Presentation-only failure: log and continue, game state is unaffected.
      console.warn('動畫執行失敗（不影響棋局狀態）', error)
    })
    this.chain = run.then(() => {
      this.pending -= 1
      if (this.pending === 0) this.onIdleChange?.(false)
    })
    return this.chain
  }
}
