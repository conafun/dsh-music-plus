/**
 * dsh-music-plus — 网络电台：电台源 / 播放列表解析（零依赖）。
 *
 * 与 lib/podcast.js 同一路数：只做「把外部文本变成播放器能吃的规范形状」这一件事，
 * 网络请求（Node 内置 fetch）留在 Host 的 lib/index.js 里做。
 *
 * 支持的格式（覆盖主流网络电台清单）：
 *   - M3U / M3U8 文本清单（#EXTM3U / #EXTINF，含 IPTV 风格的 group-title 属性）
 *   - PLS（File1= / Title1= / Length1=）
 *   - XSPF（<track><title>/<location>/<annotation>）
 *   - ASX / WAX（<entry><title>/<ref href>）
 *   - README 电台清单（conafun/recommended-radio-streams 仓库的 README 格式）
 *   - radio-browser.info 的 JSON 数组
 *
 * 统一输出：
 *   [{ name, url, homepage, label, group, tags, codec, bitrate, country, down }]
 *   - name   电台显示名（多路流会自动拼上「台名 - 频道名」）
 *   - label  多路流时的频道名（如 Stream / Channel 1），单路为空串
 *   - group  清单自带的分类名（# Group: / group-title= / README 标题），可空
 *   - down   清单里标记为失效（README 的 *(down …)* 备注）
 *
 * 所有解析器都对脏数据容错：解析不出电台的行直接跳过，绝不抛异常。
 */

// ---- 通用小工具 ----

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' }

export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&([a-zA-Z]+);/g, (m, n) => {
      const v = ENTITIES[n.toLowerCase()]
      return v === undefined ? m : v
    })
}

function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
}

function cleanText(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim()
}

// 从 XML 里取第一个 <tag ...>...</tag> 的文本内容。
function tagText(xml, tag) {
  const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(String(xml))
  return m ? cleanText(m[1]) : ''
}

// 从 XML 里取第一个 <tag ... attr="..."> 的属性值。
function tagAttr(xml, tag, attr) {
  const re = new RegExp('<' + tag + '\\b[^>]*?\\b' + attr + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i')
  const m = re.exec(String(xml))
  if (m === undefined || m === null) return ''
  return decodeEntities(m[2] !== undefined ? m[2] : m[3]).trim()
}

// 把文档切成每个 <tag>...</tag> 块的内层文本（清单类 XML 不嵌套，正则足够）。
function xmlBlocks(xml, tag) {
  const out = []
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi')
  let m
  const s = String(xml)
  while ((m = re.exec(s)) !== null) out.push(m[1])
  return out
}

// 播放列表文件的后缀（这些 URL 需要先取回清单文本，再取真实流地址）。
const PLAYLIST_EXT = /\.(m3u8?|pls|xspf|asx|wax|txt|json)(\?|#|$)/i
// HLS —— 浏览器原生 <audio> 播不了，需要 hls.js，本插件先只做标记。
const HLS_EXT = /\.m3u8(\?|#|$)/i

export function isPlaylistUrl(url) {
  return PLAYLIST_EXT.test(String(url || '').trim())
}

export function isHlsUrl(url) {
  return HLS_EXT.test(String(url || '').trim())
}

/**
 * 稳定的电台 id：由流地址 hash 而来（不是随机/自增）。
 * 上游仓库更新后同一台仍是同一个 id，用户的收藏/隐藏/自定义改名不会丢。
 */
export function stationId(url) {
  const s = String(url || '').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return 'st-' + h.toString(16).padStart(8, '0')
}

/** 分类 id：英文分类名得到可读 slug，中文等非 ASCII 名走 hash 兜底。 */
export function categoryId(name) {
  const s = cleanText(name).toLowerCase()
  const slug = s.replace(/[^a-z0-9\s-]/g, '').replace(/[-\s]+/g, '-').replace(/^-+|-+$/g, '')
  return slug !== '' ? slug : 'cat-' + stationId(s).slice(3)
}

// ---- M3U / M3U8 ----

/**
 * 解析 M3U / M3U8 文本清单。
 *   #EXTM3U
 *   # Group: Jazz & Blues              ← 上游仓库写法
 *   # Homepage: https://example.com/
 *   #EXTINF:-1,Jazz24
 *   https://example.com/stream
 * 也兼容 IPTV 风格：
 *   #EXTINF:-1 tvg-logo="..." group-title="Jazz",Jazz24
 */
export function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/)
  const stations = []
  let group = ''
  let homepage = ''
  let pending = null // { name, group, homepage }

  for (let raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      const info = /^#EXTINF\s*:\s*([^,]*),(.*)$/i.exec(line)
      if (info !== null) {
        // IPTV 属性（group-title / tvg-*）在时长字段里。
        const attrs = info[1] || ''
        const gt = /\bgroup-title\s*=\s*"([^"]*)"/i.exec(attrs)
        pending = {
          name: cleanText(info[2]),
          group: gt !== null ? cleanText(gt[1]) : group,
          homepage,
        }
        continue
      }
      const g = /^#\s*(?:GROUP|Group)\s*:\s*(.*)$/.exec(line) || /^#GROUP\s*:\s*(.*)$/i.exec(line)
      if (g !== null) { group = cleanText(g[1]); continue }
      const h = /^#\s*(?:HOMEPAGE|Homepage)\s*:\s*(.*)$/.exec(line) || /^#EXTHOMEPAGE\s*:\s*(.*)$/i.exec(line)
      if (h !== null) { homepage = cleanText(h[1]); continue }
      // 其余 # 注释（含 #EXTM3U）忽略；注意注释不能打断 EXTINF→URL 的配对。
      continue
    }
    // 非注释行 = URL。
    const entry = pending !== null
      ? { name: pending.name, group: pending.group, homepage: pending.homepage }
      : { name: '', group, homepage }
    pending = null
    stations.push({ ...entry, url: line })
  }
  return stations
}

