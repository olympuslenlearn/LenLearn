import { createRequire } from 'node:module'

// pdf-parse is already a project dependency (used by documentParser.js); load it
// the same way so PDF sources (research articles) can be read, not skipped.
const require = createRequire(import.meta.url)
let pdfParse = null
try {
  pdfParse = require('pdf-parse')
} catch {
  pdfParse = null
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; LenLearn-OriginalityChecker/1.0)',
  Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
}

// Tuned upward from the original (5s / 10s / 8 sources / 3000 chars) so a wider
// set of sources can be discovered and read per check.
const PAGE_TIMEOUT_MS = 8000
const OVERALL_TIMEOUT_MS = 20000
const MAX_SOURCES = 15
const RESULTS_PER_QUERY = 6
const MAX_PAGE_TEXT = 5000

/**
 * Real search API (Serper.dev) — primary source discovery when SERPER_API_KEY
 * is configured. Returns far broader coverage of articles and research than the
 * DuckDuckGo HTML fallback below. One simple JSON request per query.
 * @param {string} query
 */
async function searchSerper(query) {
  const apiKey = String(process.env.SERPER_API_KEY || '').trim()
  if (!apiKey) return null // signal "not configured" → caller falls back

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: RESULTS_PER_QUERY }),
    })
    clearTimeout(timer)
    if (!res.ok) return []

    const data = await res.json().catch(() => ({}))
    const organic = Array.isArray(data?.organic) ? data.organic : []
    const results = []
    const seen = new Set()
    for (const item of organic) {
      const link = String(item?.link || '').trim()
      if (!link.startsWith('http') || seen.has(link)) continue
      seen.add(link)
      results.push({ url: link, title: String(item?.title || link).trim() })
      if (results.length >= RESULTS_PER_QUERY) break
    }
    return results
  } catch {
    return []
  }
}

/** DuckDuckGo HTML search — fallback when no SERPER_API_KEY is set (no key required). */
/** @param {string} query */
async function searchDuckDuckGo(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: FETCH_HEADERS,
    })
    clearTimeout(timer)

    if (!res.ok) return []

    const html = await res.text()
    const results = []
    const seen = new Set()

    const uddgRegex = /uddg=([^&"]+)/g
    let match
    while ((match = uddgRegex.exec(html)) !== null && results.length < RESULTS_PER_QUERY) {
      try {
        const decoded = decodeURIComponent(match[1])
        if (!decoded.startsWith('http') || seen.has(decoded)) continue
        seen.add(decoded)
        results.push({ url: decoded, title: decoded })
      } catch {
        /* skip malformed */
      }
    }

    if (results.length) {
      const titleRegex =
        /class="result__a"[^>]*href="[^"]*"[^>]*>([^<]+)<\/a>|class="result__title"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi
      let titleMatch
      let idx = 0
      while ((titleMatch = titleRegex.exec(html)) !== null && idx < results.length) {
        const title = String(titleMatch[1] || titleMatch[2] || '').trim()
        if (title) results[idx].title = title
        idx += 1
      }
    }

    return results
  } catch {
    return []
  }
}

/**
 * Web search: use Serper when configured, otherwise fall back to DuckDuckGo.
 * Keeping the fallback means the checker still works with no API key set.
 * @param {string} query
 */
export async function searchWeb(query) {
  const q = String(query || '').trim()
  if (!q) return []

  const viaSerper = await searchSerper(q)
  if (viaSerper !== null) {
    // Serper configured. If it returned nothing, still try DuckDuckGo as a backup.
    if (viaSerper.length) return viaSerper
    return searchDuckDuckGo(q)
  }
  return searchDuckDuckGo(q)
}

/**
 * Optional: render a JavaScript-heavy page with a headless browser so its text
 * can be read. OFF by default. Activates only when ORIGINALITY_JS_RENDER=1 and
 * the optional `playwright` package is installed (`npm i playwright` then
 * `npx playwright install chromium`). On any failure it returns null and the
 * caller keeps the plain-fetch result.
 * @param {string} url
 */
