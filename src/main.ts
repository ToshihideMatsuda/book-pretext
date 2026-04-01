import {
  layoutNextLine,
  layoutWithLines,
  prepareWithSegments,
  walkLineRanges,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'
import { startSnakeMode, stopSnakeMode, triggerReturn, isSnakeModeActive, recordTap } from './snake-animation'

const DEFAULT_BODY_FONT_SIZE = 18
const MIN_BODY_FONT_SIZE = 12
const MAX_BODY_FONT_SIZE = 30
const BODY_LINE_HEIGHT_RATIO = 30 / 18
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
const SEARCH_RESULT_LIMIT = 200
const UI_AUTO_HIDE_MS = 2000
const SWIPE_THRESHOLD = 50
const TAP_MAX_MOVEMENT = 10

type Interval = { left: number; right: number }
type PositionedLine = { x: number; y: number; width: number; text: string }
type BodyLine = PositionedLine & { end: LayoutCursor; endOffset: number; start: LayoutCursor; startOffset: number }
type RectObstacle = { x: number; y: number; w: number; h: number }
type RenderedPage = {
  bodyFont: string
  bodyLineHeight: number
  bodyLines: BodyLine[]
  contentLeft: number
  cursor: LayoutCursor
  dropCapFont: string
  dropCapSize: number
  hasBodyContent: boolean
  headlineFont: string
  headlineLineHeight: number
  headlineLines: PositionedLine[]
  isFirstPage: boolean
  bodyTop: number
}

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
  graphemePrefixOffsets: number[][]
  id: string
  lastPage: number
  pageCursors: LayoutCursor[]
  preparedBody: PreparedTextWithSegments
  preparedDropCap: PreparedTextWithSegments
  segmentGraphemes: string[][]
  segmentStartOffsets: number[]
  title: string
  totalPages: number
}

type SearchMatch = {
  offset: number
  page: number
}

type SearchState = {
  activeIndex: number
  bookId: string
  matches: SearchMatch[]
  query: string
}

const bookModules = import.meta.glob('../books/**/*.txt', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

const collator = new Intl.Collator('ja')
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })

let bodyFontSize = DEFAULT_BODY_FONT_SIZE

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
const topbarElement = document.querySelector('.topbar')
const tocOverlayElement = document.getElementById('toc-overlay')
const tocListElement = document.getElementById('toc-list')
const tocToggleElement = document.getElementById('toc-toggle')
const tocCloseElement = document.getElementById('toc-close')
const tocResumeElement = document.getElementById('toc-resume')
const pageNumElement = document.getElementById('page-num')
const bookMetaElement = document.getElementById('book-meta')
const pageJumpElement = document.getElementById('page-jump')
const pageSeekElement = document.getElementById('page-seek')
const pageJumpLabelElement = document.getElementById('page-jump-label')
const searchToggleElement = document.getElementById('search-toggle')
const searchPanelElement = document.getElementById('search-panel')
const searchInputElement = document.getElementById('search-input')
const searchSubmitElement = document.getElementById('search-submit')
const searchPrevElement = document.getElementById('search-prev')
const searchNextElement = document.getElementById('search-next')
const searchCloseElement = document.getElementById('search-close')
const searchStatusElement = document.getElementById('search-status')

if (
  !stageElement ||
  !topbarElement ||
  !tocOverlayElement ||
  !tocListElement ||
  !tocToggleElement ||
  !tocCloseElement ||
  !tocResumeElement ||
  !pageNumElement ||
  !bookMetaElement ||
  !pageJumpElement ||
  !pageSeekElement ||
  !pageJumpLabelElement ||
  !searchToggleElement ||
  !searchPanelElement ||
  !searchInputElement ||
  !searchSubmitElement ||
  !searchPrevElement ||
  !searchNextElement ||
  !searchCloseElement ||
  !searchStatusElement
) {
  throw new Error('Required DOM nodes were not found.')
}

