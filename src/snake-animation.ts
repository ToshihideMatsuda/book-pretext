// Snake animation — DOM-based (no canvas)
// Each character gets its own <span> at the exact same position as the
// original page text, so font rendering is identical before/after activation.
// Animation is applied via CSS transform so the layout position never changes.

const SEG_DIST = 13
const BASE_SPEED = 1.5
const POINTER_FOOD_DIST = 250
const POINTER_SHARK_DIST = 280
const WANDER = 0.12
export const DOUBLE_TAP_MS = 320
const WARMUP_FRAMES = 60
const STAGGER_FRAMES = 18

export interface PageLine {
  x: number
  y: number
  text: string
}

interface Pt { x: number; y: number }

interface Seg {
  x: number   // current simulation x
  y: number   // current simulation y
  ox: number  // original CSS left
  oy: number  // original CSS top
  el: HTMLSpanElement
}

interface Snake {
  segs: Seg[]
  vx: number
  vy: number
  warmup: number
  swimming: boolean  // flipped true when warmup first ends
}

let container: HTMLDivElement | null = null
let toggleBtn: HTMLButtonElement | null = null
let pointerEl: HTMLDivElement | null = null
let raf: number | null = null
let snakes: Snake[] = []

let pointer: Pt | null = null
let pointerMode: 'food' | 'shark' = 'food'
let pointerFadeTimer: number | null = null

let boundPointerDown: ((e: PointerEvent) => void) | null = null
let boundPointerMove: ((e: PointerEvent) => void) | null = null
let boundPointerUp: (() => void) | null = null

let lastTapTime = 0
let lastTapX = 0
let lastTapY = 0

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })

function graphemes(s: string): string[] {
  return [...segmenter.segment(s)].map(g => g.segment)
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function dst(a: Pt, b: Pt): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

// Compute per-character x positions using measureText, y = CSS top of the line
function charPositionsFromLines(
  lines: PageLine[],
  font: string,
): { char: string; x: number; y: number }[][] {
  const tmpCtx = document.createElement('canvas').getContext('2d')!
  tmpCtx.font = font
  const sentences: { char: string; x: number; y: number }[][] = []
  let current: { char: string; x: number; y: number }[] = []

  for (const line of lines) {
    const chars = graphemes(line.text)
    let cx = line.x
    for (const char of chars) {
      current.push({ char, x: cx, y: line.y })
      cx += tmpCtx.measureText(char).width
      if (/[。！？…]+/.test(char)) {
        if (current.length > 1) { sentences.push(current); current = [] }
      }
    }
  }
  if (current.length > 1) sentences.push(current)
  return sentences
}

function makeSnake(
  charPos: { char: string; x: number; y: number }[],
  index: number,
  bodyFont: string,
  lineHeight: number,
  parent: HTMLDivElement,
): Snake {
  const angle = Math.random() * Math.PI * 2
  const speed = BASE_SPEED * rand(0.75, 1.25)

  const segs: Seg[] = charPos.map(cp => {
    const el = document.createElement('span')
    el.textContent = cp.char
    el.style.position = 'absolute'
    el.style.left = `${cp.x}px`
    el.style.top = `${cp.y}px`
    el.style.font = bodyFont
    el.style.lineHeight = `${lineHeight}px`
    el.style.color = '#e8e4dc'
    el.style.whiteSpace = 'pre'
    el.style.willChange = 'transform, opacity'
    el.style.pointerEvents = 'none'
    el.style.userSelect = 'none'
    parent.appendChild(el)
    return { x: cp.x, y: cp.y, ox: cp.x, oy: cp.y, el }
  })

  return {
    segs,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    warmup: WARMUP_FRAMES + index * STAGGER_FRAMES,
    swimming: false,
  }
}

function stepSnake(sn: Snake, W: number, H: number): void {
  if (sn.warmup > 0) { sn.warmup--; return }

  const head = sn.segs[0]!
  let ax = 0
  let ay = 0

  if (pointer) {
    const d = dst(head, pointer)
    if (pointerMode === 'food' && d < POINTER_FOOD_DIST && d > 0) {
      const w = (1 - d / POINTER_FOOD_DIST) * 0.25
      ax += ((pointer.x - head.x) / d) * w
      ay += ((pointer.y - head.y) / d) * w
    } else if (pointerMode === 'shark' && d < POINTER_SHARK_DIST && d > 0) {
      const w = (1 - d / POINTER_SHARK_DIST) * 0.45
      ax -= ((pointer.x - head.x) / d) * w
      ay -= ((pointer.y - head.y) / d) * w
    }
  }

  ax += (Math.random() - 0.5) * WANDER
  ay += (Math.random() - 0.5) * WANDER

  sn.vx += ax
  sn.vy += ay

  const spd = Math.sqrt(sn.vx * sn.vx + sn.vy * sn.vy)
  const maxSpd = BASE_SPEED * 2.2
  const minSpd = BASE_SPEED * 0.35
  if (spd > maxSpd) { sn.vx = (sn.vx / spd) * maxSpd; sn.vy = (sn.vy / spd) * maxSpd }
  if (spd < minSpd && spd > 0) { sn.vx = (sn.vx / spd) * minSpd; sn.vy = (sn.vy / spd) * minSpd }

  const margin = 24
  if (head.x < margin) sn.vx = Math.abs(sn.vx)
  if (head.x > W - margin) sn.vx = -Math.abs(sn.vx)
  if (head.y < margin) sn.vy = Math.abs(sn.vy)
  if (head.y > H - margin) sn.vy = -Math.abs(sn.vy)

  head.x += sn.vx
  head.y += sn.vy

  for (let i = 1; i < sn.segs.length; i++) {
    const prev = sn.segs[i - 1]!
    const curr = sn.segs[i]!
    const dx = curr.x - prev.x
    const dy = curr.y - prev.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > SEG_DIST) {
      curr.x = prev.x + (dx / d) * SEG_DIST
      curr.y = prev.y + (dy / d) * SEG_DIST
    }
  }
}

