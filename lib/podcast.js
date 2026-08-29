/**
 * dsh-music-plus — podcast RSS/Atom feed parsing (dependency-free).
 *
 * The Host fetches the feed with Node's global `fetch` (Node >= 20); this module
 * only turns raw feed XML into a normalized shape consumed by the player:
 *
 *   parseFeed(xml) -> {
 *     title, description, image,            // feed-level (strings / '' / '' )
 *     episodes: [{ title, url, duration, pubDate, description, image, guid }],
 *   }
 *
 * It is intentionally tolerant of the messy real-world feed variety: CDATA,
 * namespaced media tags (<media:content>), <itunes:duration> either as seconds
 * or "HH:MM:SS"/"MM:SS", RSS 2.0 <item> blocks and Atom <entry> blocks, and
 * audio URLs discovered from <enclosure> / <media:content url> / <link> /
 * <content src> / <media:thumbnail>.
 *
 * Pure regex/pull parsing (no XML dependency) is sufficient for feed XML, whose
 * structure is regular. Episodes without any usable audio URL are skipped.
 */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
}

function stripTagsCdata(s) {
  // Protect CDATA sections verbatim (their angle brackets may be literal "<生活>"),
  // strip non-CDATA tags, then restore the protected CDATA.
  const cdata = []
  let out = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => {
    cdata.push(c)
    return '\u0000' + (cdata.length - 1) + '\u0000'
  })
  out = out.replace(/<[^>]*>/g, '')
  for (let i = 0; i < cdata.length; i++) out = out.split('\u0000' + i + '\u0000').join(cdata[i])
  return out
}

function textOf(xml, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(xml)
  return m ? decodeEntities(stripTagsCdata(m[1])).trim() : ''
}

// First text content of `tag` inside the FIRST <container>...</container> block.
function textIn(xml, container, tag) {
  const cm = new RegExp('<' + container + '[^>]*>([\\s\\S]*?)</' + container + '>', 'i').exec(xml)
  return cm ? textOf(cm[1], tag) : ''
}

// Split a document into the inner HTML of each <tag>...</tag> block (non-nested by
// construction, which holds for feed item/entry blocks).
function blocks(xml, tag) {
  const out = []
  const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi')
  let m
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

function attr(xml, tag, name) {
  const m = new RegExp('<' + tag + '[^>]*\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(xml)
  if (!m) return ''
  return decodeEntities(m[2] !== undefined ? m[2] : m[3]).trim()
}

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|webm|aiff|aif)(\?|#|$)/i
const AUDIO_MIME = /audio\//i

// Audio URL candidates, most-specific first. Returns '' when none is plausible.
function episodeAudioUrl(block) {
  // 1) <enclosure url type="audio/...">
  const enc = attr(block, 'enclosure', 'url')
  const encType = attr(block, 'enclosure', 'type')
  if (enc && (AUDIO_EXT.test(enc) || AUDIO_MIME.test(encType))) return enc
  // 2) <media:content url type="audio/..."> / <content src=...>
  for (const tag of ['media:content', 'media:enclosure', 'content']) {
    const u = attr(block, tag, 'url') || attr(block, tag, 'src')
    if (u && (AUDIO_EXT.test(u) || AUDIO_MIME.test(attr(block, tag, 'type')))) return u
  }
  // 3) <link> tags (self-closing or paired): rel="enclosure" or an audio href
  const linkRe = /<link\b[^>]*>/gi
  let lm
  while ((lm = linkRe.exec(block)) !== null) {
    const lt = lm[0]
    const rel = /\brel\s*=\s*"enclosure"/i.test(lt)
    const href = (/\bhref\s*=\s*"([^"]*)"/i.exec(lt) || [])[1]
      || (/\bhref\s*=\s*'([^']*)'/i.exec(lt) || [])[1]
    if (href && (rel || AUDIO_EXT.test(href))) return href
  }
  // 4) Atom <guid> used as an audio URL (some feeds)
  const guid = textOf(block, 'guid')
  if (guid && AUDIO_EXT.test(guid)) return guid
  return ''
}

function parseDuration(d) {
  const s = String(d || '').trim()
  if (s === '') return 0
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10)
  const parts = s.split(':').map((x) => parseInt(x, 10))
  if (parts.some((x) => !Number.isFinite(x))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
}

export function parseFeed(xml) {
  xml = String(xml || '')
  const isAtom = /<feed[\s>]/i.test(xml)
  const episodes = []
  let title = ''
  let description = ''
  let image = ''

  if (isAtom) {
    title = textIn(xml, 'feed', 'title')
    description = textIn(xml, 'feed', 'subtitle') || textIn(xml, 'feed', 'description')
    image = textOf(xml, 'icon') || textOf(xml, 'logo')
    const entries = blocks(xml, 'entry')
    for (const e of entries) {
      const url = episodeAudioUrl(e)
      if (!url) continue
      episodes.push({
        title: textOf(e, 'title') || '未命名单集',
        url,
        duration: parseDuration(textOf(e, 'itunes:duration') || textOf(e, 'duration')),
        pubDate: textOf(e, 'published') || textOf(e, 'updated'),
        description: cleanText(textOf(e, 'summary') || textOf(e, 'content')),
        image: attr(e, 'media:thumbnail', 'url') || attr(e, 'itunes:image', 'href'),
        guid: textOf(e, 'id'),
      })
    }
  } else {
    title = textIn(xml, 'channel', 'title')
    description = textIn(xml, 'channel', 'description')
    image = textIn(xml, 'channel', 'image') ? textIn(xml, 'channel', 'image') + '' : ''
    const img = blocks(textIn(xml, 'channel', 'image'), 'url')
    if (img.length > 0) image = img[0]
    else if (/<itunes:image[^>]+href="([^"]+)"/i.test(xml)) image = RegExp.$1
    const items = blocks(xml, 'item')
    for (const it of items) {
      const url = episodeAudioUrl(it)
      if (!url) continue
      episodes.push({
        title: textOf(it, 'title') || '未命名单集',
        url,
        duration: parseDuration(textOf(it, 'itunes:duration') || textOf(it, 'duration')),
        pubDate: textOf(it, 'pubDate'),
        description: cleanText(textOf(it, 'description') || textOf(it, 'summary')),
        image: attr(it, 'itunes:image', 'href') || attr(it, 'media:thumbnail', 'url'),
        guid: textOf(it, 'guid'),
      })
    }
  }

  return { title, description, image, episodes }
}

// Format a duration in seconds into "HH:MM:SS" / "MM:SS" for display.
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss
}