const stage = stageElement
const topbar = topbarElement
const tocOverlay = tocOverlayElement
const tocList = tocListElement
const tocToggle = tocToggleElement
const tocClose = tocCloseElement
const tocResume = tocResumeElement
const pageNum = pageNumElement
const bookMeta = bookMetaElement
const pageJump = pageJumpElement
const pageSeek = pageSeekElement as HTMLInputElement
const pageJumpLabel = pageJumpLabelElement
const searchToggle = searchToggleElement as HTMLButtonElement
const searchPanel = searchPanelElement
const searchInput = searchInputElement as HTMLInputElement
const searchSubmit = searchSubmitElement as HTMLButtonElement
const searchPrev = searchPrevElement as HTMLButtonElement
const searchNext = searchNextElement as HTMLButtonElement
const searchClose = searchCloseElement as HTMLButtonElement
const searchStatus = searchStatusElement

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
let currentPageLayout: RenderedPage | null = null
let isAnimating = false
let returnPoint: { bookIndex: number; page: number } | null = null
let searchState: SearchState | null = null

let touchStartX = 0
let touchStartY = 0
let isSwipeTracking = false
let isPinching = false
let pinchStartDistance = 0
let pinchStartFontSize = bodyFontSize
let pendingPinchFontSize = bodyFontSize
let pinchAnchor: LayoutCursor | null = null
let chromeHideTimer: number | null = null
let suppressClickUntil = 0

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

function setChromeVisible(visible: boolean): void {
  topbar.classList.toggle('chrome-hidden', !visible)
  pageJump.classList.toggle('chrome-hidden', !visible)
}

function clearChromeHideTimer(): void {
  if (chromeHideTimer !== null) {
    window.clearTimeout(chromeHideTimer)
    chromeHideTimer = null
  }
}

function scheduleChromeHide(): void {
  clearChromeHideTimer()
  chromeHideTimer = window.setTimeout(() => {
    if (tocOverlay.classList.contains('toc-open') || searchPanel.classList.contains('search-open')) {
      scheduleChromeHide()
      return
    }

    setChromeVisible(false)
    chromeHideTimer = null
  }, UI_AUTO_HIDE_MS)
}

function showChromeTemporarily(): void {
  setChromeVisible(true)
  scheduleChromeHide()
}

function hideChromeImmediately(): void {
  clearChromeHideTimer()
  if (tocOverlay.classList.contains('toc-open') || searchPanel.classList.contains('search-open')) {
    return
  }

  setChromeVisible(false)
}

function isChromeVisible(): boolean {
  return !topbar.classList.contains('chrome-hidden')
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
  book: Book,
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  lineHeight: number,
  rectObstacles: RectObstacle[],
): { lines: BodyLine[]; cursor: LayoutCursor } {
  let cursor = cloneCursor(startCursor)
  let lineTop = regionY
  const lines: BodyLine[] = []
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
      const start = cloneCursor(line.start)
      const end = cloneCursor(line.end)
      lines.push({
        x: Math.round(slot.left),
        y: Math.round(lineTop),
        text: line.text,
        width: line.width,
        start,
        startOffset: cursorToTextOffset(book, start),
        end,
        endOffset: cursorToTextOffset(book, end),
      })
      cursor = end
    }
    lineTop += lineHeight
  }

  return { lines, cursor }
}

function isSameCursor(left: LayoutCursor, right: LayoutCursor): boolean {
  return left.segmentIndex === right.segmentIndex && left.graphemeIndex === right.graphemeIndex
}

function compareCursor(left: LayoutCursor, right: LayoutCursor): number {
  if (left.segmentIndex !== right.segmentIndex) {
    return left.segmentIndex - right.segmentIndex
  }
  return left.graphemeIndex - right.graphemeIndex
}

