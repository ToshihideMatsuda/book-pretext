// Snake animation — DOM-based (no canvas)
// Each character gets its own <span> at the exact same position as the
// original page text, so font rendering is identical before/after activation.
// Animation is applied via CSS transform so the layout position never changes.

const SEG_DIST_MIN = 13
const BASE_SPEED = 1.5
const POINTER_FOOD_DIST = 250
const POINTER_SHARK_DIST = 280
const WANDER = 0.12
export const DOUBLE_TAP_MS = 320
const WARMUP_FRAMES = 20
const STAGGER_FRAMES = 6

export interface PageLine {
  x: number
  y: number
  text: string
  element?: HTMLElement
}

export interface LineGroup {
  lines: PageLine[]
  font: string
  lineHeight: number
  color?: string
  letterSpacing?: number
  splitMode?: 'line' | 'sentence'
}

interface Pt { x: number; y: number }

interface CharSprite {
  char: string
  sourceElement?: HTMLElement
  sourceOffsetX?: number
  width: number
  x: number
  y: number
}

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
  segDist: number     // segment spacing, scaled to font size
  warmup: number
  swimming: boolean   // flipped true when warmup first ends
  returning: boolean  // returning to original positions
}

let container: HTMLDivElement | null = null
let pointerEl: HTMLDivElement | null = null
let raf: number | null = null
let snakes: Snake[] = []
let returnCallback: (() => void) | null = null

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

function collectTextNodes(root: HTMLElement): Array<{ end: number; node: Text; start: number }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Array<{ end: number; node: Text; start: number }> = []
  let offset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const length = node.data.length
    nodes.push({ end: offset + length, node, start: offset })
    offset += length
  }
  return nodes
}

function resolveTextOffset(
  nodes: Array<{ end: number; node: Text; start: number }>,
  offset: number,
): { node: Text; offset: number } | null {
  for (const entry of nodes) {
    if (offset >= entry.start && offset <= entry.end) {
      return { node: entry.node, offset: offset - entry.start }
    }
  }
  const last = nodes.at(-1)
  return last ? { node: last.node, offset: last.node.data.length } : null
}

function cloneLineFragment(source: HTMLElement, offsetX: number): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  clone.style.position = 'absolute'
  clone.style.left = `${-offsetX}px`
  clone.style.top = '0'
  clone.style.margin = '0'
  clone.style.transform = ''
  clone.style.pointerEvents = 'none'
  clone.style.userSelect = 'none'
  clone.style.whiteSpace = 'pre'
  return clone
}

function positionsFromElement(stage: HTMLElement, line: PageLine): CharSprite[] | null {
  if (!line.element) {
    return null
  }

  const nodes = collectTextNodes(line.element)
  if (nodes.length === 0) {
    return null
  }

  const chars = graphemes(line.text)
  const stageRect = stage.getBoundingClientRect()
  const lineRect = line.element.getBoundingClientRect()
  const lineX = lineRect.left - stageRect.left
  const lineY = lineRect.top - stageRect.top
  const sprites: CharSprite[] = []
  let codeUnitOffset = 0

  for (const char of chars) {
    const start = resolveTextOffset(nodes, codeUnitOffset)
    const end = resolveTextOffset(nodes, codeUnitOffset + char.length)
    if (!start || !end) {
      return null
    }

    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const rect = range.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      return null
    }

    const x = rect.left - stageRect.left
    sprites.push({
      char,
      sourceElement: line.element,
      sourceOffsetX: x - lineX,
      width: rect.width,
      x,
      y: lineY,
    })
    codeUnitOffset += char.length
  }

  return sprites
}

// Compute per-character x positions using measureText, y = CSS top of the line
function charPositionsFromLines(
  stage: HTMLElement,
  lines: PageLine[],
  font: string,
  letterSpacing = 0,
  splitMode: 'line' | 'sentence' = 'sentence',
): CharSprite[][] {
  const tmpCtx = document.createElement('canvas').getContext('2d')!
  tmpCtx.font = font
  const sentences: CharSprite[][] = []
  let current: CharSprite[] = []

  for (const line of lines) {
    const exactChars = positionsFromElement(stage, line)
    const chars = exactChars ?? graphemes(line.text).map(char => ({ char }))
    let rendered = ''
    let advance = 0
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index]!
      if (exactChars) {
        current.push(char)
      } else {
        current.push({
          char: char.char,
          width: tmpCtx.measureText(char.char).width,
          x: line.x + advance,
          y: line.y,
        })
      }
      rendered += char.char
      advance = tmpCtx.measureText(rendered).width + letterSpacing * (index + 1)
      if (splitMode === 'sentence' && /[。！？…]+/.test(char.char)) {
        if (current.length > 0) { sentences.push(current); current = [] }
      }
    }
    if (splitMode === 'line' && current.length > 0) {
      sentences.push(current)
      current = []
    }
  }
  if (current.length > 0) sentences.push(current)
  return sentences
}

function fontSizeFromFont(font: string): number {
  const m = font.match(/(\d+(?:\.\d+)?)px/)
  return m ? parseFloat(m[1]) : 18
}