async function renderWithBrowser(url) {
  if (String(process.env.ORIGINALITY_JS_RENDER || '').trim() !== '1') return null
  let chromium = null
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    return null // package not installed
  }
  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ userAgent: FETCH_HEADERS['User-Agent'] })
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    const text = await page.evaluate(() => document.body?.innerText || '')
    const cleaned = String(text).replace(/\s+/g, ' ').trim()
    return cleaned ? cleaned.slice(0, MAX_PAGE_TEXT) : null
  } catch {
    return null
  } finally {
    try { if (browser) await browser.close() } catch { /* ignore */ }
  }
}

/** @param {string} url */
export async function fetchPageText(url) {
  const target = String(url || '').trim()
  if (!target.startsWith('http')) return null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
    const res = await fetch(target, {
      signal: controller.signal,
      headers: FETCH_HEADERS,
      redirect: 'follow',
    })
    clearTimeout(timer)

    if (!res.ok) return null

    const contentType = String(res.headers.get('content-type') || '').toLowerCase()

    // PDF sources (common for research articles) — extract text with pdf-parse.
    if (contentType.includes('application/pdf') || target.toLowerCase().endsWith('.pdf')) {
      if (!pdfParse) return null
      try {
        const buf = Buffer.from(await res.arrayBuffer())
        const parsed = await pdfParse(buf)
        const text = String(parsed?.text || '').replace(/\s+/g, ' ').trim()
        if (!text) return null
        return text.slice(0, MAX_PAGE_TEXT)
      } catch {
        return null
      }
    }

    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return null
    }

    const html = await res.text()
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    // If the plain fetch yielded little text, the page may render its content
    // with JavaScript. Try the optional headless-browser path (no-op unless
    // enabled + installed); keep whichever result is longer.
    if (text.length < 200) {
      const rendered = await renderWithBrowser(target)
      if (rendered && rendered.length > text.length) text = rendered
    }

    if (!text) return null
    return text.slice(0, MAX_PAGE_TEXT)
  } catch {
    return null
  }
}

/**
 * Build search queries that cover MORE of the document than the original
 * three-longest-sentences approach: the longest sentences plus a few
 * overlapping word-window chunks, so copied passages anywhere in the text
 * have a chance of surfacing their source.
 * @param {string} submittedText
 */
function buildQueries(submittedText) {
  const text = String(submittedText || '')
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30)

  const longest = [...sentences].sort((a, b) => b.length - a.length).slice(0, 5)

  // Overlapping ~22-word windows across the document.
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const windows = []
  const WIN = 22
  const STEP = 15
  for (let i = 0; i + 12 < words.length && windows.length < 4; i += STEP) {
    windows.push(words.slice(i, i + WIN).join(' '))
  }

  const seen = new Set()
  const queries = []
  for (const q of [...longest, ...windows]) {
    const key = q.toLowerCase().slice(0, 80)
    if (q && !seen.has(key)) {
      seen.add(key)
      queries.push(q)
    }
    if (queries.length >= 8) break
  }
  return queries.length ? queries : [text.slice(0, 120)]
}

/** @param {string} submittedText */
export async function getWebSources(submittedText) {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS
  const queries = buildQueries(submittedText)

  const urlMap = new Map()
  for (const query of queries) {
    if (Date.now() >= deadline) break
    const hits = await searchWeb(query)
    for (const hit of hits) {
      if (!hit.url || urlMap.has(hit.url)) continue
      urlMap.set(hit.url, { url: hit.url, title: hit.title || hit.url })
      if (urlMap.size >= MAX_SOURCES) break
    }
    if (urlMap.size >= MAX_SOURCES) break
  }

  const entries = [...urlMap.values()].slice(0, MAX_SOURCES)
  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      if (Date.now() >= deadline) return null
      const text = await fetchPageText(entry.url)
      if (!text || text.length < 50) return null
      return { url: entry.url, title: entry.title, text }
    }),
  )

  return settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean)
}