function updateDOM(now: number): void {
  for (const sn of snakes) {
    const frozen = sn.warmup > 0
    const n = sn.segs.length

    // First frame after warmup: update head style once
    if (!frozen && !sn.swimming) {
      sn.swimming = true
      const headEl = sn.segs[0]?.el
      if (headEl) {
        headEl.style.fontWeight = 'bold'
        headEl.style.color = '#f0ece4'
      }
    }

    const angle = frozen ? 0 : Math.atan2(sn.vy, sn.vx)

    for (let i = 0; i < n; i++) {
      const seg = sn.segs[i]!
      const t = i / Math.max(n - 1, 1)

      if (frozen) {
        // No transform: renders exactly like original page text
        seg.el.style.transform = ''
        seg.el.style.opacity = '1'
        continue
      }

      // Lateral sinusoidal wiggle perpendicular to velocity
      const wave = Math.sin(i * 0.45 + now * 0.004) * 2.5
      const wx = -Math.sin(angle) * wave
      const wy = Math.cos(angle) * wave

      const tx = seg.x - seg.ox + wx
      const ty = seg.y - seg.oy + wy
      seg.el.style.transform = `translate(${tx}px, ${ty}px)`
      seg.el.style.opacity = String(0.38 + (1 - t) * 0.62)
    }
  }

  // Pointer indicator
  if (pointerEl) {
    if (pointer) {
      pointerEl.style.display = ''
      pointerEl.style.left = `${pointer.x}px`
      pointerEl.style.top = `${pointer.y}px`
      pointerEl.textContent = pointerMode === 'food' ? '餌' : '鮫'
      pointerEl.style.textShadow = pointerMode === 'food'
        ? '0 0 24px #00ff88'
        : '0 0 24px #8899ff'
    } else {
      pointerEl.style.display = 'none'
    }
  }
}

function tick(now: number): void {
  if (!container) return
  const W = window.innerWidth
  const H = window.innerHeight
  for (const sn of snakes) stepSnake(sn, W, H)
  updateDOM(now)
  raf = requestAnimationFrame(tick)
}

