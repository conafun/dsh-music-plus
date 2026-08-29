/**
 * Unit/integration tests for the dsh-music-plus host half (lib/index.js).
 *
 * Strategy: drive the plugin's real `apply()` with a fake `ctx` whose `webServer`
 * captures the registered HTTP handler, and whose `fs` is backed by on-disk files
 * in a temporary directory. This exercises the actual route logic — manifest,
 * set-root, Range/seek streaming, 404, HEAD — against real bytes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  apply, parseBookStructure, splitBookChunks, parseLrc, MAX_TTS_CHARS,
  zipEntries, zipReadEntry, htmlToText, decodeEntities, readEpubBuffer, qqQualityLabel,
  parseAudioMeta, audioQualityLabel,
} from '../lib/index.js'

// ---- tiny fake HTTP req/res (enough for the plugin's routes) ----
function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  // readBody does `for await (const chunk of req)` over body
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}

function makeRes() {
  const calls = []
  const res = {
    status: 200,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = { ...(headers || {}) }
    },
    end(data) { res.body = data === undefined ? null : data },
  }
  calls.push(res)
  return res
}

// ---- mock ctx.fs backed by a real temp directory ----
function makeFs(rootDir) {
  const stat = (target) => {
    if (!existsSync(target)) return undefined
    const s = statSync(target)
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }
  }
  return {
    async resolve(p) { return resolve(p) },
    async stat(target) { return stat(target) },
    processPath(target) { return resolve(target) },
    async listDir(dir) {
      if (!existsSync(dir)) return []
      return readdirSync(dir, { withFileTypes: true }).map((e) => {
        const target = join(dir, e.name)
        const s = statSync(target)
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target,
          size: s.size,
        }
      })
    },
    async readBytes(target, _offset, _size) { return readFileSync(target) },
  }
}

// ---- minimal ZIP writer (stored or deflate) + EPUB fixture builder ----
// Used to construct real EPUB byte buffers on the fly so the host's epub reader
// (and the /book routes against a real .epub file) can be tested end-to-end.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function buildZip(entries, compress = false) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    let data = e.data
    let method = 0
    if (compress) { data = deflateRawSync(data); method = 8 }
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // sig
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(e.data.length, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    chunks.push(local, name, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // sig
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12) // mod time
    cd.writeUInt16LE(0, 14) // mod date
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk number
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, name)
    offset += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const cdOffset = offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // sig
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([Buffer.concat(chunks), cdBuf, eocd])
}

// Build a minimal-but-standard EPUB buffer. `chapters` is an array of XHTML
// body strings (or { body, media } objects). Options: `compress` (deflate the
// zip), `spineLinear` ({ ch0: 'no' } marks an itemref linear="no"),
// `encryptedPaths` (paths listed in META-INF/encryption.xml, e.g. DRM), and
// `nsPrefix` (e.g. 'opf' → <opf:item>/<opf:itemref> namespace-prefixed tags,
// as some real-world EPUB2 files are written).
function buildEpub({ title = '测试之书', author = '测试作者', chapters = [], compress = false, spineLinear = {}, encryptedPaths = [], nsPrefix = '' } = {}) {
  const files = []
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') })
  files.push({
    name: 'META-INF/container.xml',
    data: Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`, 'utf8'),
  })
  const P = nsPrefix === '' ? '' : nsPrefix + ':'
  const items = []
  const spine = []
  chapters.forEach((ch, i) => {
    const c = typeof ch === 'string' ? { body: ch } : ch
    const id = 'ch' + i
    const href = 'ch' + i + '.xhtml'
    const media = c.media || 'application/xhtml+xml'
    items.push(`<${P}item id="${id}" href="${href}" media-type="${media}"/>`)
    const linear = spineLinear[id] === 'no' ? ' linear="no"' : ''
    spine.push(`<${P}itemref idref="${id}"${linear}/>`)
    files.push({ name: 'OEBPS/' + href, data: Buffer.from(c.body, 'utf8') })
  })
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>${items.join('\n    ')}</manifest>
  <spine>${spine.join('\n    ')}</spine>
</package>`
  files.push({ name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') })
  if (encryptedPaths.length > 0) {
    files.push({
      name: 'META-INF/encryption.xml',
      data: Buffer.from(`<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${encryptedPaths.map((p) => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="${p}"/></enc:CipherData></enc:EncryptedData>`).join('\n')}
</encryption>`, 'utf8'),
    })
  }
  return buildZip(files, compress)
}

// A realistic chapter XHTML used by most epub fixtures below.
const epubChapter = (heading, body, extraHead = '') => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title><style>p { color: red }</style></head>
<body>${extraHead}<h1>${heading}</h1><p>${body}</p></body></html>`

// ---- build a ctx + boot a plugin instance against a temp "home" ----
function boot({ files = {}, musicFiles = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-music-test-'))

  // default music root = <home>/Music, mirroring the plugin's default.
  const musicDir = join(home, 'Music')
  mkdirSync(musicDir, { recursive: true })
  for (const [name, content] of Object.entries(musicFiles)) {
    writeFileSync(join(musicDir, name), content)
  }
  // any extra paths from `files` (relative to home)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }

  // env-controlled state file location; saved before apply() reads HOME via shell.
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  // Seed the plugin's persisted music-root state to point at the temp Music
  // dir. lib's getHome() prefers os.homedir() (the real user home), so without
  // this the default root would be the host's real $HOME/Music — leaking real
  // tracks into the scan and breaking the hermetic count/stream/quality/music_play_plus
  // assertions. init() honours a stored root, so this keeps tests machine-agnostic.
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  writeFileSync(join(process.env.DSH_HOME, 'dsh-music-plus-state.json'), JSON.stringify({ root: musicDir }) + '\n', 'utf8')

  const fs = makeFs(home)
  const registered = []
  const tools = []
  const loader = {
    name: 'test-loader',
    ctx: {
      shell: {
        resolve: (o) => o,
        run: async () => ({ stdout: { text: home } }),
      },
      fs,
      webServer: {
        register: (row) => { registered.push(row) },
      },
      tools: {
        register: (tool) => { tools.push(tool) },
      },
      systemPrompt: {
        section: () => {},
      },
      effect: (fn) => { fn() },
    },
  }

  apply(loader.ctx)

  const routes = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music-plus')
  const handler = routes.length > 0 ? routes[0].handler : null

  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }

  return { home, musicDir, handler, tools, cleanup }
}

afterEach(() => { /* cleanup handled per-boot to avoid cross-test state */ })