// ---- PLS ----

/** 解析 PLS：FileN=/TitleN=/LengthN= 三件套（N 从 1 起）。 */
export function parsePLS(text) {
  const files = new Map()
  const titles = new Map()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('[')) continue
    const m = /^(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line)
    if (m === null) continue
    const key = m[1].toLowerCase()
    const n = parseInt(m[2], 10)
    const val = cleanText(m[3])
    if (key === 'file') files.set(n, val)
    else if (key === 'title') titles.set(n, val)
  }
  const out = []
  for (const n of [...files.keys()].sort((a, b) => a - b)) {
    out.push({ name: titles.get(n) || '', url: files.get(n), homepage: '', group: '' })
  }
  return out
}

// ---- XSPF ----

/** 解析 XSPF（<playlist><tracklist><track>…）。 */
export function parseXSPF(xml) {
  const out = []
  const playlistTitle = tagText(xml, 'title')
  for (const block of xmlBlocks(xml, 'track')) {
    const url = tagText(block, 'location')
    if (!url) continue
    out.push({
      name: tagText(block, 'title'),
      url,
      homepage: tagText(block, 'annotation'),
      group: tagText(block, 'album'),
      label: '',
    })
  }
  if (out.length > 0 && playlistTitle) {
    for (const s of out) if (!s.group) s.group = playlistTitle
  }
  return out
}

// ---- ASX / WAX ----

/** 解析 ASX/WAX（<entry><title>…</title><ref href="…"/>）。 */
export function parseASX(xml) {
  const out = []
  for (const block of xmlBlocks(xml, 'entry')) {
    const url = tagAttr(block, 'ref', 'href')
    if (!url) continue
    out.push({ name: tagText(block, 'title'), url, homepage: '', group: '', label: '' })
  }
  return out
}

// ---- README 电台清单（conafun/recommended-radio-streams 的格式）----

