import * as THREE from 'three'
import type { Color, PieceType } from '../game/types'
import { COLS, PIECE_CHAR, ROWS } from '../game/constants'
import { BOARD_DEPTH, BOARD_MARGIN, BOARD_WIDTH, CELL } from './layout'

const PIECE_FONT = '"Kaiti TC", "BiauKai", "DFKai-SB", "Noto Serif TC", serif'

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立 2D 繪圖環境')
  return [canvas, ctx]
}

function asTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Paints layered wood grain onto the whole canvas. */
function paintWood(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  base: string,
  dark: string,
  light: string,
  streaks: number,
): void {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, width, height)
  for (let i = 0; i < streaks; i++) {
    const y = Math.random() * height
    const amplitude = 2 + Math.random() * 8
    const period = 120 + Math.random() * 340
    const thickness = 1 + Math.random() * 5
    const phase = Math.random() * Math.PI * 2
    ctx.strokeStyle = Math.random() < 0.5 ? dark : light
    ctx.globalAlpha = 0.05 + Math.random() * 0.1
    ctx.lineWidth = thickness
    ctx.beginPath()
    for (let x = 0; x <= width; x += 12) {
      const yy = y + Math.sin(x / period + phase) * amplitude
      if (x === 0) ctx.moveTo(x, yy)
      else ctx.lineTo(x, yy)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Board surface: warm wood, engraved cell grid, coordinate labels. */
export function createBoardTexture(): THREE.CanvasTexture {
  const scale = 190
  const width = Math.round(BOARD_WIDTH * scale)
  const height = Math.round(BOARD_DEPTH * scale)
  const [canvas, ctx] = makeCanvas(width, height)

  paintWood(ctx, width, height, '#b98d58', '#8a6238', '#d3ac74', 160)

  // Soft vignette so the board reads as one solid object.
  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.35, width / 2, height / 2, width * 0.72)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(52,30,12,0.35)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, width, height)

  const originX = BOARD_MARGIN * scale
  const originY = BOARD_MARGIN * scale
  const cellPx = CELL * scale

  // Engraved grid: darker groove with a light edge below for depth.
  const drawLine = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.strokeStyle = 'rgba(58,34,14,0.85)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,228,180,0.28)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x1 + 1.5, y1 + 1.5)
    ctx.lineTo(x2 + 1.5, y2 + 1.5)
    ctx.stroke()
  }

  for (let c = 0; c <= COLS; c++) {
    drawLine(originX + c * cellPx, originY, originX + c * cellPx, originY + ROWS * cellPx)
  }
  for (let r = 0; r <= ROWS; r++) {
    drawLine(originX, originY + r * cellPx, originX + COLS * cellPx, originY + r * cellPx)
  }

  // Subtle circular seat mark in each cell.
  ctx.strokeStyle = 'rgba(70,42,18,0.28)'
  ctx.lineWidth = 2
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      ctx.beginPath()
      ctx.arc(originX + (c + 0.5) * cellPx, originY + (r + 0.5) * cellPx, cellPx * 0.4, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Coordinate labels: columns A-H (top and bottom), rows 1-4 (left and right).
  ctx.fillStyle = 'rgba(62,36,14,0.75)'
  ctx.font = `600 ${Math.round(scale * 0.2)}px ${PIECE_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let c = 0; c < COLS; c++) {
    const letter = String.fromCharCode(65 + c)
    const x = originX + (c + 0.5) * cellPx
    ctx.fillText(letter, x, originY * 0.48)
    ctx.fillText(letter, x, height - originY * 0.48)
  }
  for (let r = 0; r < ROWS; r++) {
    const y = originY + (r + 0.5) * cellPx
    ctx.fillText(String(r + 1), originX * 0.46, y)
    ctx.fillText(String(r + 1), width - originX * 0.46, y)
  }

  return asTexture(canvas)
}

/** Dark tabletop under and around the board. */
export function createTableTexture(): THREE.CanvasTexture {
  const size = 1024
  const [canvas, ctx] = makeCanvas(size, size)
  paintWood(ctx, size, size, '#3a2a1e', '#241811', '#4d3a28', 130)
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.7)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, size, size)
  return asTexture(canvas)
}

/** Light boxwood look for piece sides and body. */
export function createPieceWoodTexture(): THREE.CanvasTexture {
  const size = 256
  const [canvas, ctx] = makeCanvas(size, size)
  paintWood(ctx, size, size, '#dcbc88', '#b3905e', '#efd6a8', 40)
  return asTexture(canvas)
}

function paintPieceDisc(ctx: CanvasRenderingContext2D, size: number): void {
  const half = size / 2
  const grad = ctx.createRadialGradient(half * 0.78, half * 0.7, half * 0.15, half, half, half)
  grad.addColorStop(0, '#f2dfb6')
  grad.addColorStop(0.72, '#ddbb85')
  grad.addColorStop(1, '#c39c66')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  paintWood(ctx, size, size, 'rgba(0,0,0,0)', '#b3905e', '#f4e2b8', 22)
}

/** Face texture: engraved ring plus the piece character. */
export function createPieceFaceTexture(color: Color, type: PieceType): THREE.CanvasTexture {
  const size = 256
  const [canvas, ctx] = makeCanvas(size, size)
  const half = size / 2
  paintPieceDisc(ctx, size)

  const ink = color === 'red' ? '#a92c1a' : '#26221c'
  const inkShadow = color === 'red' ? 'rgba(94,16,6,0.55)' : 'rgba(0,0,0,0.5)'

  ctx.strokeStyle = ink
  ctx.lineWidth = size * 0.032
  ctx.beginPath()
  ctx.arc(half, half, half * 0.86, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = size * 0.012
  ctx.beginPath()
  ctx.arc(half, half, half * 0.78, 0, Math.PI * 2)
  ctx.stroke()

  const char = PIECE_CHAR[color][type]
  ctx.font = `700 ${Math.round(size * 0.52)}px ${PIECE_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = inkShadow
  ctx.shadowBlur = size * 0.01
  ctx.shadowOffsetY = size * 0.008
  ctx.fillStyle = ink
  ctx.fillText(char, half, half * 1.06)
  ctx.shadowColor = 'transparent'

  return asTexture(canvas)
}

/** Shared back texture: carved geometric motif, identical for every piece. */
export function createPieceBackTexture(): THREE.CanvasTexture {
  const size = 256
  const [canvas, ctx] = makeCanvas(size, size)
  const half = size / 2
  paintPieceDisc(ctx, size)

  ctx.strokeStyle = 'rgba(96,62,26,0.8)'
  ctx.lineWidth = size * 0.028
  ctx.beginPath()
  ctx.arc(half, half, half * 0.86, 0, Math.PI * 2)
  ctx.stroke()

  // Interlocking key-fret style motif: rotated squares and a center knot.
  ctx.lineWidth = size * 0.018
  for (const [radius, rotation] of [
    [0.62, 0],
    [0.62, Math.PI / 4],
  ] as const) {
    ctx.save()
    ctx.translate(half, half)
    ctx.rotate(rotation)
    const s = half * radius * Math.SQRT1_2 * 1.32
    ctx.strokeRect(-s / 2, -s / 2, s, s)
    ctx.restore()
  }
  ctx.beginPath()
  ctx.arc(half, half, half * 0.18, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(half, half, half * 0.42, 0, Math.PI * 2)
  ctx.stroke()

  return asTexture(canvas)
}