function createToggleButton(parent: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = '🦐 餌モード'
  btn.style.cssText = `
    position: absolute;
    bottom: 90px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,30,60,0.80);
    color: #7ad;
    border: 1px solid rgba(100,200,255,0.35);
    border-radius: 24px;
    padding: 10px 28px;
    font-size: 15px;
    cursor: pointer;
    backdrop-filter: blur(6px);
    user-select: none;
    z-index: 200;
    touch-action: manipulation;
    transition: color 0.2s, border-color 0.2s;
    pointer-events: auto;
    white-space: nowrap;
  `
  btn.addEventListener('click', e => {
    e.stopPropagation()
    pointerMode = pointerMode === 'food' ? 'shark' : 'food'
    btn.textContent = pointerMode === 'food' ? '🦐 餌モード' : '🦈 鮫モード'
    btn.style.color = pointerMode === 'food' ? '#7ad' : '#f88'
    btn.style.borderColor = pointerMode === 'food'
      ? 'rgba(100,200,255,0.35)'
      : 'rgba(255,120,120,0.4)'
  })
  parent.appendChild(btn)
  return btn
}

function createPointerEl(parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `
    position: absolute;
    display: none;
    font: bold 44px serif;
    color: #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 7;
  `
  parent.appendChild(el)
  return el
}

export function startSnakeMode(
  stage: HTMLElement,
  lines: PageLine[],
  font: string,
  lineHeight: number,
): void {
  stopSnakeMode()

  container = document.createElement('div')
  container.style.cssText = 'position:absolute;inset:0;z-index:6;overflow:hidden;pointer-events:none;'
  stage.appendChild(container)

  // Button and pointer indicator go directly on stage (not inside pointer-events:none container)
  toggleBtn = createToggleButton(stage)
  pointerEl = createPointerEl(stage)

  const sentenceChars = charPositionsFromLines(lines, font)
  snakes = sentenceChars.slice(0, 20).map((chars, i) =>
    makeSnake(chars, i, font, lineHeight, container!),
  )

  // Pointer tracking (window-level so canvas/div pointer-events:none is unaffected)
  boundPointerDown = (e: PointerEvent) => {
    if ((e.target as Element)?.closest('button, input, .topbar, #page-jump, #search-panel, #toc-overlay')) return
    clearTimeout(pointerFadeTimer ?? undefined)
    pointerFadeTimer = null
    pointer = { x: e.clientX, y: e.clientY }
  }
  boundPointerMove = (e: PointerEvent) => {
    if (e.buttons > 0 && pointer !== null) pointer = { x: e.clientX, y: e.clientY }
  }
  boundPointerUp = () => {
    clearTimeout(pointerFadeTimer ?? undefined)
    pointerFadeTimer = window.setTimeout(() => { pointer = null; pointerFadeTimer = null }, 1200)
  }

  window.addEventListener('pointerdown', boundPointerDown)
  window.addEventListener('pointermove', boundPointerMove)
  window.addEventListener('pointerup', boundPointerUp)

  raf = requestAnimationFrame(tick)
}

export function stopSnakeMode(): void {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  container?.remove(); container = null
  toggleBtn = null
  pointerEl = null

  if (boundPointerDown) { window.removeEventListener('pointerdown', boundPointerDown); boundPointerDown = null }
  if (boundPointerMove) { window.removeEventListener('pointermove', boundPointerMove); boundPointerMove = null }
  if (boundPointerUp) { window.removeEventListener('pointerup', boundPointerUp); boundPointerUp = null }
  clearTimeout(pointerFadeTimer ?? undefined)
  pointerFadeTimer = null
  pointer = null
  pointerMode = 'food'
  snakes = []
}

export function isSnakeModeActive(): boolean {
  return container !== null
}

export function recordTap(x: number, y: number): boolean {
  const now = Date.now()
  const dt = now - lastTapTime
  const moved = Math.sqrt((x - lastTapX) ** 2 + (y - lastTapY) ** 2)
  lastTapTime = now
  lastTapX = x
  lastTapY = y
  return dt < DOUBLE_TAP_MS && moved < 60
}
