// Snake animation overlay
// Each sentence from the current page swims like a snake.
// Head = sentence start, tail = sentence end.
// Snakes approach food (🦐) and flee sharks (🦈).
// Double-tap on stage to toggle.

const SEG_DIST = 14
const BASE_SPEED = 1.6
const FOOD_ATTRACT_DIST = 220
const SHARK_REPEL_DIST = 260
const FOOD_COUNT = 6
const SHARK_COUNT = 2
const WANDER = 0.13
const DOUBLE_TAP_MS = 320

interface Pt { x: number; y: number }

interface Snake {
  segs: Pt[]
  chars: string[]
  vx: number
  vy: number
  hue: number  // color variation
}

interface Food {
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
let raf: number | null = null
let snakes: Snake[] = []
let foods: Food[] = []
let sharks: Shark[] = []
let lastTapTime = 0
let lastTapX = 0
let lastTapY = 0

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })

function graphemes(s: string): string[] {
  return [...segmenter.segment(s)].map(g => g.segment)
}

// Split text into sentences on 。！？… boundaries
function splitSentences(text: string): string[] {
  const raw = text.split(/(?<=[。！？…]+)/)
  return raw.map(s => s.trim()).filter(s => s.length >= 2)
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function dst(a: Pt, b: Pt): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function makeSnake(sentence: string, W: number, H: number): Snake {
  const chars = graphemes(sentence)
  const angle = Math.random() * Math.PI * 2
  const speed = BASE_SPEED * rand(0.7, 1.3)
  const vx = Math.cos(angle) * speed
  const vy = Math.sin(angle) * speed
  const sx = rand(80, W - 80)
  const sy = rand(80, H - 80)
  const segs: Pt[] = chars.map((_, i) => ({
    x: sx - (vx / speed) * i * SEG_DIST,
    y: sy - (vy / speed) * i * SEG_DIST,
  }))
  return { segs, chars, vx, vy, hue: Math.random() * 360 }
}

function makeFood(W: number, H: number): Food {
  return { pos: { x: rand(60, W - 60), y: rand(60, H - 60) }, active: true, respawnIn: 0 }
}

function makeShark(W: number, H: number): Shark {
  const angle = Math.random() * Math.PI * 2
  const speed = BASE_SPEED * 0.55
  return {
    pos: { x: rand(80, W - 80), y: rand(80, H - 80) },
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  }
}

function stepSnake(sn: Snake, W: number, H: number): void {
  const head = sn.segs[0]!
  let ax = 0
  let ay = 0

  // attract to nearest active food
  let minFoodD = Infinity
  let nearFood: Food | null = null
  for (const f of foods) {
    if (!f.active) continue
    const d = dst(head, f.pos)
    if (d < minFoodD) { minFoodD = d; nearFood = f }
  }
  if (nearFood && minFoodD < FOOD_ATTRACT_DIST) {
    const dx = nearFood.pos.x - head.x
    const dy = nearFood.pos.y - head.y
    const w = (1 - minFoodD / FOOD_ATTRACT_DIST) * 0.14
    ax += (dx / minFoodD) * w
    ay += (dy / minFoodD) * w
    if (minFoodD < 18) {
      nearFood.active = false
      nearFood.respawnIn = 180 + Math.floor(Math.random() * 180)
    }
  }

  // repel from sharks
  for (const s of sharks) {
    const d = dst(head, s.pos)
    if (d < SHARK_REPEL_DIST && d > 0) {
      const w = (1 - d / SHARK_REPEL_DIST) * 0.4
      ax -= ((s.pos.x - head.x) / d) * w
      ay -= ((s.pos.y - head.y) / d) * w
    }
  }

  // gentle wander
  ax += (Math.random() - 0.5) * WANDER
  ay += (Math.random() - 0.5) * WANDER

  sn.vx += ax
  sn.vy += ay

  // clamp speed
  const spd = Math.sqrt(sn.vx * sn.vx + sn.vy * sn.vy)
  const maxSpd = BASE_SPEED * 2.2
  const minSpd = BASE_SPEED * 0.35
  if (spd > maxSpd) { sn.vx = (sn.vx / spd) * maxSpd; sn.vy = (sn.vy / spd) * maxSpd }
  if (spd < minSpd && spd > 0) { sn.vx = (sn.vx / spd) * minSpd; sn.vy = (sn.vy / spd) * minSpd }

  // bounce off walls
  const margin = 24
  if (head.x < margin) sn.vx = Math.abs(sn.vx)
  if (head.x > W - margin) sn.vx = -Math.abs(sn.vx)
  if (head.y < margin) sn.vy = Math.abs(sn.vy)
  if (head.y > H - margin) sn.vy = -Math.abs(sn.vy)

  // move head
  head.x += sn.vx
  head.y += sn.vy

  // drag body segments
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

  // food
  ctx.font = '18px serif'
  for (const f of foods) {
    if (!f.active) continue
    ctx.globalAlpha = 0.9
    ctx.fillText('🦐', f.pos.x - 9, f.pos.y + 9)
  }

  // sharks
  ctx.font = '24px serif'
  for (const s of sharks) {
    ctx.globalAlpha = 1
    // flip horizontally based on direction
    const flip = s.vx < 0
    if (flip) {
      ctx.save()
      ctx.scale(-1, 1)
      ctx.fillText('🦈', -s.pos.x - 12, s.pos.y + 12)
      ctx.restore()
    } else {
      ctx.fillText('🦈', s.pos.x - 12, s.pos.y + 12)
    }
  }

  // snakes (draw tail → head so head is on top)
  ctx.textBaseline = 'middle'
  for (const sn of snakes) {
    const n = sn.segs.length
    const isMovingRight = sn.vx >= 0

    for (let i = n - 1; i >= 0; i--) {
      const seg = sn.segs[i]!
      const char = sn.chars[i] ?? ''
      const t = i / Math.max(n - 1, 1)  // 0 = head, 1 = tail
      const alpha = 0.35 + (1 - t) * 0.65

      ctx.globalAlpha = alpha

      if (i === 0) {
        // head: warm gold, slightly larger
        ctx.font = 'bold 17px serif'
        ctx.fillStyle = '#ffd45e'
      } else {
        // body: hue-shifted color, fades toward tail
        const lightness = 70 + t * 10
        ctx.font = '15px serif'
        ctx.fillStyle = `hsl(${sn.hue}, 70%, ${lightness}%)`
      }

      // slight lateral undulation perpendicular to motion
      const angle = Math.atan2(sn.vy, sn.vx)
      const wave = Math.sin(i * 0.45 + Date.now() * 0.004) * 2.5
      const nx = -Math.sin(angle) * wave
      const ny = Math.cos(angle) * wave

      // mirror characters when swimming left
      if (!isMovingRight) {
        ctx.save()
        ctx.translate(seg.x + nx, seg.y + ny)
        ctx.scale(-1, 1)
        ctx.fillText(char, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(char, seg.x + nx - 7, seg.y + ny)
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

  // respawn eaten food
  for (const f of foods) {
    if (!f.active) {
      f.respawnIn--
      if (f.respawnIn <= 0) {
        f.pos = { x: rand(60, W - 60), y: rand(60, H - 60) }
        f.active = true
      }
    }
  }

  for (const sn of snakes) stepSnake(sn, W, H)
  for (const s of sharks) stepShark(s, W, H)
  drawFrame(ctx)
  raf = requestAnimationFrame(tick)
}

export function startSnakeMode(stage: HTMLElement, pageText: string): void {
  stopSnakeMode()

  canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;'
  const W = stage.clientWidth || window.innerWidth
  const H = stage.clientHeight || window.innerHeight
  canvas.width = W
  canvas.height = H
  stage.appendChild(canvas)

  const sentences = splitSentences(pageText)
  snakes = sentences.slice(0, 20).map(s => makeSnake(s, W, H))
  foods = Array.from({ length: FOOD_COUNT }, () => makeFood(W, H))
  sharks = Array.from({ length: SHARK_COUNT }, () => makeShark(W, H))

  raf = requestAnimationFrame(tick)
}

export function stopSnakeMode(): void {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  canvas?.remove()
  canvas = null
  snakes = []
  foods = []
  sharks = []
}

export function isSnakeModeActive(): boolean {
  return canvas !== null
}

// Double-tap detection helper
// Returns true if this tap qualifies as a double-tap
export function recordTap(x: number, y: number): boolean {
  const now = Date.now()
  const dt = now - lastTapTime
  const moved = Math.sqrt((x - lastTapX) ** 2 + (y - lastTapY) ** 2)
  lastTapTime = now
  lastTapX = x
  lastTapY = y
  return dt < DOUBLE_TAP_MS && moved < 60
}