function makeSnake(
  charPos: CharSprite[],
  index: number,
  font: string,
  lineHeight: number,
  color: string,
  parent: HTMLDivElement,
): Snake {
  const angle = Math.random() * Math.PI * 2
  const speed = BASE_SPEED * rand(0.75, 1.25)
  const segDist = Math.max(SEG_DIST_MIN, fontSizeFromFont(font) * 0.65)

  const segs: Seg[] = charPos.map(cp => {
    const el = document.createElement('span')
    el.style.position = 'absolute'
    el.style.left = `${cp.x}px`
    el.style.top = `${cp.y}px`
    el.style.width = `${Math.max(cp.width, 1)}px`
    el.style.height = `${lineHeight}px`
    el.style.overflow = 'hidden'
    el.style.whiteSpace = 'pre'
    el.style.willChange = 'transform, opacity'
    el.style.pointerEvents = 'none'
    el.style.userSelect = 'none'

    if (cp.sourceElement) {
      el.appendChild(cloneLineFragment(cp.sourceElement, cp.sourceOffsetX ?? 0))
    } else {
      el.textContent = cp.char
      el.style.font = font
      el.style.lineHeight = `${lineHeight}px`
      el.style.color = color
    }

    parent.appendChild(el)
    return { x: cp.x, y: cp.y, ox: cp.x, oy: cp.y, el }
  })

  return {
    segs,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    segDist,
    warmup: WARMUP_FRAMES + index * STAGGER_FRAMES,
    swimming: false,
    returning: false,
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
    if (d > sn.segDist) {
      curr.x = prev.x + (dx / d) * sn.segDist
      curr.y = prev.y + (dy / d) * sn.segDist
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
      const headEl = sn.segs[0]?.el.firstElementChild instanceof HTMLElement
        ? sn.segs[0]!.el.firstElementChild
        : sn.segs[0]?.el
      if (headEl) {
        headEl.style.textShadow = '0 0 10px rgb(255 255 255 / 0.18)'
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

      // Lateral sinusoidal wiggle (suppressed while returning)
      const wave = sn.returning ? 0 : Math.sin(i * 0.45 + now * 0.004) * 2.5
      const wx = -Math.sin(angle) * wave
      const wy = Math.cos(angle) * wave

      const tx = seg.x - seg.ox + wx
      const ty = seg.y - seg.oy + wy
      seg.el.style.transform = `translate(${tx}px, ${ty}px)`
      // fade back to full opacity while returning
      seg.el.style.opacity = sn.returning ? '1' : String(0.38 + (1 - t) * 0.62)
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

// Returns true when all segments have reached their original positions
function stepReturn(sn: Snake): boolean {
  let done = true
  for (const seg of sn.segs) {
    seg.x += (seg.ox - seg.x) * 0.14
    seg.y += (seg.oy - seg.y) * 0.14
    if (Math.sqrt((seg.x - seg.ox) ** 2 + (seg.y - seg.oy) ** 2) > 1.5) done = false
  }
  return done
}

function tick(now: number): void {
  if (!container) return
  const W = window.innerWidth
  const H = window.innerHeight

  if (returnCallback) {
    let allDone = true
    for (const sn of snakes) {
      if (!stepReturn(sn)) allDone = false
    }
    updateDOM(now)
    if (allDone) {
      const cb = returnCallback
      returnCallback = null
      cb()
      return
    }
  } else {
    for (const sn of snakes) stepSnake(sn, W, H)
    updateDOM(now)
  }

  raf = requestAnimationFrame(tick)
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
  bodyGroup: LineGroup,
  headlineGroup?: LineGroup,
  dropCapGroup?: LineGroup,
  authorGroup?: LineGroup,
): void {
  stopSnakeMode()

  container = document.createElement('div')
  container.style.cssText = 'position:absolute;inset:0;z-index:6;overflow:hidden;pointer-events:none;'
  stage.appendChild(container)

  pointerEl = createPointerEl(stage)

  // Headline snakes first (so they peel off before body sentences)
  const groups = [dropCapGroup, headlineGroup, authorGroup, bodyGroup].filter(Boolean) as LineGroup[]
  const all = groups.flatMap(group =>
    charPositionsFromLines(
      stage,
      group.lines,
      group.font,
      group.letterSpacing ?? 0,
      group.splitMode ?? 'sentence',
    ).map(chars => ({
      chars,
      color: group.color ?? '#e8e4dc',
      font: group.font,
      lineHeight: group.lineHeight,
    })),
  )
  snakes = all.map(({ chars, font, lineHeight }, i) =>
    makeSnake(chars, i, font, lineHeight, all[i]!.color, container!),
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

export function triggerReturn(onComplete: () => void): void {
  returnCallback = onComplete
  for (const sn of snakes) {
    sn.returning = true
    sn.warmup = 0  // unfreeze any still-frozen snakes so they can return
  }
  // Hide pointer indicator immediately
  if (pointerEl) pointerEl.style.display = 'none'
}

export function stopSnakeMode(): void {
  returnCallback = null
  if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  container?.remove(); container = null
  pointerEl?.remove(); pointerEl = null

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

export function togglePointerMode(): void {
  pointerMode = pointerMode === 'food' ? 'shark' : 'food'
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