function cloneCursor(cursor: LayoutCursor): LayoutCursor {
  return { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function quantizeFontSize(value: number): number {
  return Math.round(clamp(value, MIN_BODY_FONT_SIZE, MAX_BODY_FONT_SIZE) * 2) / 2
}

function getBodyFont(): string {
  return `${bodyFontSize}px "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "HGS明朝E", serif`
}

function getBodyLineHeight(): number {
  return Math.round(bodyFontSize * BODY_LINE_HEIGHT_RATIO)
}

function getDropCapSize(lineHeight: number): number {
  return lineHeight * DROP_CAP_LINES - 4
}

function getDropCapFont(lineHeight: number): string {
  return `700 ${getDropCapSize(lineHeight)}px ${HEADLINE_FONT_FAMILY}`
}

function getCurrentBook(): Book {
  return books[activeBookIndex]!
}

function composePageLayout(
  startCursor: LayoutCursor,
  pageIndex: number,
  book: Book,
): RenderedPage {
  const pageWidth = document.documentElement.clientWidth
  const pageHeight = document.documentElement.clientHeight
  const isNarrow = pageWidth < NARROW_BREAKPOINT
  const gutter = isNarrow ? NARROW_GUTTER : GUTTER
  const colGap = isNarrow ? NARROW_COL_GAP : COL_GAP
  const bottomGap = isNarrow ? NARROW_BOTTOM_GAP : BOTTOM_GAP
  const bodyFont = getBodyFont()
  const bodyLineHeight = getBodyLineHeight()
  const dropCapSize = getDropCapSize(bodyLineHeight)
  const dropCapFont = getDropCapFont(bodyLineHeight)
  const scale = bodyFontSize / DEFAULT_BODY_FONT_SIZE

  const headlineWidth = Math.min(pageWidth - gutter * 2, 1000)
  const maxHeadlineHeight = Math.floor(pageHeight * (isNarrow ? 0.18 : 0.24))
  const maxHeadlineSize = Math.max(24, Math.round((isNarrow ? 38 : 92) * scale))
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

  const dropCapRect: RectObstacle | null = isFirstPage
    ? {
        x: contentLeft - 2,
        y: bodyTop - 2,
        w: book.dropCapTotalWidth,
        h: DROP_CAP_LINES * bodyLineHeight + 2,
      }
    : null

  const allLines: BodyLine[] = []
  let cursor = cloneCursor(startCursor)
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    const columnX = contentLeft + columnIndex * (columnWidth + colGap)
    const rects: RectObstacle[] = columnIndex === 0 && dropCapRect ? [dropCapRect] : []
    const result = layoutColumnSimple(
      book,
      book.preparedBody,
      cursor,
      columnX,
      bodyTop,
      columnWidth,
      bodyHeight,
      bodyLineHeight,
      rects,
    )
    allLines.push(...result.lines)
    cursor = result.cursor
  }

  return {
    bodyFont,
    bodyLineHeight,
    bodyLines: allLines,
    contentLeft,
    cursor,
    dropCapFont,
    dropCapSize,
    hasBodyContent: allLines.length > 0 && !isSameCursor(cursor, startCursor),
    headlineFont,
    headlineLineHeight,
    headlineLines,
    isFirstPage,
    bodyTop,
  }
}

function paintPageLayout(layer: HTMLElement, page: RenderedPage, book: Book): void {
  const pool = getPool(layer)

  if (page.isFirstPage) {
    if (!pool.dropCap) {
      const dropCap = document.createElement('div')
      dropCap.className = 'drop-cap'
      layer.appendChild(dropCap)
      pool.dropCap = dropCap
    }
    pool.dropCap.textContent = book.dropCapText
    pool.dropCap.style.font = page.dropCapFont
    pool.dropCap.style.lineHeight = `${page.dropCapSize}px`
    pool.dropCap.style.left = `${page.contentLeft - 2}px`
    pool.dropCap.style.top = `${page.bodyTop - 2}px`
    pool.dropCap.style.display = ''
  } else if (pool.dropCap) {
    pool.dropCap.style.display = 'none'
  }

  syncPool(layer, pool.headlines, page.headlineLines.length, () => {
    const el = document.createElement('span')
    el.className = 'headline-line'
    return el
  })
  const pageWidth = document.documentElement.clientWidth
  const isNarrow = pageWidth < NARROW_BREAKPOINT
  const gutter = isNarrow ? NARROW_GUTTER : GUTTER
  for (let i = 0; i < page.headlineLines.length; i++) {
    const el = pool.headlines[i]!
    const line = page.headlineLines[i]!
    el.textContent = line.text
    el.style.left = `${gutter + line.x}px`
    el.style.top = `${gutter + line.y}px`
    el.style.font = page.headlineFont
    el.style.lineHeight = `${page.headlineLineHeight}px`
  }

  syncPool(layer, pool.lines, page.bodyLines.length, () => {
    const el = document.createElement('span')
    el.className = 'line'
    return el
  })
  const activeSearchQuery = searchState?.bookId === book.id ? searchState.query : ''
  const activeSearchOffset = searchState?.bookId === book.id ? searchState.matches[searchState.activeIndex]?.offset ?? -1 : -1
  for (let i = 0; i < page.bodyLines.length; i++) {
    const el = pool.lines[i]!
    const line = page.bodyLines[i]!
    if (activeSearchQuery) {
      el.innerHTML = renderHighlightedLine(book, line, activeSearchQuery, activeSearchOffset)
    } else {
      el.textContent = line.text
    }
    el.style.left = `${line.x}px`
    el.style.top = `${line.y}px`
    el.style.font = page.bodyFont
    el.style.lineHeight = `${page.bodyLineHeight}px`
  }
}

function renderHighlightedLine(book: Book, line: BodyLine, query: string, activeOffset: number): string {
  const lineStart = line.startOffset
  const lineEnd = line.endOffset
  if (!query || lineEnd <= lineStart) {
    return escapeHtml(line.text)
  }

  const queryLength = query.length
  let searchFrom = lineStart
  const ranges: Array<{ active: boolean; end: number; start: number }> = []

  while (searchFrom < lineEnd) {
    const matchStart = book.bodyText.indexOf(query, searchFrom)
    if (matchStart === -1 || matchStart >= lineEnd) {
      break
    }
    const matchEnd = matchStart + queryLength
    ranges.push({
      active: matchStart === activeOffset,
      start: Math.max(matchStart, lineStart),
      end: Math.min(matchEnd, lineEnd),
    })
    searchFrom = matchStart + Math.max(queryLength, 1)
  }

  if (ranges.length === 0) {
    return escapeHtml(line.text)
  }

  let html = ''
  let cursor = 0
  for (const range of ranges) {
    const localStart = clamp(range.start - lineStart, 0, line.text.length)
    const localEnd = clamp(range.end - lineStart, localStart, line.text.length)
    if (localStart > cursor) {
      html += escapeHtml(line.text.slice(cursor, localStart))
    }
    const className = range.active ? 'search-hit search-hit-active' : 'search-hit'
    html += `<mark class="${className}">${escapeHtml(line.text.slice(localStart, localEnd))}</mark>`
    cursor = localEnd
  }
  if (cursor < line.text.length) {
    html += escapeHtml(line.text.slice(cursor))
  }
  return html
}

function renderPageToLayer(
  layer: HTMLElement,
  startCursor: LayoutCursor,
  pageIndex: number,
  book: Book,
): RenderedPage {
  const page = composePageLayout(startCursor, pageIndex, book)
  paintPageLayout(layer, page, book)
  return page
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

function ensureBookPagination(book: Book): void {
  ensureBookInitialized(book)
  if (book.totalPages > 0) {
    return
  }

  let pageIndex = 0
  let cursor = cloneCursor(book.pageCursors[0]!)

  while (true) {
    const page = composePageLayout(cursor, pageIndex, book)
    if (!page.hasBodyContent) {
      book.totalPages = Math.max(pageIndex, 1)
      break
    }
    book.pageCursors[pageIndex + 1] = cloneCursor(page.cursor)
    cursor = cloneCursor(page.cursor)
    pageIndex += 1
  }
}

function invalidateBookPagination(book: Book): void {
  book.pageCursors = []
  book.totalPages = 0
  book.lastPage = 0
}

function invalidateAllPaginations(): void {
  for (const book of books) {
    invalidateBookPagination(book)
  }
}

function refreshBookPreparation(book: Book): void {
  book.preparedBody = prepareWithSegments(book.bodyText, getBodyFont())
  book.segmentGraphemes = book.preparedBody.segments.map(segment => toGraphemes(segment))
  book.graphemePrefixOffsets = book.segmentGraphemes.map(graphemes => buildGraphemePrefixOffsets(graphemes))
  book.segmentStartOffsets = buildSegmentStartOffsets(book.preparedBody.segments)
  book.preparedDropCap = prepareWithSegments(book.dropCapText, getDropCapFont(getBodyLineHeight()))
  let dropCapWidth = 0
  walkLineRanges(book.preparedDropCap, 9999, line => {
    dropCapWidth = line.width
  })
  book.dropCapTotalWidth = Math.ceil(dropCapWidth) + 10
  invalidateBookPagination(book)
}

function refreshAllBooksPreparation(): void {
  cachedHeadlineKey = ''
  for (const book of books) {
    refreshBookPreparation(book)
  }
}

function updatePageCounter(): void {
  const book = getCurrentBook()
  const total = Math.max(book.totalPages, 1)
  const label = `${currentPage + 1} / ${total}`
  pageNum.textContent = label
  pageSeek.max = String(total)
  pageSeek.value = String(currentPage + 1)
  pageSeek.disabled = total <= 1
  pageJumpLabel.textContent = label
  bookMeta.textContent = `${book.title} / ${book.author}`
}

function renderCurrentBook(): void {
  stopSnakeMode()
  frontLayer.style.visibility = ''
  const book = getCurrentBook()
  ensureBookPagination(book)
  currentPage = clamp(currentPage, 0, Math.max(book.totalPages - 1, 0))
  const cursor = book.pageCursors[currentPage] ?? book.pageCursors[0]!
  currentPageLayout = renderPageToLayer(frontLayer, cursor, currentPage, book)
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
  ensureBookPagination(getCurrentBook())
  currentPage = clamp(pageIndex, 0, Math.max(getCurrentBook().totalPages - 1, 0))
  resetSearch(true)
  renderCurrentBook()
}

function goToPage(pageIndex: number): void {
  if (isAnimating || tocOverlay.classList.contains('toc-open')) {
    return
  }

  const book = getCurrentBook()
  ensureBookPagination(book)
  const nextPage = clamp(Math.round(pageIndex), 0, Math.max(book.totalPages - 1, 0))
  if (nextPage === currentPage) {
    updatePageCounter()
    return
  }

  currentPage = nextPage
  renderCurrentBook()
}

function goNextPage(): void {
  if (isAnimating || tocOverlay.classList.contains('toc-open')) {
    return
  }

  if (isSnakeModeActive()) { stopSnakeMode(); frontLayer.style.visibility = '' }

  const book = getCurrentBook()
  ensureBookPagination(book)
  if (currentPage >= book.totalPages - 1) {
    return
  }

  renderPageToLayer(backLayer, book.pageCursors[currentPage + 1]!, currentPage + 1, book)

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
      currentPageLayout = composePageLayout(book.pageCursors[currentPage]!, currentPage, book)
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

  if (isSnakeModeActive()) { stopSnakeMode(); frontLayer.style.visibility = '' }

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
      currentPageLayout = composePageLayout(getCurrentBook().pageCursors[currentPage]!, currentPage, getCurrentBook())
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

  setChromeVisible(true)
  clearChromeHideTimer()
  searchPanel.classList.remove('search-open')
  returnPoint = { bookIndex: activeBookIndex, page: currentPage }
  renderToc()
  tocOverlay.classList.add('toc-open')
}

function closeToc(): void {
  if (!tocOverlay.classList.contains('toc-open')) {
    return
  }

  tocOverlay.classList.remove('toc-open')
  showChromeTemporarily()
}

function resumeFromToc(): void {
  if (!returnPoint) {
    closeToc()
    return
  }

  closeToc()
  switchBook(returnPoint.bookIndex, returnPoint.page)
}

function toGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), item => item.segment)
}

