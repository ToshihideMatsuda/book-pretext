// Snake animation overlay
// Characters peel out from their exact on-screen positions and swim as snakes.
// Head = sentence start, tail = sentence end.
// Button toggles pointer between 餌 (attract) and 鮫 (flee).
// Sliding finger/mouse attracts or repels snakes.

const SEG_DIST = 13
const BASE_SPEED = 1.5
const STATIC_FOOD_DIST = 200   // range for static food items
const SHARK_REPEL_DIST = 260
const POINTER_FOOD_DIST = 250
const POINTER_SHARK_DIST = 280
const STATIC_FOOD_COUNT = 3
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

interface Seg extends Pt {
  ox: number
  oy: number
}

interface Snake {
  segs: Seg[]
  chars: string[]
  vx: number
  vy: number
  warmup: number
}

interface StaticFood {
  pos: Pt
  active: boolean
  respawnIn: number
}

interface Shark {
  pos: Pt
  vx: number
  vy: number
}

let canvas: HTMLCanvasElement | null = null
let toggleBtn: HTMLButtonElement | null = null
let raf: number | null = null
let snakes: Snake[] = []
let staticFoods: StaticFood[] = []
let wanderingShark: Shark | null = null

// Pointer state
let pointer: Pt | null = null
let pointerMode: 'food' | 'shark' = 'food'
let pointerFadeTimer: number | null = null

// Listeners kept for cleanup
let boundPointerDown: ((e: PointerEvent) => void) | null = null
let boundPointerMove: ((e: PointerEvent) => void) | null = null
let boundPointerUp: (() => void) | null = null

// Double-tap detection
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

function charPositionsFromLines(
  lines: PageLine[],
  font: string,
  lineHeight: number,
): { char: string; x: number; y: number }[][] {
  const tmpCtx = document.createElement('canvas').getContext('2d')!
  tmpCtx.font = font
  const sentences: { char: string; x: number; y: number }[][] = []
  let current: { char: string; x: number; y: number }[] = []
  const cyOff = lineHeight * 0.55

  for (const line of lines) {
    const chars = graphemes(line.text)
    let cx = line.x
    for (const char of chars) {
      current.push({ char, x: cx, y: line.y + cyOff })
      cx += tmpCtx.measureText(char).width
      if (/[。！？…]+/.test(char)) {
        if (current.length > 1) { sentences.push(current); current = [] }
      }
    }
  }
  if (current.length > 1) sentences.push(current)
  return sentences
}

function makeSnake(charPos: { char: string; x: number; y: number }[], index: number): Snake {
  const angle = Math.random() * Math.PI * 2
  const speed = BASE_SPEED * rand(0.75, 1.25)
  return {
    segs: charPos.map(c => ({ x: c.x, y: c.y, ox: c.x, oy: c.y })),
    chars: charPos.map(c => c.char),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    warmup: WARMUP_FRAMES + index * STAGGER_FRAMES,
  }
}

function makeStaticFood(W: number, H: number): StaticFood {
  return { pos: { x: rand(60, W - 60), y: rand(60, H - 60) }, active: true, respawnIn: 0 }
}

function makeShark(W: number, H: number): Shark {
  const angle = Math.random() * Math.PI * 2
  return {
    pos: { x: rand(80, W - 80), y: rand(80, H - 80) },
    vx: Math.cos(angle) * BASE_SPEED * 0.55,
    vy: Math.sin(angle) * BASE_SPEED * 0.55,
  }
}