describe('dsh-music-plus host routes', () => {
  it('reports the scanned library via /dsh-music-plus/manifest', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'a.mp3': 'AUDIO-A', 'b.flac': 'AUDIO-B' },
    })
    try {
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.count).toBe(2)
      expect(data.root).toBe(musicDir)
      const names = data.tracks.map((t) => t.name).sort()
      expect(names).toEqual(['a.mp3', 'b.flac'])
    } finally { cleanup() }
  })

  it('persists playback prefs to the Host via /dsh-music-plus/prefs', async () => {
    const { home, handler, cleanup } = boot()
    try {
      // fresh boot -> empty snapshot
      const res0 = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/prefs' }), res0)
      expect(JSON.parse(res0.body)).toEqual({ ok: true, prefs: {} })

      // POST merges known string values
      const res1 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/prefs', body: JSON.stringify({ prefs: { 'dsh-music-volume': '0.65', 'dsh-music-mode': 'shuffle' } }) }),
        res1,
      )
      const d1 = JSON.parse(res1.body)
      expect(d1.ok).toBe(true)
      expect(d1.prefs['dsh-music-volume']).toBe('0.65')
      expect(d1.prefs['dsh-music-mode']).toBe('shuffle')

      // the state is written to disk under DSH_HOME (survives restarts)
      const prefsFile = join(home, '.dsh', 'dsh-music-plus-prefs.json')
      expect(existsSync(prefsFile)).toBe(true)
      const onDisk = JSON.parse(readFileSync(prefsFile, 'utf8'))
      expect(onDisk.prefs['dsh-music-mode']).toBe('shuffle')

      // GET reflects the persisted snapshot
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/prefs' }), res2)
      const d2 = JSON.parse(res2.body)
      expect(d2.prefs['dsh-music-volume']).toBe('0.65')

      // remove clears a key without touching the others
      const res3 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/prefs', body: JSON.stringify({ remove: ['dsh-music-mode'] }) }),
        res3,
      )
      const d3 = JSON.parse(res3.body)
      expect('dsh-music-mode' in d3.prefs).toBe(false)
      expect(d3.prefs['dsh-music-volume']).toBe('0.65')
    } finally { cleanup() }
  })

  it('sanitizes prefs: drops unknown keys, invalid volume/mode and oversize values', async () => {
    const { handler, cleanup } = boot()
    try {
      const big = 'x'.repeat(300 * 1024)
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/prefs', body: JSON.stringify({ prefs: { 'evil-key': '1', 'dsh-music-volume': '1.5', 'dsh-music-mode': 'bogus', 'dsh-music-playback': big } }) }),
        res,
      )
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect('evil-key' in d.prefs).toBe(false)        // not in the allowlist
      expect(d.prefs['dsh-music-volume']).toBe('1')     // clamped to 0..1
      expect('dsh-music-mode' in d.prefs).toBe(false)   // invalid mode dropped
      expect('dsh-music-playback' in d.prefs).toBe(false) // oversize dropped
    } finally { cleanup() }
  })




  it('accepts the viz-mode pref through the allowlist, drops invalid values (persistence regression)', async () => {
    // 回归：新配置键若漏出 Host 白名单，POST 会被 sanitizePrefs 静默丢弃，
    // 表现为「频谱样式设置刷新后重置回柱状图」。viz-mode 必须能存、能 GET 回读。
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-viz-mode': 'wave',
        } }) }),
        res,
      )
      let d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.prefs['dsh-music-viz-mode']).toBe('wave')
      // GET 回读：快照里确实持久化了 wave
      const g = makeRes()
      await handler(makeReq({ method: 'GET', url: '/dsh-music-plus/prefs' }), g)
      const gd = JSON.parse(g.body)
      expect(gd.prefs['dsh-music-viz-mode']).toBe('wave')
      // 非法枚举值丢弃
      const res2 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-viz-mode': 'bogus',
        } }) }),
        res2,
      )
      d = JSON.parse(res2.body)
      // bogus 被丢弃：快照里仍是第一次存的 wave，绝不是 bogus
      expect(d.prefs['dsh-music-viz-mode']).toBe('wave')
    } finally { cleanup() }
  })




  it('excludes non-audio files from the manifest', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'a.mp3': 'A', 'notes.txt': 'not audio', 'cover.jpg': 'img' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      expect(JSON.parse(res.body).count).toBe(1)
    } finally { cleanup() }
  })

  it('streams a track with 200 and the correct content-type and bytes', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'X'.repeat(100) } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(res.headers['Content-Length']).toBe('100')
      expect(Buffer.from(res.body).length).toBe(100)
    } finally { cleanup() }
  })

  it('honours a Range request with a 206 partial response', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } }) // 10 bytes
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music-plus/0', headers: { range: 'bytes=2-5' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
      expect(res.headers['Content-Length']).toBe('4')
    } finally { cleanup() }
  })

  it('honours a suffix Range request (bytes=-N)', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music-plus/0', headers: { range: 'bytes=-3' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(Buffer.from(res.body).toString()).toBe('HIJ')
    } finally { cleanup() }
  })

  it('rejects an unsatisfiable range with 416', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABC' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music-plus/0', headers: { range: 'bytes=10-20' } }),
        res,
      )
      expect(res.status).toBe(416)
      expect(res.headers['Content-Range']).toBe('bytes */3')
    } finally { cleanup() }
  })

  it('returns 404 for an unknown track id', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/999' }), res)
      expect(res.status).toBe(404)
    } finally { cleanup() }
  })

  it('supports HEAD requests with no body', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'HEADBODY' } })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'HEAD', url: '/dsh-music-plus/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Length']).toBe('8')
    } finally { cleanup() }
  })

  it('switches the library root via /dsh-music-plus/set-root', async () => {
    const { handler, home, cleanup } = boot({ musicFiles: { 'a.mp3': 'AAA' } })
    try {
      // add a second music directory under the temp home
      const other = join(home, 'OtherMusic')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'x.wav'), 'WAVDATA')

      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/set-root', body: JSON.stringify({ path: other }) }),
        res,
      )
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(1)
      expect(data.tracks[0].name).toBe('x.wav')
    } finally { cleanup() }
  })

  it('rejects a set-root to a non-directory path with 400', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'not-a-dir.txt': 'hi' },
    })
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music-plus/set-root', body: JSON.stringify({ path: join(home, 'not-a-dir.txt') }) }),
        res,
      )
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('re-scans the current directory via /dsh-music-plus/rescan (manual refresh)', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'a.mp3': 'AAA' } })
    try {
      // 初始扫描 1 首
      const res0 = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res0)
      expect(JSON.parse(res0.body).count).toBe(1)

      // 新增文件后，manifest 仍返回旧的内存扫描结果（不动态刷新）
      writeFileSync(join(musicDir, 'new.mp3'), 'NEWBYTES')
      const res1 = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res1)
      expect(JSON.parse(res1.body).count).toBe(1)

      // 手动 rescan 后能看到新文件
      const res2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music-plus/rescan' }), res2)
      const data = JSON.parse(res2.body)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(2)
      expect(data.tracks.map((t) => t.name).sort()).toEqual(['a.mp3', 'new.mp3'])
    } finally { cleanup() }
  })
})

