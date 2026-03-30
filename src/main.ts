import {
  layoutNextLine,
  layoutWithLines,
  prepareWithSegments,
  walkLineRanges,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'

const BODY_FONT = '18px "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "HGS明朝E", serif'
const BODY_LINE_HEIGHT = 30
const HEADLINE_FONT_FAMILY = '"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "HGS明朝E", serif'
const GUTTER = 48
const COL_GAP = 40
const BOTTOM_GAP = 20
const DROP_CAP_LINES = 3
const MIN_SLOT_WIDTH = 50
const NARROW_BREAKPOINT = 760
const NARROW_GUTTER = 20
const NARROW_COL_GAP = 20
const NARROW_BOTTOM_GAP = 16

type Interval = { left: number; right: number }
type PositionedLine = { x: number; y: number; width: number; text: string }
type RectObstacle = { x: number; y: number; w: number; h: number }
type RenderedPage = { cursor: LayoutCursor; hasBodyContent: boolean }

type LayerPool = {
  lines: HTMLSpanElement[]
  headlines: HTMLSpanElement[]
  dropCap: HTMLDivElement | null
}

type BookSource = {
  assetUrl: string
  authorFromPath: string
  fileName: string
  id: string
}

type Book = {
  author: string
  bodyText: string
  dropCapText: string
  dropCapTotalWidth: number
  fileName: string
  id: string
  lastPage: number
  pageCursors: LayoutCursor[]
  preparedBody: PreparedTextWithSegments
  preparedDropCap: PreparedTextWithSegments
  title: string
}

const bookModules = import.meta.glob('../books/**/*.txt', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

const collator = new Intl.Collator('ja')
const DROP_CAP_SIZE = BODY_LINE_HEIGHT * DROP_CAP_LINES - 4
const DROP_CAP_FONT = `700 ${DROP_CAP_SIZE}px ${HEADLINE_FONT_FAMILY}`

await document.fonts.ready

const sources = Object.entries(bookModules)
  .filter(([path]) => path.endsWith('.txt'))
  .sort(([left], [right]) => collator.compare(left, right))
  .map(([path, assetUrl], index) => {
    const relativePath = path.replace('../books/', '')
    const [authorFromPath, fileName] = relativePath.split('/')
    const slug = fileName
      .replace(/\.txt$/i, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')

    return {
      assetUrl,
      authorFromPath,
      fileName,
      id: `book-${String(index + 1).padStart(2, '0')}-${slug || 'text'}`,
    } satisfies BookSource
  })

const books = await Promise.all(sources.map(loadBook))

if (books.length === 0) {
  throw new Error('No books were found in books/.')
}

const stageElement = document.getElementById('stage')
const tocOverlayElement = document.getElementById('toc-overlay')
const tocListElement = document.getElementById('toc-list')
const tocToggleElement = document.getElementById('toc-toggle')
const tocCloseElement = document.getElementById('toc-close')
const tocResumeElement = document.getElementById('toc-resume')
const pageNumElement = document.getElementById('page-num')
const bookMetaElement = document.getElementById('book-meta')

if (
  !stageElement ||
  !tocOverlayElement ||
  !tocListElement ||
  !tocToggleElement ||
  !tocCloseElement ||
  !tocResumeElement ||
  !pageNumElement ||
  !bookMetaElement
) {
  throw new Error('Required DOM nodes were not found.')
}

const stage = stageElement
const tocOverlay = tocOverlayElement
const tocList = tocListElement
const tocToggle = tocToggleElement
const tocClose = tocCloseElement
const tocResume = tocResumeElement
const pageNum = pageNumElement
const bookMeta = bookMetaElement

const layerA = document.createElement('div')
layerA.className = 'page-layer'
const layerB = document.createElement('div')
layerB.className = 'page-layer'
stage.appendChild(layerA)
stage.appendChild(layerB)

let frontLayer = layerA
let backLayer = layerB
let activeBookIndex = 0
let currentPage = 0
let isAnimating = false
let returnPoint: { bookIndex: number; page: number } | null = null

const layerPools = new Map<HTMLElement, LayerPool>()

function getPool(layer: HTMLElement): LayerPool {
  let pool = layerPools.get(layer)
  if (!pool) {
    pool = { lines: [], headlines: [], dropCap: null }
    layerPools.set(layer, pool)
  }
  return pool
}

function syncPool<T extends HTMLElement>(layer: HTMLElement, pool: T[], count: number, create: () => T): void {
  while (pool.length < count) {
    const el = create()
    layer.appendChild(el)
    pool.push(el)
  }
  for (let i = 0; i < pool.length; i++) {
    pool[i]!.style.display = i < count ? '' : 'none'
  }
}

function clearLayer(layer: HTMLElement): void {
  layer.replaceChildren()
  layerPools.set(layer, { lines: [], headlines: [], dropCap: null })
}

function syncLayerStack(): void {
  frontLayer.style.zIndex = '2'
  backLayer.style.zIndex = '1'
}

function setAnimatingLayerStack(): void {
  frontLayer.style.zIndex = '3'
  backLayer.style.zIndex = '2'
}

let cachedHeadlineKey = ''
let cachedHeadlineFontSize = 24
let cachedHeadlineLines: PositionedLine[] = []

function fitHeadline(
  headlineText: string,
  maxWidth: number,
  maxHeight: number,
  maxSize: number,
): { fontSize: number; lines: PositionedLine[] } {
  const key = `${headlineText}::${maxWidth}x${maxHeight}x${maxSize}`
  if (key === cachedHeadlineKey) {
    return { fontSize: cachedHeadlineFontSize, lines: cachedHeadlineLines }
  }

  cachedHeadlineKey = key
  let lo = 20
  let hi = maxSize
  let best = lo
  let bestLines: PositionedLine[] = []

  while (lo <= hi) {
    const size = Math.floor((lo + hi) / 2)
    const font = `700 ${size}px ${HEADLINE_FONT_FAMILY}`
    const lineHeight = Math.round(size * 0.93)
    const preparedHeadline = prepareWithSegments(headlineText, font)
    let breaksWord = false
    let lineCount = 0

    walkLineRanges(preparedHeadline, maxWidth, line => {
      lineCount += 1
      if (line.end.graphemeIndex !== 0) {
        breaksWord = true
      }
    })

    if (!breaksWord && lineCount * lineHeight <= maxHeight) {
      best = size
      bestLines = layoutWithLines(preparedHeadline, maxWidth, lineHeight).lines.map((line, index) => ({
        x: 0,
        y: index * lineHeight,
        text: line.text,
        width: line.width,
      }))
      lo = size + 1
    } else {
      hi = size - 1
    }
  }

  cachedHeadlineFontSize = best
  cachedHeadlineLines = bestLines
  return { fontSize: best, lines: bestLines }
}

function carveSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots = [base]
  for (const item of blocked) {
    const next: Interval[] = []
    for (const slot of slots) {
      if (item.right <= slot.left || item.left >= slot.right) {
        next.push(slot)
        continue
      }
      if (item.left > slot.left) {
        next.push({ left: slot.left, right: item.left })
      }
      if (item.right < slot.right) {
        next.push({ left: item.right, right: slot.right })
      }
    }
    slots = next
  }
  return slots.filter(slot => slot.right - slot.left >= MIN_SLOT_WIDTH)
}

function layoutColumnSimple(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  lineHeight: number,
  rectObstacles: RectObstacle[],
): { lines: PositionedLine[]; cursor: LayoutCursor } {
  let cursor = startCursor
  let lineTop = regionY
  const lines: PositionedLine[] = []
  let textExhausted = false

  while (lineTop + lineHeight <= regionY + regionH && !textExhausted) {
    const bandTop = lineTop
    const bandBottom = lineTop + lineHeight
    const blocked: Interval[] = []

    for (const rect of rectObstacles) {
      if (bandBottom <= rect.y || bandTop >= rect.y + rect.h) {
        continue
      }
      blocked.push({ left: rect.x, right: rect.x + rect.w })
    }

    const slots = carveSlots({ left: regionX, right: regionX + regionW }, blocked)
    if (slots.length === 0) {
      lineTop += lineHeight
      continue
    }

    const ordered = [...slots].sort((left, right) => left.left - right.left)
    for (const slot of ordered) {
      const line = layoutNextLine(prepared, cursor, slot.right - slot.left)
      if (line === null) {
        textExhausted = true
        break
      }
      lines.push({ x: Math.round(slot.left), y: Math.round(lineTop), text: line.text, width: line.width })
      cursor = line.end
    }
    lineTop += lineHeight
  }

  return { lines, cursor }
}

function isSameCursor(left: LayoutCursor, right: LayoutCursor): boolean {
  return left.segmentIndex === right.segmentIndex && left.graphemeIndex === right.graphemeIndex
}

function getCurrentBook(): Book {
  return books[activeBookIndex]!
}

function renderPageToLayer(
  layer: HTMLElement,
  startCursor: LayoutCursor,
  pageIndex: number,
  book: Book,
): RenderedPage {
  const pool = getPool(layer)
  const pageWidth = document.documentElement.clientWidth
  const pageHeight = document.documentElement.clientHeight
  const isNarrow = pageWidth < NARROW_BREAKPOINT
  const gutter = isNarrow ? NARROW_GUTTER : GUTTER
  const colGap = isNarrow ? NARROW_COL_GAP : COL_GAP
  const bottomGap = isNarrow ? NARROW_BOTTOM_GAP : BOTTOM_GAP

  const headlineWidth = Math.min(pageWidth - gutter * 2, 1000)
  const maxHeadlineHeight = Math.floor(pageHeight * (isNarrow ? 0.2 : 0.24))
  const maxHeadlineSize = isNarrow ? 38 : 92
  const { fontSize: headlineSize, lines: headlineLines } = fitHeadline(
    book.title,
    headlineWidth,
    maxHeadlineHeight,
    maxHeadlineSize,
  )
  const headlineLineHeight = Math.round(headlineSize * 0.93)
  const headlineFont = `700 ${headlineSize}px ${HEADLINE_FONT_FAMILY}`
  const headlineHeight = headlineLines.length * headlineLineHeight

  const bodyTop = gutter + headlineHeight + (isNarrow ? 14 : 20)
  const bodyHeight = pageHeight - bodyTop - bottomGap
  const columnCount = pageWidth > 1000 ? 3 : pageWidth > 640 ? 2 : 1
  const columnWidth = Math.floor((Math.min(pageWidth, 1500) - gutter * 2 - colGap * (columnCount - 1)) / columnCount)
  const contentLeft = Math.round((pageWidth - (columnCount * columnWidth + (columnCount - 1) * colGap)) / 2)

  const isFirstPage = pageIndex === 0

  if (isFirstPage) {
    if (!pool.dropCap) {
      const dropCap = document.createElement('div')
      dropCap.className = 'drop-cap'
      layer.appendChild(dropCap)
      pool.dropCap = dropCap
    }
    pool.dropCap.textContent = book.dropCapText
    pool.dropCap.style.font = DROP_CAP_FONT
    pool.dropCap.style.lineHeight = `${DROP_CAP_SIZE}px`
    pool.dropCap.style.left = `${contentLeft - 2}px`
    pool.dropCap.style.top = `${bodyTop - 2}px`
    pool.dropCap.style.display = ''
  } else if (pool.dropCap) {
    pool.dropCap.style.display = 'none'
  }

  const dropCapRect: RectObstacle | null = isFirstPage
    ? {
        x: contentLeft - 2,
        y: bodyTop - 2,
        w: book.dropCapTotalWidth,
        h: DROP_CAP_LINES * BODY_LINE_HEIGHT + 2,
      }
    : null

  const allLines: PositionedLine[] = []
  let cursor = startCursor
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    const columnX = contentLeft + columnIndex * (columnWidth + colGap)
    const rects: RectObstacle[] = columnIndex === 0 && dropCapRect ? [dropCapRect] : []
    const result = layoutColumnSimple(
      book.preparedBody,
      cursor,
      columnX,
      bodyTop,
      columnWidth,
      bodyHeight,
      BODY_LINE_HEIGHT,
      rects,
    )
    allLines.push(...result.lines)
    cursor = result.cursor
  }

  syncPool(layer, pool.headlines, headlineLines.length, () => {
    const el = document.createElement('span')
    el.className = 'headline-line'
    return el
  })
  for (let i = 0; i < headlineLines.length; i++) {
    const el = pool.headlines[i]!
    const line = headlineLines[i]!
    el.textContent = line.text
    el.style.left = `${gutter + line.x}px`
    el.style.top = `${gutter + line.y}px`
    el.style.font = headlineFont
    el.style.lineHeight = `${headlineLineHeight}px`
  }

  syncPool(layer, pool.lines, allLines.length, () => {
    const el = document.createElement('span')
    el.className = 'line'
    return el
  })
  for (let i = 0; i < allLines.length; i++) {
    const el = pool.lines[i]!
    const line = allLines[i]!
    el.textContent = line.text
    el.style.left = `${line.x}px`
    el.style.top = `${line.y}px`
    el.style.font = BODY_FONT
    el.style.lineHeight = `${BODY_LINE_HEIGHT}px`
  }

  return { cursor, hasBodyContent: allLines.length > 0 && !isSameCursor(cursor, startCursor) }
}

function createInitialCursor(book: Book): LayoutCursor {
  const firstBodySegment = book.preparedBody.segments?.[0] ?? ''
  return firstBodySegment === book.dropCapText
    ? { segmentIndex: 1, graphemeIndex: 0 }
    : { segmentIndex: 0, graphemeIndex: 1 }
}

function ensureBookInitialized(book: Book): void {
  if (book.pageCursors.length === 0) {
    book.pageCursors.push(createInitialCursor(book))
  }
}

function updatePageCounter(): void {
  pageNum.textContent = String(currentPage + 1)
  const book = getCurrentBook()
  bookMeta.textContent = `${book.author} / ${book.title}`
}

function renderCurrentBook(): void {
  const book = getCurrentBook()
  ensureBookInitialized(book)
  const cursor = book.pageCursors[currentPage] ?? book.pageCursors[0]!
  const currentPageRender = renderPageToLayer(frontLayer, cursor, currentPage, book)
  book.pageCursors[currentPage + 1] = currentPageRender.cursor
  book.lastPage = currentPage
  updatePageCounter()
  syncLayerStack()
  clearLayer(backLayer)
  backLayer.classList.add('page-hidden')
}

function switchBook(bookIndex: number, pageIndex = 0): void {
  if (bookIndex < 0 || bookIndex >= books.length) {
    return
  }

  getCurrentBook().lastPage = currentPage
  activeBookIndex = bookIndex
  currentPage = pageIndex
  cachedHeadlineKey = ''
  renderCurrentBook()
}

function goNextPage(): void {
  if (isAnimating || tocOverlay.classList.contains('toc-open')) {
    return
  }

  const book = getCurrentBook()
  const nextCursor = book.pageCursors[currentPage + 1]
  if (!nextCursor) {
    return
  }

  const nextPage = renderPageToLayer(backLayer, nextCursor, currentPage + 1, book)
  if (!nextPage.hasBodyContent) {
    clearLayer(backLayer)
    backLayer.classList.add('page-hidden')
    return
  }
  book.pageCursors[currentPage + 2] = nextPage.cursor

  isAnimating = true
  setAnimatingLayerStack()
  backLayer.classList.remove('page-hidden')
  frontLayer.classList.add('anim-out-fwd')
  backLayer.classList.add('anim-in-fwd')

  frontLayer.addEventListener(
    'animationend',
    () => {
      frontLayer.classList.remove('anim-out-fwd')
      backLayer.classList.remove('anim-in-fwd')
      frontLayer.style.transform = ''
      backLayer.style.transform = ''

      const newBack = frontLayer
      frontLayer = backLayer
      backLayer = newBack

      currentPage += 1
      book.lastPage = currentPage
      updatePageCounter()
      syncLayerStack()
      clearLayer(backLayer)
      backLayer.classList.add('page-hidden')

      isAnimating = false
    },
    { once: true },
  )
}

function goPrevPage(): void {
  if (isAnimating || currentPage === 0 || tocOverlay.classList.contains('toc-open')) {
    return
  }

  isAnimating = true
  renderPageToLayer(backLayer, getCurrentBook().pageCursors[currentPage - 1]!, currentPage - 1, getCurrentBook())
  setAnimatingLayerStack()
  backLayer.classList.remove('page-hidden')
  frontLayer.classList.add('anim-out-bwd')
  backLayer.classList.add('anim-in-bwd')

  frontLayer.addEventListener(
    'animationend',
    () => {
      frontLayer.classList.remove('anim-out-bwd')
      backLayer.classList.remove('anim-in-bwd')
      frontLayer.style.transform = ''
      backLayer.style.transform = ''

      const newBack = frontLayer
      frontLayer = backLayer
      backLayer = newBack

      currentPage -= 1
      getCurrentBook().lastPage = currentPage
      updatePageCounter()
      syncLayerStack()
      clearLayer(backLayer)
      backLayer.classList.add('page-hidden')

      isAnimating = false
    },
    { once: true },
  )
}

function renderToc(): void {
  tocList.replaceChildren()

  for (let index = 0; index < books.length; index++) {
    const book = books[index]!
    const button = document.createElement('button')
    button.className = 'toc-item'
    if (index === activeBookIndex) {
      button.classList.add('toc-item-active')
    }
    button.type = 'button'
    button.innerHTML = `<strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span>`
    button.addEventListener('click', () => {
      closeToc()
      switchBook(index, 0)
    })
    tocList.appendChild(button)
  }
}

function openToc(): void {
  if (tocOverlay.classList.contains('toc-open')) {
    return
  }

  returnPoint = { bookIndex: activeBookIndex, page: currentPage }
  renderToc()
  tocOverlay.classList.add('toc-open')
}

function closeToc(): void {
  tocOverlay.classList.remove('toc-open')
}

function resumeFromToc(): void {
  if (!returnPoint) {
    closeToc()
    return
  }

  closeToc()
  switchBook(returnPoint.bookIndex, returnPoint.page)
}

document.getElementById('nav-prev')!.addEventListener('click', () => goPrevPage())
document.getElementById('nav-next')!.addEventListener('click', () => goNextPage())
tocToggle.addEventListener('click', () => openToc())
tocClose.addEventListener('click', () => closeToc())
tocResume.addEventListener('click', () => resumeFromToc())

window.addEventListener('click', (event: MouseEvent) => {
  const target = event.target as Element
  if (tocOverlay.classList.contains('toc-open')) {
    if (target === tocOverlay) {
      closeToc()
    }
    return
  }
  if (target.closest('#nav-prev, #nav-next, #toc-toggle')) {
    return
  }
  if (event.clientX > window.innerWidth * 0.5) {
    goNextPage()
  } else {
    goPrevPage()
  }
})

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && tocOverlay.classList.contains('toc-open')) {
    closeToc()
    return
  }
  if (event.key === 't' || event.key === 'T') {
    event.preventDefault()
    if (tocOverlay.classList.contains('toc-open')) {
      closeToc()
    } else {
      openToc()
    }
    return
  }
  if (tocOverlay.classList.contains('toc-open')) {
    return
  }
  if (event.key === 'ArrowRight' || event.key === ' ') {
    event.preventDefault()
    goNextPage()
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    goPrevPage()
  }
})