function buildGraphemePrefixOffsets(graphemes: string[]): number[] {
  const offsets = [0]
  let current = 0
  for (const grapheme of graphemes) {
    current += grapheme.length
    offsets.push(current)
  }
  return offsets
}

function buildSegmentStartOffsets(segments: string[]): number[] {
  const offsets = [0]
  let current = 0
  for (const segment of segments) {
    current += segment.length
    offsets.push(current)
  }
  return offsets
}

function cursorToTextOffset(book: Book, cursor: LayoutCursor): number {
  const segmentStart = book.segmentStartOffsets[cursor.segmentIndex] ?? book.bodyText.length
  const graphemeOffsets = book.graphemePrefixOffsets[cursor.segmentIndex]
  if (!graphemeOffsets) {
    return segmentStart
  }
  return segmentStart + (graphemeOffsets[cursor.graphemeIndex] ?? graphemeOffsets[graphemeOffsets.length - 1] ?? 0)
}

function cursorForTextOffset(book: Book, offset: number): LayoutCursor {
  let remaining = clamp(offset, 0, book.bodyText.length)

  for (let segmentIndex = 0; segmentIndex < book.preparedBody.segments.length; segmentIndex++) {
    const segment = book.preparedBody.segments[segmentIndex]!
    if (remaining > segment.length) {
      remaining -= segment.length
      continue
    }
    if (remaining === segment.length) {
      return { segmentIndex: segmentIndex + 1, graphemeIndex: 0 }
    }

    const graphemes = book.segmentGraphemes[segmentIndex] ?? []
    let consumed = 0
    for (let graphemeIndex = 0; graphemeIndex < graphemes.length; graphemeIndex++) {
      if (remaining <= consumed) {
        return { segmentIndex, graphemeIndex }
      }
      consumed += graphemes[graphemeIndex]!.length
      if (remaining < consumed) {
        return { segmentIndex, graphemeIndex }
      }
    }
    return { segmentIndex: segmentIndex + 1, graphemeIndex: 0 }
  }

  return cloneCursor(book.pageCursors[book.pageCursors.length - 1] ?? createInitialCursor(book))
}