// 形如： - [Jazz24](https://www.jazz24.org/): [Stream](https://.../6285_256k)
//       - ⭐ [NTS](https://nts.live): [Channel 1](url) / [Channel 2](url) *(down 2024-01)*
const README_ENTRY_RE = /^-\s*(?:⭐\s*)?\[([^\]]+)\]\(([^)]+)\)\s*:\s*(.*)$/
const README_STREAM_RE = /\[(Stream|Channel\s*[12]|[12])\]\(([^)]+)\)/gi
const README_CHAIN_RE = /((?:\[[^\]]+\]\([^)]+\)\s*\/\s*)*\[[^\]]+\]\([^)]+\))\s*(\*\(\s*down\b[^)]*\)\*?)?\s*$/
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

/** 从一行 README 条目里取出 (label, url) 列表；取不到返回 []。 */
export function readmeStreams(line) {
  const s = String(line || '')
  const chain = README_CHAIN_RE.exec(s)
  if (chain !== null) {
    const out = []
    let m
    MD_LINK_RE.lastIndex = 0
    while ((m = MD_LINK_RE.exec(chain[1])) !== null) out.push({ label: cleanText(m[1]), url: m[2].trim() })
    if (out.length > 0) return out
  }
  const out = []
  let m
  README_STREAM_RE.lastIndex = 0
  while ((m = README_STREAM_RE.exec(s)) !== null) out.push({ label: cleanText(m[1]), url: m[2].trim() })
  return out
}

/**
 * 解析 README 电台清单：2~4 级标题当分类，`- [台名](主页): [Stream](流地址)` 当电台。
 * 返回 [{ id, name, stations: [{ name, url, homepage, label, group, down }] }]
 */
export function parseReadmeStations(md) {
  const categories = []
  let current = null
  const lines = String(md || '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    const heading = /^(#{2,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const name = cleanText(heading[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
      current = { id: categoryId(name), name, stations: [] }
      categories.push(current)
      continue
    }
    const entry = README_ENTRY_RE.exec(line)
    if (entry === null) continue
    if (current === null) {
      current = { id: 'uncategorized', name: '未分类', stations: [] }
      categories.push(current)
    }
    const baseName = cleanText(entry[1].replace(/\*+/g, ''))
    const homepage = entry[2].trim()
    const streams = readmeStreams(line)
    if (streams.length === 0) continue
    const down = /\*\(\s*down\b/i.test(line)
    for (const st of streams) {
      const label = streams.length > 1 ? st.label : ''
      current.stations.push({
        name: label !== '' ? baseName + ' - ' + label : baseName,
        url: st.url,
        homepage,
        label,
        group: current.name,
        down,
      })
    }
  }
  return categories.filter((c) => c.stations.length > 0)
}

// ---- radio-browser.info JSON ----

/** 解析 radio-browser.info 的站点 JSON 数组（也容错单个对象）。 */
export function parseRadioBrowserJson(json) {
  const list = Array.isArray(json) ? json : (json && Array.isArray(json.stations) ? json.stations : [])
  const out = []
  for (const it of list) {
    if (it === null || typeof it !== 'object') continue
    const url = String(it.url_resolved || it.url || '').trim()
    if (url === '') continue
    const tags = Array.isArray(it.tags)
      ? it.tags.filter((t) => typeof t === 'string' && t !== '')
      : String(it.tags || '').split(',').map((t) => t.trim()).filter((t) => t !== '')
    out.push({
      name: cleanText(it.name_resolved || it.name || ''),
      url,
      homepage: String(it.homepage || '').trim(),
      group: tags.length > 0 ? tags[0] : '',
      tags,
      codec: String(it.codec || '').trim(),
      bitrate: Number.isFinite(it.bitrate) ? it.bitrate : 0,
      country: cleanText(it.country || ''),
      label: '',
    })
  }
  return out
}

// ---- 格式探测 + 统一入口 ----