describe('dsh-music-plus /dir route', () => {
  it('lists subdirectories with parent/up info and files after them', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        'Music/sub-a/song.mp3': 'A',
        'Music/sub-b/song.mp3': 'B',
        'Music/notes.txt': 'not a dir',
        'Music/cover.jpg': 'img',
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/dir?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.name).toBe('Music')
      expect(data.up).toBe(home)
      // directories come first
      const dirNames = data.dirs.map((d) => d.name)
      expect(dirNames).toEqual(['sub-a', 'sub-b'])
      // plain files are listed as context (not only audio)
      const fileNames = data.files.map((f) => f.name)
      expect(fileNames).toEqual(['cover.jpg', 'notes.txt'])
    } finally { cleanup() }
  })

  it('reports no parent (up) at the filesystem root', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const root = resolve('/')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/dir?path=' + encodeURIComponent(root) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      // A filesystem root has no parent directory: on POSIX it is null; on
      // Windows the drive root's parent is the __drives__ sentinel.
      expect([null, '__drives__']).toContain(data.up)
    } finally { cleanup() }
  })

  it('returns breadcrumb crumbs that walk the full absolute path', async () => {
    const { handler, home, cleanup } = boot({ files: { 'Music/sub-a/song.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/dir?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(Array.isArray(data.crumbs)).toBe(true)
      expect(data.crumbs.length).toBeGreaterThanOrEqual(2)
      // The deepest crumb is the current directory itself.
      const last = data.crumbs[data.crumbs.length - 1]
      expect(last.name).toBe('Music')
      expect(last.path).toBe(data.path)
      // The home directory appears as an ancestor crumb that accumulates to `home`.
      const homeCrumb = data.crumbs.find((c) => c.path === home)
      expect(homeCrumb).toBeTruthy()
      expect(homeCrumb.name).toBe(home.replace(/[\\/]+$/, '').split(/[\\/]/).pop())
      // Crumbs accumulate from the root: each path is a strict prefix of the next.
      for (let i = 1; i < data.crumbs.length; i += 1) {
        expect(data.crumbs[i].path.startsWith(data.crumbs[i - 1].path)).toBe(true)
      }
    } finally { cleanup() }
  })

  it('returns a valid crumb walk for the __drives__ sentinel', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/dir?path=__drives__' }), res)
      const data = JSON.parse(res.body)
      // On non-Windows the sentinel resolves to the POSIX root ("/").
      expect(Array.isArray(data.crumbs)).toBe(true)
      expect(data.crumbs.length).toBeGreaterThanOrEqual(0)
      if (data.crumbs.length > 0) {
        expect(data.crumbs[data.crumbs.length - 1].path).toBe(data.path)
      }
    } finally { cleanup() }
  })

  it('handles the __drives__ sentinel on this (non-Windows) host', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/dir?path=__drives__' }), res)
      const data = JSON.parse(res.body)
      // On non-Windows the sentinel resolves to the POSIX root with no dirs.
      expect([null, '/']).toContain(data.up)
    } finally { cleanup() }
  })
})

describe('dsh-music-plus music_play_plus tool', () => {
  it('registers a music_play_plus tool with the expected name', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      expect(tool).toBeTruthy()
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      // the tool declares a query parameter
      expect(tool.parameters.properties.query.type).toBe('string')
    } finally { cleanup() }
  })

  it('returns a notice when the library is empty', async () => {
    const { tools, cleanup } = boot({ musicFiles: {} })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({})
      expect(out.played).toBe(false)
      expect(typeof out.notice).toBe('string')
      expect(out.notice.length).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  it('sets a play intent with the picked track id on a query play', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A', 'other.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({ query: 'song' })
      expect(out.played).toBe(true)
      expect(out.action).toBe('play')
      expect(out.track).toBe('song.mp3')
      expect(out.matches).toBe(1)
      expect(out.count).toBe(2)
      // the intent it queued for the browser carries the play action + id/name
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(typeof intent.id).toBe('string')
      expect(intent.name).toBe('song.mp3')
    } finally { cleanup() }
  })

  it('prefers an exact filename match over a substring match', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A', 'ab.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({ query: 'a' })   // matches both a.mp3 and ab.mp3
      expect(out.played).toBe(true)
      expect(out.matches).toBe(2)
      expect(out.track).toBe('a.mp3')                   // exact filename match wins
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/intent' }), res)
      expect(JSON.parse(res.body).name).toBe('a.mp3')
    } finally { cleanup() }
  })

  it('queues a pause intent for the browser player', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({ action: 'pause' })
      expect(out.action).toBe('pause')
      expect(out.played).toBe(false)
      expect(out.count).toBe(1)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/intent' }), res)
      // transport actions carry no id
      expect(JSON.parse(res.body)).toEqual({ action: 'pause' })
    } finally { cleanup() }
  })

  it('queues next/prev/stop/resume intents', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      for (const action of ['next', 'prev', 'stop', 'resume']) {
        const out = await tool.execute({ action })
        expect(out.action).toBe(action)
        const res = makeRes()
        await handler(makeReq({ url: '/dsh-music-plus/intent' }), res)
        expect(JSON.parse(res.body)).toEqual({ action })
      }
    } finally { cleanup() }
  })



})