function findPageIndexForCursor(book: Book, target: LayoutCursor): number {
  ensureBookPagination(book)
  let lo = 0
  let hi = book.totalPages

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (compareCursor(book.pageCursors[mid]!, target) <= 0) {
      lo = mid
    } else {
      hi = mid
    }
  }

  return clamp(lo, 0, Math.max(book.totalPages - 1, 0))
}

function buildSearchMatches(book: Book, query: string): SearchMatch[] {
  const matches: SearchMatch[] = []
  if (!query) {
    return matches
  }

  ensureBookPagination(book)
  let fromIndex = 0

  while (matches.length < SEARCH_RESULT_LIMIT) {
    const index = book.bodyText.indexOf(query, fromIndex)
    if (index === -1) {
      break
    }

    matches.push({
      offset: index,
      page: findPageIndexForCursor(book, cursorForTextOffset(book, index)),
    })
    fromIndex = index + Math.max(query.length, 1)
  }

  return matches
}

function updateSearchStatus(message = ''): void {
  if (message) {
    searchStatus.textContent = message
  } else if (!searchState || searchState.bookId !== getCurrentBook().id || searchState.query !== searchInput.value.trim()) {
    searchStatus.textContent = searchInput.value.trim() ? 'Enter で検索できます' : ''
  } else if (searchState.matches.length === 0) {
    searchStatus.textContent = '該当箇所はありません'
  } else {
    searchStatus.textContent = `${searchState.activeIndex + 1} / ${searchState.matches.length} 件`
  }

  const hasMatches = !!searchState && searchState.bookId === getCurrentBook().id && searchState.matches.length > 0
  searchPrev.disabled = !hasMatches
  searchNext.disabled = !hasMatches
}

