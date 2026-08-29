/**
 * Unit tests for the podcast RSS/Atom parser in lib/podcast.js.
 * Pure parsing: no network, no DOM. Feed XML fixtures are inline.
 *
 * The second block drives the real Host routes (/dsh-music-plus/podcasts/*) with a
 * fake ctx + fetch stub, mirroring the boot helper used by index.test.js.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { parseFeed, formatDuration } from '../lib/podcast.js'
import { apply } from '../lib/index.js'

describe('dsh-music-plus parseFeed (RSS 2.0)', () => {
  it('parses feed title/description/image and episode hours from enclosure + itunes:duration', () => {
    const xml = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>My &amp; POD</title><description>desc</description>
<itunes:image href="http://x/i.png"/>
<item><title>EP1</title><enclosure url="http://x/1.mp3" type="audio/mpeg"/><itunes:duration>1:02:03</itunes:duration></item>
<item><title>EP2</title><media:content url="http://x/2.flac"/><itunes:duration>540</itunes:duration></item>
</channel></rss>`
    const f = parseFeed(xml)
    expect(f.title).toBe('My & POD')
    expect(f.description).toBe('desc')
    expect(f.image).toBe('http://x/i.png')
    expect(f.episodes).toHaveLength(2)
    expect(f.episodes[0]).toMatchObject({ title: 'EP1', url: 'http://x/1.mp3', duration: 3723 })
    expect(f.episodes[1]).toMatchObject({ title: 'EP2', url: 'http://x/2.flac', duration: 540 })
  })

  it('preserves CDATA text verbatim (angle brackets are not mistaken for tags)', () => {
    const xml = `<rss><channel><title><![CDATA[程序员聊技术 & <生活>]]></title>
<item><title><![CDATA[x]]></title><enclosure url="http://x/a.mp3"/></item>
</channel></rss>`
    const f = parseFeed(xml)
    expect(f.title).toBe('程序员聊技术 & <生活>')
  })

  it('skips items without a usable audio url', () => {
    const xml = `<rss><channel><title>t</title>
<item><title>ok</title><enclosure url="http://x/a.mp3"/></item>
<item><title>pdf</title><enclosure url="http://x/a.pdf" type="application/pdf"/></item>
</channel></rss>`
    const f = parseFeed(xml)
    expect(f.episodes).toHaveLength(1)
    expect(f.episodes[0].title).toBe('ok')
  })

  it('accepts an enclosure url with a query string', () => {
    const xml = `<rss><channel><title>t</title>
<item><title>ep</title><enclosure url="http://x/a.mp3?token=abc&amp;exp=1"/></item>
</channel></rss>`
    const f = parseFeed(xml)
    expect(f.episodes[0].url).toBe('http://x/a.mp3?token=abc&exp=1')
  })

  it('decodes numeric and named entities in text', () => {
    const xml = `<rss><channel><title>a &amp; b &lt;c&gt;</title>
<item><title>ep</title><enclosure url="http://x/e.m4a"/></item>
</channel></rss>`
    expect(parseFeed(xml).title).toBe('a & b <c>')
  })
})

describe('dsh-music-plus parseFeed (Atom)', () => {
  it('parses an Atom feed with a self-closing enclosure <link>', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom POD</title>
<entry><title>Entry 1</title><link rel="enclosure" href="http://x/e1.m4a" type="audio/mp4"/><published>2024-01-01T00:00:00Z</published></entry>
</feed>`
    const f = parseFeed(xml)
    expect(f.title).toBe('Atom POD')
    expect(f.episodes).toHaveLength(1)
    expect(f.episodes[0].title).toBe('Entry 1')
    expect(f.episodes[0].url).toBe('http://x/e1.m4a')
  })

  it('parses a paired <link> whose opening tag carries the audio href', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title>e</title><link rel="enclosure" href="http://x/e.mp3"></link></entry>
</feed>`
    const f = parseFeed(xml)
    expect(f.episodes).toHaveLength(1)
    expect(f.episodes[0].url).toBe('http://x/e.mp3')
  })
})

describe('dsh-music-plus formatDuration', () => {
  it('formats seconds into MM:SS and HH:MM:SS', () => {
    expect(formatDuration(205)).toBe('3:25')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})

// ---- Host route tests for /dsh-music-plus/podcasts/* ----
function makeReq({ method = 'GET', url = '/', body = '' }) {
  const req = { method, url }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = { status: 200, headers: {}, body: null,
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    end(data) { res.body = data === undefined ? null : data } }
  return res
}
function makeFs(rootDir) {
  const stat = (target) => {
    try { const s = statSync(target); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size } }
    catch { return undefined }
  }
  return {
    async resolve(p) { return isAbsolute(p) ? p : join(rootDir, p) },
    async stat(target) { return stat(target) },
    processPath(target) { return target },
  }
}
function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pod-'))
  const musicDir = join(home, 'Music')
  mkdirSync(musicDir, { recursive: true })
  writeFileSync(join(musicDir, 'a.mp3'), 'AUDIO')
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const registered = []
  const tools = []
  apply({
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    fs: makeFs(home),
    webServer: { register: (row) => { registered.push(row) } },
    tools: { register: (tool) => { tools.push(tool) } },
    systemPrompt: { section: () => {} },
    effect: (fn) => { fn() },
  })
  const handler = (registered.find((r) => r.kind === 'prefix' && r.path === '/dsh-music-plus') || {}).handler
  return {
    handler,
    cleanup() {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
      if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
      try { rmSync(home, { recursive: true, force: true }) } catch {}
    },
  }
}
const FEED = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Tech POD</title><description>desc</description>
<item><title>EP1</title><enclosure url="http://cdn/e1.mp3"/><itunes:duration>100</itunes:duration></item>
</channel></rss>`

describe('dsh-music-plus /podcasts routes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('subscribes an RSS feed, lists it, refreshes it, and removes it', async () => {
    const { handler, cleanup } = boot()
    let served = 0
    vi.stubGlobal('fetch', async () => { served++; return { ok: true, status: 200, text: async () => FEED } })
    try {
      const add = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/add', body: JSON.stringify({ url: 'http://cdn/feed.xml' }) }), add)
      const added = JSON.parse(add.body)
      expect(add.status).toBe(200)
      expect(added.ok).toBe(true)
      expect(added.podcast.title).toBe('Tech POD')
      expect(added.podcast.episodes).toHaveLength(1)
      expect(added.podcast.episodes[0].url).toBe('http://cdn/e1.mp3')
      expect(served).toBe(1)

      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/podcasts' }), list)
      const listed = JSON.parse(list.body)
      expect(listed.ok).toBe(true)
      expect(listed.podcasts).toHaveLength(1)

      const refresh = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/refresh', body: JSON.stringify({ id: added.podcast.id }) }), refresh)
      const ref = JSON.parse(refresh.body)
      expect(ref.ok).toBe(true)
      expect(served).toBe(2)

      const remove = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/remove', body: JSON.stringify({ id: added.podcast.id }) }), remove)
      expect(JSON.parse(remove.body).removed).toBe(1)
    } finally { cleanup() }
  })

  it('rejects a bad feed url and deduplicates an existing subscription', async () => {
    const { handler, cleanup } = boot()
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, text: async () => 'not found' }))
    try {
      const bad = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/add', body: JSON.stringify({ url: 'http://cdn/bad.xml' }) }), bad)
      expect(bad.status).toBe(502)
      const dup = makeRes()
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => FEED }))
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/add', body: JSON.stringify({ url: 'http://cdn/f.xml' }) }), dup)
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/podcasts/add', body: JSON.stringify({ url: 'http://cdn/f.xml' }) }), dup)
      expect(dup.status).toBe(400)
    } finally { cleanup() }
  })
})