let touchStartX = 0
window.addEventListener(
  'touchstart',
  (event: TouchEvent) => {
    touchStartX = event.touches[0]!.clientX
  },
  { passive: true },
)
window.addEventListener(
  'touchend',
  (event: TouchEvent) => {
    if (tocOverlay.classList.contains('toc-open')) {
      return
    }
    const deltaX = event.changedTouches[0]!.clientX - touchStartX
    if (Math.abs(deltaX) > 50) {
      if (deltaX < 0) {
        goNextPage()
      } else {
        goPrevPage()
      }
    }
  },
  { passive: true },
)

window.addEventListener('resize', () => {
  if (isAnimating) {
    return
  }
  cachedHeadlineKey = ''
  renderCurrentBook()
})

renderCurrentBook()

async function loadBook(source: BookSource): Promise<Book> {
  const buffer = await fetch(source.assetUrl).then(response => response.arrayBuffer())
  const decoded = decodeText(buffer)
  const normalized = decoded.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const dividerIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (/^-{20,}\s*$/.test(line)) {
      indexes.push(index)
    }
    return indexes
  }, [])

  const headerLines = (dividerIndexes.length > 0 ? lines.slice(0, dividerIndexes[0]) : lines.slice(0, 8))
    .map(line => line.trim())
    .filter(Boolean)
  const title = headerLines[0] ?? source.fileName.replace(/\.txt$/i, '')
  const author = headerLines[1] ?? source.authorFromPath
  const bodyStartIndex = dividerIndexes.length >= 2 ? dividerIndexes[1]! + 1 : 0
  const bodyLines = lines.slice(bodyStartIndex)
  const footerIndex = bodyLines.findIndex(line => /^(底本|入力|校正|初出)[:：]/.test(line.trim()))
  const textLines = (footerIndex >= 0 ? bodyLines.slice(0, footerIndex) : bodyLines)
    .map(cleanLine)
    .filter((line): line is string => line !== null)

  const bodyText = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trimStart()
  const dropCapText = bodyText[0] ?? ''
  const preparedBody = prepareWithSegments(bodyText, BODY_FONT)
  const preparedDropCap = prepareWithSegments(dropCapText, DROP_CAP_FONT)
  let dropCapWidth = 0
  walkLineRanges(preparedDropCap, 9999, line => {
    dropCapWidth = line.width
  })

  return {
    author,
    bodyText,
    dropCapText,
    dropCapTotalWidth: Math.ceil(dropCapWidth) + 10,
    fileName: source.fileName,
    id: source.id,
    lastPage: 0,
    pageCursors: [],
    preparedBody,
    preparedDropCap,
    title,
  }
}

function cleanLine(line: string): string | null {
  const withoutNotes = line.replace(/［＃.*?］/g, '').trimEnd()
  const withoutRuby = withoutNotes.replace(/｜([^《\n]+)《[^》\n]+》/g, '$1').replace(/([一-龠々ぁ-んァ-ヴーゝゞヵヶ]+)《[^》\n]+》/g, '$1')
  const cleaned = withoutRuby.trim()

  if (!cleaned) {
    return null
  }
  if (cleaned === '【テキスト中に現れる記号について】') {
    return null
  }
  if (/^(《》：ルビ|｜：ルビの付く文字列の始まりを特定する記号|［＃］：入力者注)/.test(cleaned)) {
    return null
  }
  if (/^（例）/.test(cleaned)) {
    return null
  }

  return cleaned
}

function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('shift_jis').decode(buffer)
  } catch {
    return new TextDecoder().decode(buffer)
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