function resetSearch(clearInput = false): void {
  searchState = null
  if (clearInput) {
    searchInput.value = ''
  }
  updateSearchStatus()
}

function openSearch(): void {
  setChromeVisible(true)
  clearChromeHideTimer()
  if (!searchPanel.classList.contains('search-open')) {
    searchPanel.classList.add('search-open')
  }
  searchInput.focus()
  searchInput.select()
  updateSearchStatus()
}

function closeSearch(): void {
  if (!searchPanel.classList.contains('search-open')) {
    return
  }

  searchPanel.classList.remove('search-open')
  showChromeTemporarily()
}

function performSearch(): void {
  const query = searchInput.value.trim()
  if (!query) {
    resetSearch()
    updateSearchStatus('検索語を入力してください')
    return
  }

  const book = getCurrentBook()
  const matches = buildSearchMatches(book, query)
  searchState = {
    activeIndex: 0,
    bookId: book.id,
    matches,
    query,
  }

  if (matches.length === 0) {
    updateSearchStatus('該当箇所はありません')
    return
  }

  applySearchMatch(0)
}

function applySearchMatch(index: number): void {
  if (!searchState || searchState.bookId !== getCurrentBook().id || searchState.matches.length === 0) {
    updateSearchStatus()
    return
  }

  const nextIndex = (index + searchState.matches.length) % searchState.matches.length
  searchState.activeIndex = nextIndex
  goToPage(searchState.matches[nextIndex]!.page)
  updateSearchStatus()
}

function refreshSearchMatches(): void {
  if (!searchState || searchState.bookId !== getCurrentBook().id || !searchState.query) {
    updateSearchStatus()
    return
  }

  const matches = buildSearchMatches(getCurrentBook(), searchState.query)
  searchState = {
    ...searchState,
    matches,
    activeIndex: clamp(searchState.activeIndex, 0, Math.max(matches.length - 1, 0)),
  }
  updateSearchStatus()
}

