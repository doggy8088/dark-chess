/** Haptic feedback with graceful degradation on unsupported devices. */

export type HapticKind = 'flip' | 'move' | 'capture'

const PATTERNS: Record<HapticKind, number | number[]> = {
  flip: 8,
  move: 12,
  capture: [18, 30, 24],
}

export function vibrate(kind: HapticKind): void {
  try {
    navigator.vibrate?.(PATTERNS[kind])
  } catch {
    // Unsupported or blocked — silently ignore.
  }
}