describe('dsh-music-plus parseBookStructure', () => {
  it('splits a novel into 简介 / chapters / 尾声 and derives title+author', () => {
    const text = [
      '中国制造 作者：周梅森',
      '',
      '简介',
      '这是一段简介内容，概述全书。',
      '',
      '第一章　闪电划过星空',
      '这是第一章的正文，情节展开。',
      '',
      '第二章　最长的一天',
      '这是第二章的正文，剧情继续。',
      '',
      '尾声',
      '这就是尾声了。',
    ].join('\n')
    const st = parseBookStructure(text, '中国制造 作者：周梅森.txt')
    expect(st.title).toBe('中国制造')
    expect(st.author).toBe('周梅森')
    const types = st.sections.map((s) => s.type)
    expect(types).toEqual(['preface', 'chapter', 'chapter', 'epilogue'])
    expect(st.sections[1].heading).toContain('第一章')
  })

  it('recognizes standalone short-line (named) section headings like 麻将牌', () => {
    const text = [
      '县级夫人 作者：杨晓升',
      '',
      '麻将牌',
      '男人当道，女人当家。这是正文第一段，文字很长很长很长很长很长。' + '正文。'.repeat(220),
      '',
      '青远县',
      '这也是一个分节的正文段落，内容同样足够长，足以视为正文。' + '正文。'.repeat(220),
      '',
      '尾声',
      '结束了。',
    ].join('\n')
    const st = parseBookStructure(text, '县级夫人 作者：杨晓升.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['named', 'named', 'epilogue'])
    expect(st.sections[0].heading).toBe('麻将牌')
    expect(st.sections[1].heading).toBe('青远县')
  })

  it('rejects a run of short lyric lines as headings', () => {
    const text = [
      '第一章',
      '这是第一章的正文第一行。',
      '',
      '能不能让我陪着你走',
      '既然你说留不住你',
      '回去的路有些黑暗',
      '担心让你一个人走',
      '',
      '第二章',
      '这是第二章的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    const chapters = st.sections.filter((s) => s.type === 'chapter')
    expect(chapters.length).toBe(2)
    // none of the lyric lines became a section
    for (const s of st.sections) {
      expect(['能不能', '既然', '回去', '担心']).not.toContain(s.heading.slice(0, 2))
    }
  })

  it('suppresses a duplicated 目录 TOC block', () => {
    const text = [
      '目录',
      '第一章　标题一',
      '第二章　标题二',
      '第三章　标题三',
      '',
      '第一章　标题一',
      '这是第一章正文。很长很长。',
      '',
      '第二章　标题二',
      '这是第二章正文。很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters; the toc block must not produce sections
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('suppresses TOC rows that carry trailing page-number refs (…/12)', () => {
    const text = [
      '第一章 标题一',
      '1. 小节一——一句话介绍。/1',
      '2. 小节二——一句话介绍。/4',
      '',
      '第一章 标题一',
      '这是第一章正文，内容很长很长很长很长很长很长很长很长很长。',
      '',
      '第二章 标题二',
      '1. 小节甲——一句话介绍。/9',
      '2. 小节乙——一句话介绍。/12',
      '',
      '第二章 标题二',
      '这是第二章正文，内容同样很长很长很长很长很长很长很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters survive; the /N-page-ref rows are suppressed
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('strips WPS typesetting codes before classification', () => {
    const text = '第一章\n正文内容很长。\n\n〖BT3〗第二章\n第二段正文。\n'
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
    expect(st.sections[1].heading).toBe('第二章')
  })

  it('folds a tiny named section back into the previous section (noise gate)', () => {
    const text = [
      '第一章',
      '这是第一章正文，很长很长的一段文字内容，足够长了。',
      '',
      '小节',
      '这是一段超过二十个字的短正文内容。它只有这一段。',
      '',
      '第二章',
      '这是第二章正文内容。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('accepts a strong heading with no blank line above it', () => {
    const text = [
      '第一部 禁地',
      '这是第一部的正文。',
      '第二部 荒 村',
      '这是第二部的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['part', 'part'])
    expect(st.sections[1].heading).toBe('第二部 荒 村')
  })

  it('reports a valid textStart (offset in the normalized text) per section', () => {
    const text = [
      '第一章 标题甲',
      '这是第一章正文，句子足够长。',
      '',
      '第二章 标题乙',
      '这是第二章正文，句子足够长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.length).toBe(2)
    const norm = text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    for (const s of st.sections) {
      expect(typeof s.textStart).toBe('number')
      expect(s.textStart).toBeGreaterThanOrEqual(0)
      expect(s.textStart).toBeLessThan(norm.length)
      // the offset points at the heading text in the normalized source
      expect(norm.slice(s.textStart, s.textStart + s.heading.length)).toContain(
        s.heading.replace(/\s+/g, '').slice(0, 2),
      )
    }
    // section offsets are increasing
    expect(st.sections[1].textStart).toBeGreaterThan(st.sections[0].textStart)
  })
})

describe('dsh-music-plus splitBookChunks (heading gets its own chunk)', () => {
  const norm = (t) => t.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '')
  const breaksOf = (st) => st.sections
    .filter((s) => Number.isFinite(s.textStart) && s.textStart >= 0)
    .map((s) => ({ start: s.textStart, text: s.heading }))

  it('puts each clean chapter heading in its own chunk, body in the next', () => {
    const text = [
      '第一章　闪电划过星空',
      '这是第一章的正文，情节开始展开。故事继续推进。',
      '',
      '第二章　最长的一天',
      '这是第二章的正文，剧情继续发展。',
    ].join('\n')
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    // two chapters -> heading chunks + body chunks
    expect(fromChunkOfBreak).toEqual([0, 2])
    expect(chunks[0]).toContain('第一章')
    expect(chunks[0]).not.toContain('这是第一章的正文')
    expect(chunks[1]).toContain('这是第一章的正文')
    expect(chunks[2]).toContain('第二章')
    expect(chunks[2]).not.toContain('这是第二章的正文')
    expect(chunks[3]).toContain('这是第二章的正文')
    // section opener = the heading chunk, monotonic
    expect(fromChunkOfBreak[1]).toBeGreaterThan(fromChunkOfBreak[0])
  })

  it('does not merge the heading text into the following body chunk', () => {
    const text = '第一章　起\n这是第一章正文，句子足够长，用来确认标题不粘进正文。'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(fromChunkOfBreak[0]).toBe(0)
    expect(chunks[0]).toContain('第一章')
    // body chunk starts with the actual prose, not the heading
    expect(chunks[1]).toMatch(/^这是第一章正文/)
  })

  it('falls back to the old merge for an inline/polluted long heading (no crash, no giant heading chunk)', () => {
    // heading + body on the same line: parseBookStructure already merged the
    // whole line into `heading`, so it is longer than MAX_HEADING_CHARS and the
    // chunker must keep the old merge behaviour instead of isolating a bogus
    // "heading" that is actually most of a paragraph.
    const text = '第一章 闪电划过星空 这是第一章的正文，情节开始展开，故事继续推进。\n\n第二章 最长的一天 这是第二章的正文，剧情继续发展。\n'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(chunks.length).toBeGreaterThan(0)
    // both breaks still open chunks (monotonic) and every chunk is bounded by
    // MAX_TTS_CHARS + a heading line, never the whole remaining text
    expect(fromChunkOfBreak.length).toBe(2)
    expect(fromChunkOfBreak[1]).toBeGreaterThan(fromChunkOfBreak[0])
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  it('falls back gracefully when the heading cannot be matched in the source (e.g. WPS codes)', () => {
    const text = '〖BT3〗第二章\n这是第二章的正文，内容很长。'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(chunks.length).toBeGreaterThan(0)
    // the break still opens a chunk (fallback records it) and nothing crashes
    expect(fromChunkOfBreak[0]).toBe(0)
    expect(chunks.join('')).toContain('这是第二章的正文')
  })

  it('handles an empty / no-section book without crashing', () => {
    const n = norm('这是一本没有章节标题的书。只有正文。')
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('没有章节标题')
  })

  it('keeps a quoted dialogue intact even when it contains 。？ inside', () => {
    // A 。！？…； inside “...” must NOT cut the sentence: the whole dialogue stays in
    // one chunk (and reads as a single utterance), so it is never split mid-quote.
    const n = norm('他说：“你来了吗？我等你很久了。”她点点头。')
    const { chunks } = splitBookChunks(n, [])
    // content preserved & exactly one chunk (short sentence + both quotes)
    expect(chunks.join('')).toBe(n)
    expect(chunks.length).toBe(1)
    // the ? inside the quote did not open a chunk boundary inside the quote
    const holder = chunks[0]
    expect(holder).toContain('你来了吗？我等你很久了。”')
    expect(holder.includes('“你来了吗')).toBe(true)
  })

  it('never produces a chunk longer than MAX_TTS_CHARS', () => {
    // a long run of normal sentences well over the cap
    const n = norm(('这是第一句话，里面有一个逗号分句。'.repeat(40)))
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  it('splits an over-long sentence at a clause pause (adaptive), not a raw hard cut', () => {
    // one giant sentence (no 。 inside) longer than the cap, dense with commas
    const clauses = Array.from({ length: 40 }, (_, i) => '这是第' + (i + 1) + '个分句：').join('')
    const n = norm(clauses + '至此完毕。')
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBeGreaterThan(1)
    // content preserved (nothing truncated)
    expect(chunks.join('')).toBe(n)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    // every chunk boundary lands on a clause pause, never mid-word
    for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i].endsWith('：')).toBe(true)
  })

  it('does not cut inside a quoted dialogue even when a chunk boundary is forced', () => {
    // Place a small dialogue in the middle of a comma-laden run that overflows
    // the cap. The adaptive splitter must keep “...” together — the boundary ends
    // up outside the quotes, never inside them.
    const filler = '一二三四五六七八九十，'
    const dialogue = '“他说完就走了。”'
    const n = norm(filler.repeat(9) + dialogue + filler.repeat(9))
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.join('')).toBe(n)
    // the chunk holding the opening quote carries the whole dialogue intact
    const holder = chunks.find((c) => c.includes('“'))
    expect(holder).toBeTruthy()
    expect(holder).toContain('他说完就走了。”')
    // each chunk stays within the cap
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })
})

describe('dsh-music-plus parseLrc', () => {
  it('parses [mm:ss] timestamps with text into sorted lines', () => {
    const lrc = parseLrc('[00:12.00]第一句\n[00:30.5]第二句\n[01:02]第三句\n')
    expect(lrc).toEqual([
      { t: 12, text: '第一句' },
      { t: 30.5, text: '第二句' },
      { t: 62, text: '第三句' },
    ])
  })
  it('duplicates a line across multiple timestamps and re-sorts unsorted input', () => {
    const lrc = parseLrc('[00:20.00][00:10.00]重复句\n')
    expect(lrc).toEqual([
      { t: 10, text: '重复句' },
      { t: 20, text: '重复句' },
    ])
  })
  it('applies [offset:±ms] to all timestamps and skips metadata tags', () => {
    const lrc = parseLrc('[ti:标题]\n[ar:歌手]\n[offset:-500]\n[00:10.00]歌词\n')
    expect(lrc).toEqual([{ t: 9.5, text: '歌词' }])
  })
  it('strips html-ish tags and drops empty/untimed lines', () => {
    const lrc = parseLrc('[00:01.00]<i>斜体</i>歌词\n\n没有时间戳的一行\n[00:02.00]\n')
    expect(lrc).toEqual([
      { t: 1, text: '斜体歌词' },
    ])
  })
  it('handles three-digit millisecond fractions and empty input', () => {
    expect(parseLrc('[00:00.500]半秒\n')).toEqual([{ t: 0.5, text: '半秒' }])
    expect(parseLrc('')).toEqual([])
  })
})





describe('dsh-music-plus EPUB reader', () => {
  it('flattens a stored-zip epub to plain text in spine order with OPF metadata', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 开始', '这是第一章的正文，包含 <b>加粗</b> 与 &amp; 实体，还有 &#20108; 字。'),
        epubChapter('第二章 发展', '这是第二章的正文。'),
      ],
    })
    const r = readEpubBuffer(epub)
    expect(r.title).toBe('测试之书')
    expect(r.author).toBe('测试作者')
    // spine order preserved, headings on their own lines (h1 → newline)
    expect(r.text.indexOf('第一章 开始')).toBeLessThan(r.text.indexOf('第二章 发展'))
    expect(r.text).toContain('这是第一章的正文，包含 加粗 与 & 实体，还有 二 字。')
    expect(r.text).toContain('这是第二章的正文。')
  })

  it('reads a deflate-compressed (method 8) epub', () => {
    const epub = buildEpub({
      compress: true,
      chapters: [epubChapter('第一章 压缩', '这段来自被 deflate 压缩的章节。')],
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 压缩')
    expect(r.text).toContain('这段来自被 deflate 压缩的章节。')
  })

  it('reads an EPUB2 whose OPF uses namespace-prefixed tags (<opf:item>/<opf:itemref>)', () => {
    // Regression: real-world EPUB2 files (e.g. so-novel exports) prefix the OPF
    // tags with the package namespace; tag matching must be prefix-agnostic.
    const epub = buildEpub({
      nsPrefix: 'opf',
      chapters: [epubChapter('第一章 前缀', '命名空间前缀的章节也能读到。')],
    })
    const r = readEpubBuffer(epub)
    expect(r.title).toBe('测试之书')
    expect(r.text).toContain('第一章 前缀')
    expect(r.text).toContain('命名空间前缀的章节也能读到。')
  })

  it('drops nav/head/style and decodes numeric + named entities', () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>不该出现</title></head><body>
<nav epub:type="toc"><ol><li><a href="ch0.xhtml">目录入口</a></li></ol></nav>
<p>正文段落，包含 &nbsp;空格&nbsp; 与 &#x4E8C;&#20108; 字。</p></body></html>`
    const epub = buildEpub({ chapters: [body] })
    const r = readEpubBuffer(epub)
    expect(r.text).not.toContain('目录入口')
    expect(r.text).not.toContain('不该出现')
    expect(r.text).toContain('正文段落，包含 空格 与 二二 字。')
  })

  it('skips linear="no" spine items (endnotes/footnotes) for read-aloud', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 正文', '主体内容。'),
        epubChapter('注释', '这是尾注，不应被朗读。'),
      ],
      spineLinear: { ch1: 'no' },
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 正文')
    expect(r.text).not.toContain('尾注')
  })

  it('skips encrypted/DRM spine items instead of reading mojibake', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 可读', '这段是明文。'),
        epubChapter('第二章 加密', '这段被 DRM 加密，无法解密。'),
      ],
      encryptedPaths: ['OEBPS/ch1.xhtml'],
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 可读')
    expect(r.text).not.toContain('第二章 加密')
  })

  it('throws a clear Chinese error for bytes that are not a zip', () => {
    expect(() => readEpubBuffer(Buffer.from('this is definitely not an epub', 'utf8'))).toThrow(/EPUB/)
  })

  it('zipReadEntry returns stored and deflate bytes, and raises on missing entries', () => {
    const data = buildZip([
      { name: 'a.txt', data: Buffer.from('hello stored', 'utf8') },
      { name: 'b.txt', data: Buffer.from('hello deflate', 'utf8') },
    ], true)
    const entries = zipEntries(data)
    expect(entries.length).toBe(2)
    expect(zipReadEntry(data, entries, 'a.txt').toString()).toBe('hello stored')
    expect(zipReadEntry(data, entries, 'b.txt').toString()).toBe('hello deflate')
    expect(() => zipReadEntry(data, entries, 'missing.txt')).toThrow(/缺少条目/)
  })

  it('htmlToText converts blocks to lines and strips non-prose elements', () => {
    const html = '<html><head><title>t</title><script>var x=1;</script></head><body>'
      + '<h1>标题</h1><p>第一段 <span>内联</span></p><p>第二段</p>'
      + '<svg><text>矢量字</text></svg><br/>换行后'
      + '</body></html>'
    const text = htmlToText(html)
    expect(text).toContain('标题')
    expect(text).not.toContain('var x')
    expect(text).not.toContain('矢量字')
    expect(text).toContain('第一段 内联')
    expect(text).toContain('第二段')
    expect(text).toContain('换行后')
  })

  it('decodeEntities handles numeric and named entities', () => {
    expect(decodeEntities('a&amp;b&#x4E8C;&#20108;&ldquo;x&rdquo;')).toBe('a&b二二“x”')
    expect(decodeEntities('&#x1F600;')).toBe('\u{1F600}')
  })
})

describe('dsh-music-plus QQ quality label (qqQualityLabel)', () => {
  it('maps取链 filename 前缀/扩展名到通俗音质标签', () => {
    // 四档 FLAC（AI00/Q001/Q000/F000）→ 无损
    expect(qqQualityLabel('AI00abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('Q001abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('Q000abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('F000abcdefabcdef.flac')).toBe('无损')
    // OGG（O801）与 320k MP3（M800）→ 高音质
    expect(qqQualityLabel('O801abcdefabcdef.ogg')).toBe('高音质')
    expect(qqQualityLabel('M800abcdefabcdef.mp3')).toBe('高音质')
    // 128k MP3（M500）→ 标准
    expect(qqQualityLabel('M500abcdefabcdef.mp3')).toBe('标准')
  })

  it('returns an empty label for unknown / empty filenames', () => {
    expect(qqQualityLabel('')).toBe('')
    expect(qqQualityLabel(null)).toBe('')
    expect(qqQualityLabel(undefined)).toBe('')
    expect(qqQualityLabel('XYZabcdefabcdef.weird')).toBe('')
  })
})

describe('dsh-music-plus local audio quality (parseAudioMeta)', () => {
  // ---- 各格式文件头构造器（覆盖解析器读取的偏移）----
  function flacBytes({ rate = 44100, ch = 2, bits = 16, total = 44100 * 60 } = {}) {
    const b = Buffer.alloc(42)
    b.write('fLaC', 0, 'ascii')
    b[4] = 0x00 // STREAMINFO（非 last）
    b.writeUIntBE(34, 5, 3)
    const v = (BigInt(rate) << 44n) | (BigInt(ch - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(total)
    b.writeUInt32BE(Number(v >> 32n), 18)
    b.writeUInt32BE(Number(v & 0xffffffffn), 22)
    return b
  }
  function wavBytes({ rate = 44100, ch = 2, bits = 16 } = {}) {
    const fmt = Buffer.alloc(24)
    fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8)
    fmt.writeUInt16LE(ch, 10); fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * ch * bits / 8, 16)
    fmt.writeUInt16LE(ch * bits / 8, 20); fmt.writeUInt16LE(bits, 22)
    const data = Buffer.alloc(8); data.write('data', 0, 'ascii'); data.writeUInt32LE(0, 4)
    const body = Buffer.concat([fmt, data])
    const out = Buffer.alloc(12 + body.length)
    out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(4 + body.length, 4); out.write('WAVE', 8, 'ascii')
    body.copy(out, 12)
    return out
  }
  function aiffBytes({ rate = 44100, ch = 2, bits = 16 } = {}) {
    const comm = Buffer.alloc(26)
    comm.write('COMM', 0, 'ascii'); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(ch, 8)
    comm.writeUInt32BE(0, 10); comm.writeUInt16BE(bits, 14)
    const e = Math.floor(Math.log2(rate))
    const mant = (rate / 2 ** e) * 2 ** 63
    comm.writeUInt16BE(e + 16383, 16); comm.writeUInt32BE(Math.floor(mant / 2 ** 32), 18); comm.writeUInt32BE((mant >>> 0) >>> 0, 22)
    const form = Buffer.alloc(12 + comm.length)
    form.write('FORM', 0, 'ascii'); form.writeUInt32BE(comm.length + 4, 4); form.write('AIFF', 8, 'ascii')
    comm.copy(form, 12)
    return form
  }
  function mp3Bytes({ kbps = 320, withId3 = false } = {}) {
    const idx = { 32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14 }[kbps]
    const frame = Buffer.alloc(64) // 足够长，避免 <8 字节早退
    frame[0] = 0xff; frame[1] = 0xfb // MPEG1 LayerIII
    frame[2] = (idx << 4) | 0x02 // bitrate + samplerate index 0 (44100)
    frame[3] = 0x00 // 双声道
    if (!withId3) return frame
    const id3 = Buffer.alloc(10); id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    return Buffer.concat([id3, frame])
  }
  function m4aBytes({ rate = 44100, ch = 2, bits = 16, durSec = 240 } = {}) {
    const box = (type, body) => {
      const out = Buffer.alloc(8 + body.length)
      out.writeUInt32BE(8 + body.length, 0); out.write(type, 4, 'ascii'); body.copy(out, 8)
      return out
    }
    const mvhdBody = Buffer.alloc(20)
    mvhdBody[0] = 0 // version 0
    mvhdBody.writeUInt32BE(1000, 12) // timescale
    mvhdBody.writeUInt32BE(durSec * 1000, 16) // duration
    const mp4aBody = Buffer.alloc(28)
    mp4aBody.writeUInt16BE(ch, 16) // channelcount
    mp4aBody.writeUInt16BE(bits, 18) // samplesize
    mp4aBody.writeUInt32BE(Math.round(rate * 65536), 24) // samplerate 16.16
    const stsdBody = Buffer.alloc(8); stsdBody.writeUInt32BE(1, 4)
    const stsd = box('stsd', Buffer.concat([stsdBody, box('mp4a', mp4aBody)]))
    const moov = box('moov', Buffer.concat([box('mvhd', mvhdBody), stsd]))
    const ftypBody = Buffer.alloc(8); ftypBody.write('M4A ', 0, 'ascii'); ftypBody.writeUInt32BE(0, 4)
    return Buffer.concat([box('ftyp', ftypBody), moov])
  }
  function oggVorbisBytes({ rate = 44100, ch = 2, bitrate = 320000 } = {}) {
    const ident = Buffer.alloc(28)
    ident[0] = 1; Buffer.from('vorbis', 'ascii').copy(ident, 1)
    ident.writeUInt32LE(0, 7); ident[11] = ch; ident.writeUInt32LE(rate, 12); ident.writeUInt32LE(bitrate, 20)
    const page = Buffer.alloc(28 + ident.length)
    page.write('OggS', 0, 'ascii'); page[4] = 0; page[5] = 2; page[26] = 1; page[27] = ident.length
    ident.copy(page, 28)
    return page
  }
  function oggOpusBytes({ rate = 48000, ch = 2 } = {}) {
    const head = Buffer.alloc(19)
    head.write('OpusHead', 0, 'ascii'); head[8] = 1; head[9] = ch; head.writeUInt16LE(312, 10); head.writeUInt32LE(rate, 12); head.writeUInt16LE(0, 16); head[18] = 0
    const page = Buffer.alloc(28 + head.length)
    page.write('OggS', 0, 'ascii'); page[4] = 0; page[5] = 2; page[26] = 1; page[27] = head.length
    head.copy(page, 28)
    return page
  }

  it('FLAC → 无损，带采样率/位深/声道', () => {
    const m = parseAudioMeta(flacBytes())
    expect(m).toMatchObject({ codec: 'FLAC', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('WAV → 无损，带采样率/位深/声道', () => {
    expect(parseAudioMeta(wavBytes())).toMatchObject({ codec: 'WAV', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('AIFF → 无损，80 位扩展浮点采样率解码正确', () => {
    expect(parseAudioMeta(aiffBytes())).toMatchObject({ codec: 'AIFF', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('MP3 320k → 高音质；128k → 标准', () => {
    expect(parseAudioMeta(mp3Bytes({ kbps: 320 }))).toMatchObject({ codec: 'MP3', bitrateKbps: 320, sampleRate: 44100, tier: '高音质' })
    expect(parseAudioMeta(mp3Bytes({ kbps: 128 }))).toMatchObject({ codec: 'MP3', bitrateKbps: 128, tier: '标准' })
  })
  it('MP3 带 ID3v2 标签也能解析', () => {
    expect(parseAudioMeta(mp3Bytes({ kbps: 256, withId3: true }))).toMatchObject({ codec: 'MP3', bitrateKbps: 256, tier: '高音质' })
  })
  it('M4A/AAC 按文件大小与时长估码率分档', () => {
    const hi = parseAudioMeta(m4aBytes({ durSec: 240 }), '', 5 * 1024 * 1024) // ~175kbps
    expect(hi).toMatchObject({ codec: 'AAC', sampleRate: 44100, channels: 2 })
    expect(hi.bitrateKbps).toBeGreaterThan(0)
    const lo = parseAudioMeta(m4aBytes({ durSec: 600 }), '', 4 * 1024 * 1024) // ~55kbps
    expect(lo.tier).toBe('标准')
  })
  it('OGG Vorbis 高码率 → 高音质；低码率 → 标准', () => {
    expect(parseAudioMeta(oggVorbisBytes({ bitrate: 320000 }))).toMatchObject({ codec: 'OGG', sampleRate: 44100, tier: '高音质' })
    expect(parseAudioMeta(oggVorbisBytes({ bitrate: 128000 }))).toMatchObject({ codec: 'OGG', tier: '标准' })
  })
  it('OGG Opus → 高音质', () => {
    expect(parseAudioMeta(oggOpusBytes())).toMatchObject({ codec: 'Opus', sampleRate: 48000, channels: 2, tier: '高音质' })
  })
  it('无法识别的字节 → null（无标签）', () => {
    expect(parseAudioMeta(Buffer.from('this is just text', 'utf8'))).toBeNull()
    expect(parseAudioMeta(Buffer.alloc(4))).toBeNull()
  })
  it('audioQualityLabel 拼成「格式 · 档位」', () => {
    expect(audioQualityLabel({ codec: 'FLAC', tier: '无损' })).toBe('FLAC · 无损')
    expect(audioQualityLabel({ codec: 'MP3', tier: '高音质' })).toBe('MP3 · 高音质')
    expect(audioQualityLabel({ codec: 'AAC', tier: '' })).toBe('AAC')
    expect(audioQualityLabel(null)).toBe('')
  })

  it('识别「ID3 前缀 + 真实容器」的文件（部分下载工具给 FLAC 贴 ID3）→ 无损而非误判 MP3', () => {
    // 真实库里的 .flac 常带 ID3v2 前缀：跳完标签后必须按内容识别成 FLAC，
    // 而不是在 FLAC 数据里误找 MPEG 同步而错标成 MP3（回归）。
    const id3 = Buffer.alloc(10)
    id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    const combo = Buffer.concat([id3, flacBytes()])
    expect(parseAudioMeta(combo)).toMatchObject({ codec: 'FLAC', tier: '无损' })
    // 无标签前缀的正常 FLAC 不受影响
    expect(parseAudioMeta(flacBytes())).toMatchObject({ codec: 'FLAC', tier: '无损' })
  })

  it('reports local track quality in the manifest (扫描时解析文件头)', async () => {
    const { handler, cleanup } = boot({
      musicFiles: {
        'song.flac': flacBytes(),
        'song.mp3': mp3Bytes({ kbps: 128 }),
        'garbage.mp3': 'not really an mp3, just text', // 解析不出 → 无标签
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      const byName = Object.fromEntries(data.tracks.map((t) => [t.name, t.quality]))
      expect(byName['song.flac']).toBe('FLAC · 无损')
      expect(byName['song.mp3']).toBe('MP3 · 标准')
      expect(byName['garbage.mp3']).toBe('')
    } finally { cleanup() }
  })
})



describe('dsh-music-plus playlists', () => {
  // helper: run a JSON POST and return the parsed body
  async function post(handler, url, payload) {
    const res = makeRes()
    await handler(
      makeReq({ method: 'POST', url, body: JSON.stringify(payload) }),
      res,
    )
    return { status: res.status, data: JSON.parse(res.body) }
  }

  it('exposes the fixed system playlist 我最喜欢 in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(Array.isArray(data.playlists)).toBe(true)
      const fav = data.playlists.find((p) => p.id === 'pl-fav')
      expect(fav).toBeTruthy()
      expect(fav.name).toBe('我最喜欢')
      expect(fav.fixed).toBe(true)
      expect(fav.count).toBe(0)
      expect(fav.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('creates a custom playlist and reports it in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const r = await post(handler, '/dsh-music-plus/playlist', { name: '通勤' })
      expect(r.status).toBe(200)
      expect(r.data.ok).toBe(true)
      expect(r.data.playlist.id).toMatch(/^pl-/)
      expect(r.data.playlist.name).toBe('通勤')
      expect(r.data.playlist.fixed).toBe(false)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('通勤')
    } finally { cleanup() }
  })

  it('rejects an empty playlist name', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const r = await post(handler, '/dsh-music-plus/playlist', { name: '   ' })
      expect(r.status).toBe(400)
      expect(r.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('adds audio files to a playlist (dedup, skip invalid) and streams them via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'CLIPDATA', 'extra/notes.txt': 'nope' },
      musicFiles: { 'a.mp3': 'A' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const id = created.data.playlist.id
      // adding the same path twice should dedup; a .txt must be skipped
      const add = await post(handler, '/dsh-music-plus/playlist/add', {
        id, paths: [clip, clip, join(home, 'extra', 'notes.txt')],
      })
      expect(add.data.ok).toBe(true)
      expect(add.data.added).toBe(1)
      expect(add.data.playlist.count).toBe(1)
      expect(add.data.playlist.missing).toBe(0)
      expect(add.data.playlist.tracks[0].name).toBe('clip.mp3')
      expect(add.data.playlist.tracks[0].url.startsWith('/dsh-music-plus/file?path=')).toBe(true)
      expect(add.data.playlist.tracks[0].size).toBe('CLIPDATA'.length)
      // the generic streaming route serves the playlist member
      const res = makeRes()
      await handler(makeReq({ url: add.data.playlist.tracks[0].url }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(Buffer.from(res.body).toString()).toBe('CLIPDATA')
    } finally { cleanup() }
  })

  it('streams a playlist member with Range (206) via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'ABCDEFGHIJ' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      await post(handler, '/dsh-music-plus/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      const res = makeRes()
      await handler(makeReq({
        url: '/dsh-music-plus/file?path=' + encodeURIComponent(clip),
        headers: { range: 'bytes=2-5' },
      }), res)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
    } finally { cleanup() }
  })

  it('rejects /file for an unregistered path with 403 and a missing file with 404', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'secret.mp3': 'SECRET', 'm/clip.mp3': 'CLIP' },
    })
    try {
      const secret = join(home, 'secret.mp3')
      // never added to any playlist -> not registered
      const forbidden = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/file?path=' + encodeURIComponent(secret) }), forbidden)
      expect(forbidden.status).toBe(403)
      // register a real file, then delete it from disk -> still registered, now 404
      const clip = join(home, 'm', 'clip.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      await post(handler, '/dsh-music-plus/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      rmSync(clip, { force: true })
      const gone = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/file?path=' + encodeURIComponent(clip) }), gone)
      expect(gone.status).toBe(404)
    } finally { cleanup() }
  })

  it('removes tracks from a playlist', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music-plus/playlist/add', { id, paths: [a, b] })
      const rm = await post(handler, '/dsh-music-plus/playlist/remove', { id, paths: [a] })
      expect(rm.data.removed).toBe(1)
      expect(rm.data.playlist.tracks.map((t) => t.name)).toEqual(['b.mp3'])
    } finally { cleanup() }
  })

  it('clears a playlist entirely (including the fixed one) via /playlist/clear', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music-plus/playlist/add', { id, paths: [a, b] })
      const clr = await post(handler, '/dsh-music-plus/playlist/clear', { id })
      expect(clr.data.ok).toBe(true)
      expect(clr.data.cleared).toBe(2)
      expect(clr.data.playlist.count).toBe(0)
      expect(clr.data.playlist.tracks).toEqual([])
      // fixed 系统歌单也可以清空
      await post(handler, '/dsh-music-plus/playlist/add', { id: 'pl-fav', paths: [a] })
      const clrFav = await post(handler, '/dsh-music-plus/playlist/clear', { id: 'pl-fav' })
      expect(clrFav.data.cleared).toBe(1)
      expect(clrFav.data.playlist.fixed).toBe(true)
      expect(clrFav.data.playlist.count).toBe(0)
      // unknown id -> 404
      const nf = await post(handler, '/dsh-music-plus/playlist/clear', { id: 'pl-nope' })
      expect(nf.status).toBe(404)
    } finally { cleanup() }
  })

  it('reorders playlist members, appending unmentioned ones at the end', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B', 'm/c.mp3': 'C' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const c = join(home, 'm', 'c.mp3')
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music-plus/playlist/add', { id, paths: [a, b, c] })
      const re = await post(handler, '/dsh-music-plus/playlist/reorder', { id, paths: [c, a] })
      expect(re.data.ok).toBe(true)
      expect(re.data.playlist.tracks.map((t) => t.name)).toEqual(['c.mp3', 'a.mp3', 'b.mp3'])
    } finally { cleanup() }
  })

  it('renames a custom playlist but rejects renaming the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music-plus/playlist/rename', { id: created.data.playlist.id, name: '新名字' })
      expect(ok.data.ok).toBe(true)
      expect(ok.data.playlist.name).toBe('新名字')
      const fixed = await post(handler, '/dsh-music-plus/playlist/rename', { id: 'pl-fav', name: '改' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('deletes a custom playlist but rejects deleting the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music-plus/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music-plus/playlist/delete', { id: created.data.playlist.id })
      expect(ok.data.ok).toBe(true)
      const fixed = await post(handler, '/dsh-music-plus/playlist/delete', { id: 'pl-fav' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('persists playlists to the state file and reloads a pre-seeded file', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        '.dsh/dsh-music-plus-playlists.json': JSON.stringify({
          version: 1,
          playlists: [{ id: 'pl-seed', name: '预置歌单', fixed: false, trackPaths: [], createdAt: 1, updatedAt: 1 }],
        }),
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('预置歌单') // loaded from the pre-seeded file
      expect(names).toContain('我最喜欢') // system playlist still guaranteed
      // a create writes the file back
      await post(handler, '/dsh-music-plus/playlist', { name: '持久' })
      const file = join(home, '.dsh', 'dsh-music-plus-playlists.json')
      expect(existsSync(file)).toBe(true)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.playlists.map((p) => p.name)).toContain('持久')
    } finally { cleanup() }
  })

  it('lists directories plus audio files (excluding others) via /files', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'Music/sub/song.mp3': 'A', 'Music/a.mp3': 'B', 'Music/b.mp3': 'C', 'Music/notes.txt': 'x' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/files?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.dirs.map((d) => d.name)).toEqual(['sub'])
      const fileNames = data.files.map((f) => f.name).sort()
      expect(fileNames).toEqual(['a.mp3', 'b.mp3'])
      for (const f of data.files) expect(typeof f.path).toBe('string')
    } finally { cleanup() }
  })

  it('plays a playlist via the music_play_plus playlist param', async () => {
    const { handler, tools, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const created = await post(handler, '/dsh-music-plus/playlist', { name: '最爱' })
      const pl = created.data.playlist
      await post(handler, '/dsh-music-plus/playlist/add', { id: pl.id, paths: [join(home, 'm', 'a.mp3')] })
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({ playlist: '最爱' })
      expect(out.played).toBe(true)
      expect(out.matches).toBe(1)
      expect(out.track).toBe('a.mp3')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music-plus/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(intent.playlistId).toBe(pl.id)
      expect(intent.playlistName).toBe('最爱')
      expect(intent.id).toBeTruthy()
    } finally { cleanup() }
  })

  it('reports an unknown playlist name via music_play_plus', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play_plus')
      const out = await tool.execute({ playlist: '不存在的歌单' })
      expect(out.played).toBe(false)
      expect(out.notice).toContain('没有找到歌单')
    } finally { cleanup() }
  })
})