function captureAnchorCursor(clientY: number): LayoutCursor | null {
  if (!currentPageLayout || currentPageLayout.bodyLines.length === 0) {
    const currentBook = getCurrentBook()
    ensureBookInitialized(currentBook)
    return cloneCursor(currentBook.pageCursors[currentPage] ?? currentBook.pageCursors[0]!)
  }

  let bestLine = currentPageLayout.bodyLines[0]!
  let bestDistance = Math.abs(clientY - (bestLine.y + currentPageLayout.bodyLineHeight / 2))

  for (const line of currentPageLayout.bodyLines) {
    const distance = Math.abs(clientY - (line.y + currentPageLayout.bodyLineHeight / 2))
    if (distance < bestDistance) {
      bestDistance = distance
      bestLine = line
    }
  }

  return cloneCursor(bestLine.start)
}

function applyBodyFontSize(nextSize: number, anchor: LayoutCursor | null): void {
  const normalized = quantizeFontSize(nextSize)
  if (normalized === bodyFontSize) {
    return
  }

  bodyFontSize = normalized
  refreshAllBooksPreparation()
  ensureBookPagination(getCurrentBook())

  if (anchor) {
    currentPage = findPageIndexForCursor(getCurrentBook(), anchor)
  } else {
    currentPage = clamp(currentPage, 0, Math.max(getCurrentBook().totalPages - 1, 0))
  }

  renderCurrentBook()
  refreshSearchMatches()
}

function handleViewportChange(): void {
  if (isAnimating) {
    return
  }

  const anchor = captureAnchorCursor(window.innerHeight * 0.3)
  cachedHeadlineKey = ''
  invalidateAllPaginations()
  ensureBookPagination(getCurrentBook())

  if (anchor) {
    currentPage = findPageIndexForCursor(getCurrentBook(), anchor)
  }

  renderCurrentBook()
  refreshSearchMatches()
}

function isTypingIntoField(): boolean {
  return document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
}

function isStageUiTarget(target: Element): boolean {
  return !!target.closest('.topbar, #page-jump, #search-panel, #toc-overlay')
}

tocToggle.addEventListener('click', () => openToc())
tocClose.addEventListener('click', () => closeToc())
tocResume.addEventListener('click', () => resumeFromToc())
document.getElementById('nav-prev')!.addEventListener('click', () => goPrevPage())
document.getElementById('nav-next')!.addEventListener('click', () => goNextPage())

pageSeek.addEventListener('input', event => {
  const value = Number((event.currentTarget as HTMLInputElement).value)
  goToPage(value - 1)
})

searchToggle.addEventListener('click', () => {
  if (searchPanel.classList.contains('search-open')) {
    closeSearch()
  } else {
    openSearch()
  }
})
searchSubmit.addEventListener('click', () => performSearch())
searchPrev.addEventListener('click', () => applySearchMatch((searchState?.activeIndex ?? 0) - 1))
searchNext.addEventListener('click', () => applySearchMatch((searchState?.activeIndex ?? -1) + 1))
searchClose.addEventListener('click', () => closeSearch())
searchInput.addEventListener('input', () => updateSearchStatus())
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    performSearch()
  }
})