function stepSnake(sn: Snake, W: number, H: number): void {
  if (sn.warmup > 0) { sn.warmup--; return }

  const head = sn.segs[0]!
  let ax = 0
  let ay = 0

  // pointer interaction (strongest effect)
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

  // static food attraction
  let minD = Infinity
  let nearFood: StaticFood | null = null
  for (const f of staticFoods) {
    if (!f.active) continue
    const d = dst(head, f.pos)
    if (d < minD) { minD = d; nearFood = f }
  }
  if (nearFood && minD < STATIC_FOOD_DIST) {
    const dx = nearFood.pos.x - head.x
    const dy = nearFood.pos.y - head.y
    const w = (1 - minD / STATIC_FOOD_DIST) * 0.10
    ax += (dx / minD) * w
    ay += (dy / minD) * w
    if (minD < 18) { nearFood.active = false; nearFood.respawnIn = 200 + Math.floor(Math.random() * 200) }
  }

  // wandering shark repulsion
  if (wanderingShark) {
    const d = dst(head, wanderingShark.pos)
    if (d < SHARK_REPEL_DIST && d > 0) {
      const w = (1 - d / SHARK_REPEL_DIST) * 0.35
      ax -= ((wanderingShark.pos.x - head.x) / d) * w
      ay -= ((wanderingShark.pos.y - head.y) / d) * w
    }
  }

  // wander
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

function stepShark(s: Shark, W: number, H: number): void {
  s.vx += (Math.random() - 0.5) * 0.08
  s.vy += (Math.random() - 0.5) * 0.08
  const spd = Math.sqrt(s.vx * s.vx + s.vy * s.vy)
  const target = BASE_SPEED * 0.6
  if (spd > target * 2) { s.vx = (s.vx / spd) * target * 2; s.vy = (s.vy / spd) * target * 2 }
  if (spd < target * 0.4 && spd > 0) { s.vx = (s.vx / spd) * target * 0.4; s.vy = (s.vy / spd) * target * 0.4 }
  const m = 40
  if (s.pos.x < m) s.vx = Math.abs(s.vx)
  if (s.pos.x > W - m) s.vx = -Math.abs(s.vx)
  if (s.pos.y < m) s.vy = Math.abs(s.vy)
  if (s.pos.y > H - m) s.vy = -Math.abs(s.vy)
  s.pos.x += s.vx
  s.pos.y += s.vy
}

function drawFrame(ctx: CanvasRenderingContext2D): void {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  ctx.clearRect(0, 0, W, H)

  // static food
  ctx.font = '16px serif'
  for (const f of staticFoods) {
    if (!f.active) continue
    ctx.globalAlpha = 0.7
    ctx.fillText('🦐', f.pos.x - 8, f.pos.y + 8)
  }

  // wandering shark
  if (wanderingShark) {
    ctx.globalAlpha = 0.85
    ctx.font = '22px serif'
    const s = wanderingShark
    if (s.vx < 0) {
      ctx.save(); ctx.scale(-1, 1)
      ctx.fillText('🦈', -s.pos.x - 11, s.pos.y + 11)
      ctx.restore()
    } else {
      ctx.fillText('🦈', s.pos.x - 11, s.pos.y + 11)
    }
  }

  // pointer indicator (food or shark)
  if (pointer) {
    ctx.save()
    ctx.font = 'bold 44px serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (pointerMode === 'food') {
      ctx.shadowColor = '#00ff88'
      ctx.shadowBlur = 24
      ctx.fillText('餌', pointer.x, pointer.y)
    } else {
      ctx.shadowColor = '#8899ff'
      ctx.shadowBlur = 24
      ctx.fillText('鮫', pointer.x, pointer.y)
    }
    ctx.restore()
  }

  // snakes (tail → head)
  ctx.textBaseline = 'middle'
  for (const sn of snakes) {
    const n = sn.segs.length
    const frozen = sn.warmup > 0
    const movingRight = sn.vx >= 0

    for (let i = n - 1; i >= 0; i--) {
      const seg = sn.segs[i]!
      const char = sn.chars[i] ?? ''
      const t = i / Math.max(n - 1, 1)
      const alpha = frozen ? 1 : 0.38 + (1 - t) * 0.62

      ctx.globalAlpha = alpha

      let dx = 0, dy = 0
      if (!frozen) {
        const angle = Math.atan2(sn.vy, sn.vx)
        const wave = Math.sin(i * 0.45 + Date.now() * 0.004) * 2.5
        dx = -Math.sin(angle) * wave
        dy = Math.cos(angle) * wave
      }

      // text color throughout; head slightly brighter when swimming
      if (i === 0 && !frozen) {
        ctx.font = 'bold 17px serif'
        ctx.fillStyle = '#f5f0e8'
      } else {
        ctx.font = '15px serif'
        ctx.fillStyle = '#e8e4dc'
      }

      const rx = seg.x + dx
      const ry = seg.y + dy

      if (!frozen && !movingRight) {
        ctx.save()
        ctx.translate(rx, ry)
        ctx.scale(-1, 1)
        ctx.fillText(char, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(char, rx - 7, ry)
      }
    }
  }

  ctx.globalAlpha = 1
  ctx.textBaseline = 'alphabetic'
}

function tick(): void {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height

  for (const f of staticFoods) {
    if (!f.active) {
      if (--f.respawnIn <= 0) {
        f.pos = { x: rand(60, W - 60), y: rand(60, H - 60) }
        f.active = true
      }
    }
  }

  for (const sn of snakes) stepSnake(sn, W, H)
  if (wanderingShark) stepShark(wanderingShark, W, H)
  drawFrame(ctx)
  raf = requestAnimationFrame(tick)
}

function createToggleButton(stage: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = '🦐 餌モード'
  btn.style.cssText = `
    position: absolute;
    bottom: 72px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,30,60,0.75);
    color: #7ad;
    border: 1px solid rgba(100,200,255,0.35);
    border-radius: 24px;
    padding: 10px 28px;
    font-size: 15px;
    cursor: pointer;
    backdrop-filter: blur(6px);
    user-select: none;
    z-index: 10;
    touch-action: manipulation;
    transition: background 0.2s, color 0.2s;
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
  stage.appendChild(btn)
  return btn
}

export function startSnakeMode(
  stage: HTMLElement,
  lines: PageLine[],
  font: string,
  lineHeight: number,
): void {
  stopSnakeMode()

  // Canvas overlay (pointer-events: none so page interactions pass through)
  canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;'
  const W = stage.clientWidth || window.innerWidth
  const H = stage.clientHeight || window.innerHeight
  canvas.width = W
  canvas.height = H
  stage.appendChild(canvas)

  toggleBtn = createToggleButton(stage)

  const sentenceChars = charPositionsFromLines(lines, font, lineHeight)
  snakes = sentenceChars.slice(0, 20).map((chars, i) => makeSnake(chars, i))
  staticFoods = Array.from({ length: STATIC_FOOD_COUNT }, () => makeStaticFood(W, H))
  wanderingShark = makeShark(W, H)

  // Pointer tracking on window (canvas is pointer-events:none so page nav still works)
  boundPointerDown = (e: PointerEvent) => {
    if ((e.target as Element)?.closest('button, input, .topbar, #page-jump, #search-panel, #toc-overlay')) return
    clearTimeout(pointerFadeTimer ?? undefined)
    pointerFadeTimer = null
    pointer = { x: e.clientX, y: e.clientY }
  }
  boundPointerMove = (e: PointerEvent) => {
    if (e.buttons > 0 && pointer !== null) {
      pointer = { x: e.clientX, y: e.clientY }
    }
  }
  boundPointerUp = () => {
    clearTimeout(pointerFadeTimer ?? undefined)
    pointerFadeTimer = window.setTimeout(() => {
      pointer = null
      pointerFadeTimer = null
    }, 1200)
  }

  window.addEventListener('pointerdown', boundPointerDown)
  window.addEventListener('pointermove', boundPointerMove)
  window.addEventListener('pointerup', boundPointerUp)

  raf = requestAnimationFrame(tick)
}

export function stopSnakeMode(): void {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  canvas?.remove(); canvas = null
  toggleBtn?.remove(); toggleBtn = null

  if (boundPointerDown) { window.removeEventListener('pointerdown', boundPointerDown); boundPointerDown = null }
  if (boundPointerMove) { window.removeEventListener('pointermove', boundPointerMove); boundPointerMove = null }
  if (boundPointerUp) { window.removeEventListener('pointerup', boundPointerUp); boundPointerUp = null }
  clearTimeout(pointerFadeTimer ?? undefined)
  pointerFadeTimer = null
  pointer = null
  pointerMode = 'food'

  snakes = []
  staticFoods = []
  wanderingShark = null
}

export function isSnakeModeActive(): boolean {
  return canvas !== null
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
