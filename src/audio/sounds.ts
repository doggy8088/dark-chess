/** Synthesized tabletop sound effects via Web Audio — no remote assets. */

export type SoundName = 'flip' | 'place' | 'move' | 'capture' | 'win' | 'invalid'

export class SoundPlayer {
  private context: AudioContext | null = null
  enabled = true

  /** Must be called from a user gesture at least once (autoplay policy). */
  private ensureContext(): AudioContext | null {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      this.context = new Ctor()
    }
    if (this.context.state === 'suspended') {
      void this.context.resume()
    }
    return this.context
  }

  play(name: SoundName): void {
    if (!this.enabled) return
    const ctx = this.ensureContext()
    if (!ctx) return
    const now = ctx.currentTime
    switch (name) {
      case 'flip':
        this.click(ctx, now, 1900, 0.05, 0.16)
        this.thud(ctx, now + 0.02, 240, 0.06, 0.1)
        break
      case 'place':
        this.thud(ctx, now, 130, 0.1, 0.3)
        this.noiseBurst(ctx, now, 0.03, 900, 0.12)
        break
      case 'move':
        this.noiseBurst(ctx, now, 0.09, 500, 0.06)
        this.thud(ctx, now + 0.08, 150, 0.08, 0.18)
        break
      case 'capture':
        this.thud(ctx, now, 95, 0.16, 0.42)
        this.click(ctx, now, 1200, 0.04, 0.2)
        this.noiseBurst(ctx, now + 0.01, 0.06, 1400, 0.16)
        break
      case 'win':
        for (const [i, freq] of [523.25, 659.25, 783.99, 1046.5].entries()) {
          this.pluck(ctx, now + i * 0.13, freq, 0.34, 0.14)
        }
        break
      case 'invalid':
        this.thud(ctx, now, 70, 0.09, 0.16)
        break
    }
  }

  private thud(ctx: AudioContext, at: number, freq: number, duration: number, gainValue: number): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * 1.7, at)
    osc.frequency.exponentialRampToValueAtTime(freq, at + duration)
    gain.gain.setValueAtTime(gainValue, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.08)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + duration + 0.1)
  }

  private click(ctx: AudioContext, at: number, freq: number, duration: number, gainValue: number): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, at)
    gain.gain.setValueAtTime(gainValue, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + duration + 0.02)
  }

  private pluck(ctx: AudioContext, at: number, freq: number, duration: number, gainValue: number): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + duration + 0.05)
  }

  private noiseBurst(ctx: AudioContext, at: number, duration: number, cutoff: number, gainValue: number): void {
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration))
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = cutoff
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(gainValue, at)
    source.connect(filter).connect(gain).connect(ctx.destination)
    source.start(at)
  }
}