window.addEventListener('click', (event: MouseEvent) => {
  if (Date.now() < suppressClickUntil) {
    return
  }

  const target = event.target as Element

  if (tocOverlay.classList.contains('toc-open')) {
    if (target === tocOverlay) {
      closeToc()
    }
    return
  }

  if (searchPanel.classList.contains('search-open')) {
    if (target.closest('#search-panel, #search-toggle')) {
      return
    }
    closeSearch()
    return
  }

  if (target.closest('#nav-prev, #nav-next, #toc-toggle') || isStageUiTarget(target)) {
    return
  }

  if (!isChromeVisible()) {
    showChromeTemporarily()
    return
  }

  hideChromeImmediately()
})

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (tocOverlay.classList.contains('toc-open')) {
      closeToc()
      return
    }
    if (searchPanel.classList.contains('search-open')) {
      closeSearch()
      return
    }
  }

  if (isTypingIntoField()) {
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

  if (event.key === '/' && !tocOverlay.classList.contains('toc-open')) {
    event.preventDefault()
    openSearch()
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

window.addEventListener(
  'touchstart',
  (event: TouchEvent) => {
    if (tocOverlay.classList.contains('toc-open')) {
      return
    }

    const target = event.target
    if (target instanceof Element && isStageUiTarget(target)) {
      return
    }

    if (event.touches.length === 2) {
      isPinching = true
      isSwipeTracking = false
      pinchStartDistance = getTouchDistance(event.touches[0]!, event.touches[1]!)
      pinchStartFontSize = bodyFontSize
      pendingPinchFontSize = bodyFontSize
      pinchAnchor = captureAnchorCursor((event.touches[0]!.clientY + event.touches[1]!.clientY) / 2)
      return
    }

    if (event.touches.length === 1 && !isPinching) {
      isSwipeTracking = true
      touchStartX = event.touches[0]!.clientX
      touchStartY = event.touches[0]!.clientY
    }
  },
  { passive: true },
)

window.addEventListener(
  'touchmove',
  (event: TouchEvent) => {
    if (!isPinching || event.touches.length !== 2) {
      return
    }

    event.preventDefault()
    const distance = getTouchDistance(event.touches[0]!, event.touches[1]!)
    if (pinchStartDistance <= 0) {
      return
    }
    pendingPinchFontSize = quantizeFontSize(pinchStartFontSize * (distance / pinchStartDistance))
  },
  { passive: false },
)

window.addEventListener(
  'touchend',
  (event: TouchEvent) => {
    suppressClickUntil = Date.now() + 500

    if (isPinching) {
      if (event.touches.length < 2) {
        const nextSize = pendingPinchFontSize
        const anchor = pinchAnchor
        isPinching = false
        pinchStartDistance = 0
        pinchAnchor = null
        applyBodyFontSize(nextSize, anchor)
      }
      return
    }

    if (tocOverlay.classList.contains('toc-open') || searchPanel.classList.contains('search-open') || !isSwipeTracking) {
      return
    }

    const deltaX = event.changedTouches[0]!.clientX - touchStartX
    const deltaY = event.changedTouches[0]!.clientY - touchStartY
    isSwipeTracking = false
    if (Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (deltaX < 0) {
        goNextPage()
      } else {
        goPrevPage()
      }
      return
    }

    if (Math.abs(deltaX) <= TAP_MAX_MOVEMENT && Math.abs(deltaY) <= TAP_MAX_MOVEMENT) {
      const tapX = event.changedTouches[0]!.clientX
      const tapY = event.changedTouches[0]!.clientY
      if (recordTap(tapX, tapY)) {
        if (isSnakeModeActive()) {
          triggerReturn(() => {
            stopSnakeMode()
            frontLayer.style.visibility = ''
          })
        } else {
          startSnakeMode(
            stage,
            currentPageLayout?.bodyLines ?? [],
            currentPageLayout?.bodyFont ?? getBodyFont(),
            currentPageLayout?.bodyLineHeight ?? getBodyLineHeight(),
          )
          frontLayer.style.visibility = 'hidden'
        }
        return
      }
      if (isChromeVisible()) {
        hideChromeImmediately()
      } else {
        showChromeTemporarily()
      }
    }
  },
  { passive: true },
)

window.addEventListener(
  'touchcancel',
  () => {
    isPinching = false
    isSwipeTracking = false
    pinchStartDistance = 0
    pinchAnchor = null
  },
  { passive: true },
)

for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(
    type,
    event => {
      event.preventDefault()
    },
    { passive: false },
  )
}

window.addEventListener('resize', () => {
  handleViewportChange()
})

ensureBookPagination(getCurrentBook())
renderCurrentBook()
updateSearchStatus()
showChromeTemporarily()

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
  const preparedBody = prepareWithSegments(bodyText, getBodyFont())
  const segmentGraphemes = preparedBody.segments.map(segment => toGraphemes(segment))
  const preparedDropCap = prepareWithSegments(dropCapText, getDropCapFont(getBodyLineHeight()))
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
    segmentGraphemes,
    graphemePrefixOffsets: segmentGraphemes.map(graphemes => buildGraphemePrefixOffsets(graphemes)),
    segmentStartOffsets: buildSegmentStartOffsets(preparedBody.segments),
    title,
    totalPages: 0,
  }
}

function cleanLine(line: string): string | null {
  const withoutNotes = line.replace(/［＃.*?］/g, '').trimEnd()
  const withoutRuby = withoutNotes
    .replace(/｜([^《\n]+)《[^》\n]+》/g, '$1')
    .replace(/([一-龠々ぁ-んァ-ヴーゝゞヵヶ]+)《[^》\n]+》/g, '$1')
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

function getTouchDistance(left: Touch, right: Touch): number {
  return Math.hypot(left.clientX - right.clientX, left.clientY - right.clientY)
}