/** 按 URL 后缀 / Content-Type / 正文特征判断清单格式。 */
export function detectFormat(url, contentType = '', body = '') {
  const u = String(url || '').trim()
  const ct = String(contentType || '').toLowerCase()
  const head = String(body || '').slice(0, 4096)
  if (/\.pls(\?|#|$)/i.test(u)) return 'pls'
  if (/\.xspf(\?|#|$)/i.test(u)) return 'xspf'
  if (/\.(asx|wax)(\?|#|$)/i.test(u)) return 'asx'
  if (/\.json(\?|#|$)/i.test(u) || ct.includes('application/json')) return 'json'
  if (head.includes('#EXTM3U') || head.includes('#EXTINF')) return 'm3u'
  if (/^\s*\[playlist\]/i.test(head) || /File1\s*=/i.test(head)) return 'pls'
  if (/<playlist[\s>]/i.test(head) && /xmlns="http:\/\/xspf\.org/i.test(head)) return 'xspf'
  if (/<asx[\s>]/i.test(head)) return 'asx'
  if (/^\s*[\[{]/.test(head) && ct.includes('json')) return 'json'
  if (/^\s*#{2,4}\s+/.test(head) && /^-\s*(?:⭐\s*)?\[/m.test(head)) return 'readme'
  if (/\.(m3u8?)(\?|#|$)/i.test(u)) return 'm3u'
  return 'unknown'
}

/**
 * 统一解析入口：给 URL + Content-Type + 正文，返回规范电台数组。
 * 解析不出内容时回退成「单条直链电台」——用户粘一条 mp3/aac 流地址也能直接加。
 */
export function parsePlaylist(url, contentType, body, fallbackName = '') {
  const format = detectFormat(url, contentType, body)
  if (format === 'm3u') return { format, stations: normalize(parseM3U(body)) }
  if (format === 'pls') return { format, stations: normalize(parsePLS(body)) }
  if (format === 'xspf') return { format, stations: normalize(parseXSPF(body)) }
  if (format === 'asx') return { format, stations: normalize(parseASX(body)) }
  if (format === 'json') {
    let json = null
    try { json = JSON.parse(body) } catch (e) { json = null }
    return { format, stations: normalize(parseRadioBrowserJson(json)) }
  }
  if (format === 'readme') {
    const cats = parseReadmeStations(body)
    const flat = []
    for (const c of cats) flat.push(...c.stations)
    return { format, stations: normalize(flat) }
  }
  return { format, stations: normalize([{ name: fallbackName, url: String(url || '').trim() }]) }
}

/** 补齐字段、去掉空 URL、按 URL 去重。 */
export function normalize(list) {
  const out = []
  const seen = new Set()
  for (const it of (Array.isArray(list) ? list : [])) {
    if (it === null || typeof it !== 'object') continue
    const url = String(it.url || '').trim()
    if (url === '' || /^#/.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      name: cleanText(it.name || ''),
      url,
      homepage: String(it.homepage || '').trim(),
      label: String(it.label || ''),
      group: cleanText(it.group || ''),
      tags: Array.isArray(it.tags) ? it.tags.slice(0, 12) : [],
      codec: String(it.codec || ''),
      bitrate: Number.isFinite(it.bitrate) ? it.bitrate : 0,
      country: cleanText(it.country || ''),
      down: it.down === true,
    })
  }
  return out
}

// ---- 展示辅助（Host 与 Web 共用同一套判定）----

/** 需要 hls.js 才能播（浏览器原生 audio 不支持）。 */
export function needsHls(url) {
  return isHlsUrl(url)
}

/** 音质标签：有 codec/bitrate 用它们，否则按 URL 后缀猜。 */
export function qualityLabel(station) {
  const s = station || {}
  const codec = String(s.codec || '').toUpperCase()
  const kbps = Number.isFinite(s.bitrate) && s.bitrate > 0 ? Math.round(s.bitrate) + 'kbps' : ''
  if (codec !== '') return kbps !== '' ? codec + ' · ' + kbps : codec
  if (kbps !== '') return kbps
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(s.url || ''))
  return m !== null ? m[1].toUpperCase() : ''
}
