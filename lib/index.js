/**
 * dsh-music-plus host half: a plain Cordis plugin running in the host
 * process. It scans the local music directory (default $HOME/Music, or a
 * directory configured through the settings page), streams audio per track
 * through /dsh-music-plus/<id> with Range/seek support, and answers the browser
 * half's JSON calls (manifest / intent / set-root) over the same webServer.
 * It also registers the `music_play_plus` model tool, which lets the CLI/agent ask
 * to play a track; the browser half polls /dsh-music-plus/intent to pick it up.
 *
 * All registrations are effects so the row unmounts cleanly.
 */

// ---- settings constants, mirrored by the client via the manifest route ----
const AUDIO_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
}

const QQ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function isAudioName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 && Object.prototype.hasOwnProperty.call(AUDIO_TYPES, name.slice(i + 1).toLowerCase())
}
function audioType(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? (AUDIO_TYPES[name.slice(i + 1).toLowerCase()] || 'application/octet-stream') : 'application/octet-stream'
}

// 在线 QQ 音乐：把取链返回的 filename（如 "F000<mid><mid>.flac" / "M800<mid><mid>.mp3"）
// 映射成普通用户能看懂的通俗音质标签，随播放流一起回传浏览器显示在播放条上。
// 服务端授予的档位以 filename 前缀 + 扩展名为准：
//   - 四档 FLAC（AI00 / Q001 / Q000 / F000）→ 无损
//   - OGG（O801）与 320k MP3（M800）→ 高音质（用户感知一致，并入同一档）
//   - 128k MP3（M500）→ 标准
// 取不到 / 未知档位返回空串，此时播放条只显示「QQ音乐」。
export function qqQualityLabel(filename) {
  const f = String(filename || '')
  const ext = (f.slice(f.lastIndexOf('.') + 1) || '').toLowerCase()
  if (ext === 'flac') return '无损'
  if (ext === 'ogg') return '高音质'
  if (ext === 'mp3') {
    // filename 形如 "M800<mid><mid>.mp3"：mp3 档位由前缀决定（320k 高音质 / 128k 标准）。
    if (/^M800/i.test(f)) return '高音质'
    if (/^M500/i.test(f)) return '标准'
  }
  return ''
}

// ---- 本地音乐：解析音频文件头识别真实音质 ----
// 扫描时读每首歌的前 ~64KB 解析容器头，得到编码/采样率/位深/声道/码率，映射成与
// 在线 QQ 一致的「无损 / 高音质 / 标准」三档。无新依赖（纯 node:fs + Buffer）。
const AUDIO_HEADER_LEN = 64 * 1024
const AUDIO_LOSSY_HIGH_KBPS = 256 // 有损 ≥ 256kbps 视为「高音质」，否则「标准」
const AUDIO_CODEC_NAMES = { FLAC: 'FLAC', WAV: 'WAV', AIFF: 'AIFF', MP3: 'MP3', AAC: 'AAC', OGG: 'OGG', Opus: 'Opus' }

function mpegLayer3Kbps(version, idx) {
  if (idx === 0 || idx > 14) return 0
  if (version === 1) return [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][idx]
  return [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][idx]
}
function mpegSampleRate(version, idx) {
  if (idx > 2) return 0
  if (version === 1) return [44100, 48000, 32000][idx]
  if (version === 2) return [22050, 24000, 16000][idx]
  return [11025, 12000, 8000][idx]
}
// AIFF 80-bit 扩展浮点采样率解码。
function aiffSampleRate(b, off) {
  const exp = ((b[off] & 0x7f) << 8) | b[off + 1]
  let mant = 0
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[off + 2 + i]
  if (exp === 0 && mant === 0) return 0
  if (exp === 0x7fff) return 0
  return (mant / 2 ** 63) * 2 ** (exp - 16383)
}

// 在缓冲区里扫描 MPEG 音频（MP3 Layer III）帧头，返回首帧的码率/采样率/声道。
// 带「下一帧同步」校验：按帧长跳到下一帧位置应再遇一个合法同步字，能显著降低
// 非音频数据（如 FLAC 流里碰巧出现的 0xFF..）被误判成 MP3 的假同步概率。
function parseMpegFrame(b, off) {
  const n = b.length
  for (let i = off; i + 4 <= n; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue
    // 跳过 ADTS（裸 AAC）帧：byte1 低半字节为 0x1/0x9 且 layer 位为 0。
    if ((b[i + 1] & 0x0f) === 0x01 || (b[i + 1] & 0x0f) === 0x09) continue
    const versionBits = (b[i + 1] >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (b[i + 1] >> 1) & 0x03 // 1=Layer III
    if (versionBits === 1 || layerBits !== 1) continue // 保留位 / 非 Layer III
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
    const kbps = mpegLayer3Kbps(version, (b[i + 2] >> 4) & 0x0f)
    const rate = mpegSampleRate(version, (b[i + 2] >> 2) & 0x03)
    if (kbps === 0 || rate === 0) continue
    // 帧长一致性：Layer III 帧长 = (samplesPerFrame/8 * bitrate) / samplerate + padding。
    const padding = (b[i + 2] >> 1) & 0x01
    const frameLen = Math.floor((version === 1 ? 144 : 72) * kbps * 1000 / rate) + padding
    if (i + frameLen + 4 <= n) {
      const nx = i + frameLen
      if (!(b[nx] === 0xff && (b[nx + 1] & 0xe0) === 0xe0)) continue // 下一帧不同步 → 假同步，继续找
    }
    const chmode = (b[i + 3] >> 6) & 0x03
    return { bitrateKbps: kbps, sampleRate: rate, channels: chmode === 3 ? 1 : 2, tier: kbps >= AUDIO_LOSSY_HIGH_KBPS ? '高音质' : '标准' }
  }
  return null
}

// 有界 M4A/MP4 盒解析：取 mvhd(时长) 与 stsd>mp4a(采样率/声道)。注意 stsd 带自己的
// version/flags/entry_count 头（8 字节），递归进 stsd 时要先跳过它；真实文件嵌套
// moov>trak>mdia>minf>stbl>stsd>mp4a 达 6 层，深度上限放宽到 8。
function parseM4a(b, n) {
  let sampleRate = 0, channels = 0, duration = 0, timescale = 1, hasMp4a = false
  const walk = (start, end, depth) => {
    let off = start
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off)
      const type = b.toString('ascii', off + 4, off + 8)
      if (size < 8) break
      const cs = off + 8
      const ce = Math.min(off + size, end)
      if (type === 'mvhd' && cs + 16 <= ce) {
        if (b[cs] === 0) { timescale = b.readUInt32BE(cs + 12); duration = b.readUInt32BE(cs + 16) }
        else if (cs + 28 <= ce) { timescale = b.readUInt32BE(cs + 20); duration = b.readUInt32BE(cs + 24) * 2 ** 32 + b.readUInt32BE(cs + 28) }
      }
      if (type === 'mp4a' && cs + 28 <= ce) {
        channels = b.readUInt16BE(cs + 16)
        sampleRate = Math.round(b.readUInt32BE(cs + 24) / 65536)
        hasMp4a = true
      }
      if (depth < 8) walk(cs + (type === 'stsd' ? 8 : 0), ce, depth + 1)
      off += size
    }
  }
  walk(0, n, 0)
  if (!hasMp4a) return null
  return { sampleRate, channels, durationSec: timescale > 0 ? duration / timescale : 0 }
}

// 有界 EBML(WebM) 扫描：找 CodecID / SamplingFrequency / Channels。
function parseEbml(b, n) {
  let codec = '', rate = 0, ch = 0
  for (let i = 0; i + 2 < n;) {
    const id = b[i]
    if (id === 0x86 && i + 2 <= n) { // CodecID
      const len = b[i + 1]
      if (i + 2 + len <= n) codec = b.toString('ascii', i + 2, i + 2 + len)
      i += 2 + len
    } else if (id === 0xb5 && i + 2 <= n) { // SamplingFrequency (float)
      const len = b[i + 1]
      if (len === 4 && i + 6 <= n) rate = b.readUInt32BE(i + 2)
      i += 2 + len
    } else if (id === 0x9f && i + 2 <= n) { // Channels (uint)
      const len = b[i + 1]
      if (len === 1 && i + 3 <= n) ch = b[i + 2]
      i += 2 + len
    } else { i++ }
  }
  if (codec === 'A_OPUS') return { codec: 'Opus', sampleRate: rate, channels: ch, tier: '高音质' }
  if (codec === 'A_VORBIS') return { codec: 'OGG', sampleRate: rate, channels: ch, tier: '' }
  return null
}

// 在 buf[off] 处按魔数识别容器格式并解析（FLAC/WAV/AIFF/OGG/M4A/EBML）。用 subarray
// 让各解析器的内部偏移都相对容器起点，便于处理「ID3 前缀 + 真实容器」的组合文件
// （部分下载工具会给 FLAC/OGG 贴一个 ID3v2 标签）。
function parseContainerAt(buf, off, size) {
  const b = buf.subarray(off)
  const n = b.length
  if (n < 8) return null
  const ascii = (o, l) => b.toString('ascii', o, o + l)
  // FLAC
  if (ascii(0, 4) === 'fLaC') {
    if ((b[4] & 0x7f) === 0 && n >= 42) { // STREAMINFO 块：type 0 + 34 字节体
      const v = (BigInt(b.readUInt32BE(18)) << 32n) | BigInt(b.readUInt32BE(22))
      const sampleRate = Number((v >> 44n) & 0xfffffn)
      const channels = Number((v >> 41n) & 0x7n) + 1
      const bits = Number((v >> 36n) & 0x1fn) + 1
      return { codec: 'FLAC', sampleRate, channels, bitDepth: bits, tier: '无损' }
    }
    return { codec: 'FLAC', tier: '无损' }
  }
  // WAV
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    let p = 12
    while (p + 8 <= n) {
      const id = ascii(p, 4)
      const sz = b.readUInt32LE(p + 4)
      if (id === 'fmt ') {
        const fmt = b.readUInt16LE(p + 8)
        if (fmt === 1 || fmt === 3) return { codec: 'WAV', sampleRate: b.readUInt32LE(p + 12), channels: b.readUInt16LE(p + 10), bitDepth: b.readUInt16LE(p + 22), tier: '无损' }
        return { codec: 'WAV', tier: '无损' }
      }
      p += 8 + sz + (sz & 1)
    }
    return { codec: 'WAV', tier: '无损' }
  }
  // AIFF / AIFC
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) {
    let p = 12
    while (p + 8 <= n) {
      const id = ascii(p, 4)
      const sz = b.readUInt32BE(p + 4)
      if (id === 'COMM') {
        const rate = aiffSampleRate(b, p + 16)
        return { codec: 'AIFF', sampleRate: Math.round(rate), channels: b.readUInt16BE(p + 8), bitDepth: b.readUInt16BE(p + 14), tier: '无损' }
      }
      p += 8 + sz + (sz & 1)
    }
    return { codec: 'AIFF', tier: '无损' }
  }
  // Ogg（Vorbis / Opus）
  if (ascii(0, 4) === 'OggS') {
    const head = b.toString('latin1', 0, Math.min(n, 128))
    const vi = head.indexOf('\x01vorbis')
    if (vi >= 0 && vi + 24 <= n) {
      const ch = b[vi + 11]
      const rate = b.readUInt32LE(vi + 12)
      const bitrateNom = b.readUInt32LE(vi + 20)
      return { codec: 'OGG', sampleRate: rate, channels: ch, bitrateKbps: Math.round(bitrateNom / 1000), tier: bitrateNom >= AUDIO_LOSSY_HIGH_KBPS * 1000 ? '高音质' : '标准' }
    }
    const oi = head.indexOf('OpusHead')
    if (oi >= 0 && oi + 13 <= n) {
      return { codec: 'Opus', sampleRate: b.readUInt32LE(oi + 12), channels: oi + 10 <= n ? b[oi + 9] : 0, tier: '高音质' }
    }
    return null
  }
  // M4A / MP4
  if (ascii(4, 4) === 'ftyp') {
    const m = parseM4a(b, n)
    if (m) {
      const bitrate = size > 0 && m.durationSec > 0 ? Math.round((size * 8) / m.durationSec / 1000) : 0
      return { codec: 'AAC', sampleRate: m.sampleRate, channels: m.channels, bitrateKbps: bitrate, tier: bitrate > 0 ? (bitrate >= AUDIO_LOSSY_HIGH_KBPS ? '高音质' : '标准') : '' }
    }
    return null
  }
  // WebM / EBML
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return parseEbml(b, n) || null
  }
  return null
}

/**
 * 解析音频文件头（前几十 KB）识别音质。返回
 * { codec, sampleRate?, channels?, bitDepth?, bitrateKbps?, tier? } 或 null。
 * tier 与在线一致的三档：无损 / 高音质 / 标准。`size` 为完整文件大小（M4A 估码率用）。
 * 按内容（魔数）而非扩展名识别：扩展名标错的文件如实反映真实格式。
 * 导出供测试。
 */
export function parseAudioMeta(buf, ext = '', size = 0) {
  const b = buf
  if (b.length < 8) return null
  try {
    // 带 ID3v2 前缀：可能是 MP3，也可能是「ID3 + 真实容器」（部分下载工具给 FLAC/OGG 贴 ID3）。
    // 先跳标签、按内容识别容器；识别不出再兜底扫 MPEG 帧（避免把 FLAC 数据误判成 MP3）。
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // 'ID3'
      const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
      const skip = 10 + tagSize + ((b[5] & 0x10) ? 10 : 0)
      if (skip >= b.length) return null
      const c = parseContainerAt(b, skip, size)
      if (c) return c
      const r = parseMpegFrame(b, skip)
      if (r) return { codec: 'MP3', ...r }
      return null
    }
    // 无 ID3：先容器，后裸 MPEG（无标签的 mp3）
    const c = parseContainerAt(b, 0, size)
    if (c) return c
    const r = parseMpegFrame(b, 0)
    if (r) return { codec: 'MP3', ...r }
    return null
  } catch { /* 解析失败 → null（无标签） */ }
  return null
}

// 拼成播放条标签：「格式 · 档位」（如 FLAC · 无损 / MP3 · 高音质）。分不出档时只显示格式。
export function audioQualityLabel(meta) {
  if (!meta || !meta.codec) return ''
  const name = AUDIO_CODEC_NAMES[meta.codec] || meta.codec
  return meta.tier ? name + ' · ' + meta.tier : name
}

// Books: local novel files we can read and turn into speech — plain text
// (.txt) and EPUB (a ZIP container whose spine XHTML we flatten to text).
function isBookName(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0) return false
  const ext = name.slice(i + 1).toLowerCase()
  return ext === 'txt' || ext === 'epub'
}
// Upper bound of characters sent to the TTS model in one synthesis call.
// Kept small: a 500-char chunk measured ~20-50s of synthesis (the browser shows
// "缓冲中" the whole time), while a ~150-char chunk synthesizes in ~5-10s. With
// the synthesized-audio cache below, the next chunk is generated while the
// current one plays, so smaller chunks lower first-audio latency without
// audible gaps between blocks. This caps how much text goes into ONE synthesis
// call (each chunk is synthesized separately). It is NOT the subtitle line cap:
// the client divides a chunk's text into display lines (splitSentences) and
// does not use this limit.
export const MAX_TTS_CHARS = 150

// Chinese dialogue quotes treated as atomic when splitting prose: a 。！？…； inside
// “...” / 「...」 / 『...』 must NOT cut the sentence, so the whole quoted speech
// stays together in one chunk (and reads as a single utterance).
const QUOTE_PAIRS = { '“': '”', '「': '」', '『': '』', '"': '"' }
const isQuoteOpen = (c) => Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, c)
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF
// Natural clause-pause characters: prefer breaking an over-long sentence here
// rather than hard-slicing mid-word. `，`/`、` etc. never split a quoted span.
const CLAUSE_BREAKS = '，、：；——…'

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, basename, parse as pathParse, join as pathJoin } from 'node:path'
import { inflateRawSync, inflateSync } from 'node:zlib'
import * as os from 'node:os'
import { parseFeed } from './podcast.js'

// ---- book structure parsing (title / preface / chapters / epilogue) ----
// Heuristic, rule-based parser that splits a novel's normalized text into
// sections so the reader can show a table of contents and jump to a chapter.
// Validated against a corpus of real books; see docs/book-parsing-design.md for
// the algorithm and its documented limits.
const STRUCT_CHAPTER_RE = /^第\s*[0-9一二三四五六七八九十百千万零〇]{1,5}\s*[章节回卷]/
const STRUCT_PART_RE = /^第\s*[0-9一二三四五六七八九十]{1,5}\s*(?:部|篇|集)|^(?:卷|部|篇|集|部分)\s*[0-9一二三四五六七八九十]+|^[一二三四五六七八九十]{1,4}\s*(?:部|卷|篇|集)/
const STRUCT_PREFACE_WORDS = ['前言', '自序', '序言', '序文', '代序', '引言', '楔子', '引子', '题记', '开篇', '开端', '卷首语', '卷前语', '简介', '内容简介', '内容提要', '提要', '作者简介', '出版说明', '编者按', '导读', '序']
const STRUCT_EPILOGUE_WORDS = ['尾声', '后记', '结语', '跋', '补记', '附记', '附录', '番外', '外传', '终章', '结局', '大结局']
const STRUCT_NUM_RE = /^[0-9]{1,3}[.、．\s]/
const STRUCT_CN_NUM_RE = /^[一二三四五六七八九十]{1,4}[、．. 　]/
const STRUCT_BULLET_RE = /^[◇◆●▲▪·•]/
const STRUCT_TOC_RE = /^目录/

function structClassifyLine(raw) {
  // Strip WPS/Founder typesetting codes (〖BT3〗/〖KH*2〗) and invisible leftovers
  // (private-use area, zero-width) that GBK decoding can leave after a sentence —
  // they would defeat the $ anchors below. The cleaned `text` is what becomes the
  // section heading.
  const s = raw
    .replace(/[〖【][^〗】]{0,24}[〗】]/g, '')
    .replace(/[\uE000-\uF8FF\uFFFD\u200b\u200c\u200d\u00a0\u3000]/g, '')
    .trim()
  if (s === '') return { kind: 'body', len: 0, text: '' }
  if (STRUCT_TOC_RE.test(s)) return { kind: 'toc', len: s.length, text: s }
  if (STRUCT_PART_RE.test(s)) return { kind: 'part', len: s.length, text: s }
  if (STRUCT_CHAPTER_RE.test(s)) return { kind: 'chapter', len: s.length, text: s }
  for (const w of STRUCT_PREFACE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　') || s.startsWith(w + '：') || s.startsWith(w + ':')) {
      if (s.length <= 14) return { kind: 'preface', len: s.length, text: s }
    }
  }
  for (const w of STRUCT_EPILOGUE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　')) {
      if (s.length <= 14) return { kind: 'epilogue', len: s.length, text: s }
    }
  }
  if (STRUCT_BULLET_RE.test(s) && s.length <= 25) return { kind: 'bullet', len: s.length, text: s }
  if ((STRUCT_NUM_RE.test(s) || STRUCT_CN_NUM_RE.test(s)) && s.length <= 22) return { kind: 'num', len: s.length, text: s }
  // A standalone short line with no sentence-final punctuation is a common
  // "named section" convention in Chinese literary fiction (e.g. "麻将牌").
  if (s.length >= 2 && s.length <= 12 && !/[。！？；…！？"”]$/.test(s)
    && !/[，,、：:（）()《》]/.test(s) && !/^\d+$/.test(s) && !/^[一二三四五六七八九十]+$/.test(s)
    && !/^(完|全文完|全书完|本[书卷篇]完)$/.test(s)) return { kind: 'named', len: s.length, text: s }
  return { kind: 'body', len: s.length, text: s }
}

const STRUCT_HEADING_KINDS = new Set(['chapter', 'part', 'preface', 'epilogue', 'toc', 'bullet', 'num', 'named'])

function structHeadingScore(kind, len, prevBlank, nextBlank, nextLen) {
  let s = 0
  switch (kind) {
    case 'chapter': s += 8; break
    case 'part': s += 7; break
    case 'preface': s += 7; break
    case 'epilogue': s += 7; break
    case 'toc': s += 6; break
    case 'named': s += 5; break
    case 'bullet': s += 3; break
    case 'num': s += 3; break
    default: return 0
  }
  if (len <= 6) s += 2
  else if (len <= 14) s += 1
  else if (len > 30) s -= 2
  else if (len > 50) s -= 3
  if (prevBlank || nextBlank) s += 1
  if (nextLen > 20 && nextLen > len * 1.5) s += 1
  return Math.max(0, Math.min(10, s))
}

function structStripTitle(s) { return s.replace(/[《》""「」\s]/g, '') }

function structDeriveFront(front, filenameHint) {
  let title = ''
  let author = ''
  const name = filenameHint.replace(/\.[^.]+$/, '')
  const fm = name.match(/^(.+?)\s*(?:作者|著)\s*[：:]\s*(.+)$/)
  if (fm) { title = structStripTitle(fm[1].trim()); author = fm[2].trim() }
  else { title = structStripTitle(name) }
  let t = title
  let a = author
  for (const s of front.slice(0, 6)) {
    const am = s.match(/^(?:作者|作\s*者|作者：|著\s*者)[：:]?\s*(.+)$/)
    if (am && am[1].length <= 20 && !a) { a = am[1]; continue }
    // a front line like "真相 作者：石楠" (no 《》 wrapper)
    const fam = s.match(/^(.{1,20}?)\s*(?:作者|著)\s*[：:]\s*(.{1,20})$/)
    if (fam && fam[2].trim() !== '' && !a) { t = fam[1].trim(); a = fam[2].trim(); continue }
    const pm = s.match(/^(?:出版社|出版)\s*[：:]?\s*(.+)$/)
    if (pm && pm[1].length <= 30) continue
    if (s.startsWith('《') && s.endsWith('》') && s.length <= 40) { t = s.slice(1, -1); continue }
    const bm = s.match(/^(.{1,12}?)[《]([^》]{1,40})[》]/)
    if (bm && !a) { a = bm[1].trim(); t = bm[2]; continue }
    const bm2 = s.match(/^《([^》]{1,40})》\s*(.{1,12})?$/)
    if (bm2 && !a) { t = bm2[1]; if (bm2[2] && bm2[2].trim()) a = bm2[2].trim(); continue }
    if (a === '' && !am && /^\S{1,12}$/.test(s) && !/第|序|章|[《》]/.test(s)) a = s
  }
  return { title: t || title, author: a || author }
}

/**
 * Split a novel's text into structured sections. Exported for tests.
 * Returns { title, author, sections: [{type, heading, startLine, chars, bodyLines, charStart, charLen, textStart}] }
 * where charStart/charLen are offsets in the "content" space (concatenated
 * trimmed non-blank lines), and textStart is the heading's offset in the
 * normalized input text — used to align chunk boundaries so a chapter jump is
 * exact instead of ±1 chunk.
 *
 * `metaOverride` (optional) supplies authoritative { title, author } (e.g. the
 * OPF metadata of an EPUB) that wins over the heuristic filename/front-matter
 * guess — used by the .epub branch where the real title is rarely inferable
 * from the file name alone.
 */
export function parseBookStructure(text, filenameHint = '', metaOverride = null) {
  const norm = String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  const rawLines = norm.split('\n')
  const lines = []
  let running = 0
  for (const raw of rawLines) {
    const s = raw.trim()
    const lead = raw.length - raw.trimStart().length
    lines.push({ text: raw, s, blank: s === '', off: running + lead })
    running += raw.length + 1
  }
  for (const ln of lines) if (!ln.blank) ln.cls = structClassifyLine(ln.s)

  // Pass B: mark TOC blocks (>=3 consecutive heading-like lines with no body
  // line between them) so a duplicated 目录 doesn't produce fake sections.
  let i = 0
  while (i < lines.length) {
    if (lines[i].blank || !STRUCT_HEADING_KINDS.has(lines[i].cls.kind)) { i++; continue }
    let j = i
    while (j < lines.length && !lines[j].blank && STRUCT_HEADING_KINDS.has(lines[j].cls.kind)) j++
    if (j - i >= 3) for (let k = i; k < j; k++) lines[k].cls.kind = 'toc'
    i = j
  }

  // Pass C: decide real headings via confidence score + context.
  const real = new Array(lines.length).fill(false)
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k]
    if (ln.blank) continue
    const c = ln.cls
    if (!STRUCT_HEADING_KINDS.has(c.kind)) continue
    // Printed TOCs often list each chapter on its own line followed by a page
    // number ("…/12"). If the next non-blank line ends with such a ref, this
    // heading is a TOC row — suppress it (the real chapter appears later).
    // e.g. 一个县委书记的故事.txt: "第一章 一根针执政官" → "1. 石头砸在桌面上…/1"
    if (c.kind !== 'toc') {
      let pn = k + 1
      while (pn < lines.length && lines[pn].blank) pn++
      if (pn < lines.length && /\/\d+\s*$/.test(lines[pn].s)) { c.kind = 'toc'; continue }
    }
    if (c.kind === 'toc') continue
    const prevBlank = k === 0 || lines[k - 1].blank
    const nextIdx = k + 1 < lines.length ? k + 1 : -1
    const nextBlank = nextIdx === -1 || lines[nextIdx].blank
    let nextLen = 0
    let nn = nextIdx
    while (nn !== -1 && lines[nn].blank) nn = nn + 1 < lines.length ? nn + 1 : -1
    if (nn !== -1) nextLen = lines[nn].s.length
    const score = structHeadingScore(c.kind, c.len, prevBlank, nextBlank, nextLen)
    const prevHeading = k > 0 && !lines[k - 1].blank && STRUCT_HEADING_KINDS.has(lines[k - 1].cls.kind)
    const sitsAlone = prevBlank || prevHeading
    const STRONG = c.kind === 'chapter' || c.kind === 'part' || c.kind === 'preface'
      || c.kind === 'epilogue' || c.kind === 'toc'
    // Strong headings don't need a blank line above (some books run a chapter
    // heading straight after the previous paragraph); the length penalty in
    // structHeadingScore keeps mid-paragraph long lines out.
    if (STRONG) { if (score >= 7) real[k] = true; continue }
    if (c.kind === 'named') {
      // The riskiest kind: a short standalone line could be a lyric/song quote.
      // Trust only when it sits on a blank line, the next non-blank line is a
      // long body paragraph, and the line above isn't another short line (a run
      // of short lines = lyrics/poem).
      const aboveIsNamed = k > 0 && !lines[k - 1].blank && lines[k - 1].cls.kind === 'named'
      if (!(prevBlank && nextLen > 20 && !aboveIsNamed)) continue
    }
    if (score >= 6 && sitsAlone) real[k] = true
  }

  // Pass D: group body lines under each real heading; pre-heading lines = front matter.
  const sections = []
  let front = []
  let cur = null
  const flush = () => { if (cur !== null) { sections.push(cur); cur = null } }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].blank) continue
    if (real[k]) {
      flush()
      cur = { type: lines[k].cls.kind, heading: lines[k].cls.text, startLine: k + 1, body: [], textStart: lines[k].off }
      continue
    }
    if (cur !== null) cur.body.push(lines[k].s)
    else front.push(lines[k].s)
  }
  flush()

  // char spans FIRST, so the noise gate below can judge body size.
  let charPos = 0
  for (const sec of sections) {
    sec.chars = sec.body.join('').length
    sec.bodyLines = sec.body.length
    sec.charStart = charPos
    sec.charLen = sec.heading.length + sec.chars
    charPos += sec.charLen
    delete sec.body
  }

  // Noise gate: a short standalone line opening a tiny block is usually a
  // quote / date / diary stub, not a real section — fold it back into the
  // previous section's body. Real named headings (story titles, chapter
  // sub-heads) open a substantial body, so those survive.
  const NAMED_MIN_BODY = 600
  for (let i2 = 1; i2 < sections.length; i2++) {
    const sec = sections[i2]
    if (sec.type !== 'named' || sec.chars >= NAMED_MIN_BODY) continue
    const prev = sections[i2 - 1]
    prev.chars += sec.heading.length + sec.chars
    prev.bodyLines += 1 + sec.bodyLines
    prev.charLen += sec.heading.length + sec.chars
    sections.splice(i2, 1)
    i2--
  }

  const derived = structDeriveFront(front, filenameHint)
  const meta = {
    title: (metaOverride && metaOverride.title) || derived.title,
    author: (metaOverride && metaOverride.author) || derived.author,
  }
  return {
    title: meta.title,
    author: meta.author,
    sections: sections.map((s) => ({
      type: s.type, heading: s.heading, startLine: s.startLine,
      chars: s.chars, bodyLines: s.bodyLines, charStart: s.charStart, charLen: s.charLen,
      textStart: s.textStart,
    })),
  }
}

// ---- EPUB support: minimal ZIP container reader + XHTML → plain text ----
// An EPUB is a ZIP archive whose spine (reading order) references XHTML
// chapters. We keep the plugin's zero-runtime-dependency design by reading the
// container with a small hand-rolled ZIP parser (EOCD → central directory →
// local headers) and inflating deflate entries with node:zlib — no third-party
// unzip/XML library. Only the "book file → plain text" stage is format
// specific: everything downstream (parseBookStructure → splitBookChunks → TTS)
// is text-driven and unchanged. The whole extractor is exported for tests.
const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

function normalizeZipName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
}

// Read the ZIP central directory (entry table) from a raw byte buffer.
// Returns [{ name, method, flags, compSize, uncompSize, localOffset }].
export function zipEntries(buf) {
  // EOCD signature: scan backwards over the trailing comment (max 65535 bytes).
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('不是有效的 EPUB：找不到 ZIP 中央目录')
  const entryCount = buf.readUInt16LE(eocd + 10)
  if (entryCount === 0xffff) throw new Error('不支持 ZIP64 的 EPUB')
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > buf.length) throw new Error('不是有效的 EPUB：中央目录越界')
  const entries = []
  let p = cdOffset
  for (let n = 0; n < entryCount && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== ZIP_CENTRAL) throw new Error('不是有效的 EPUB：中央目录条目损坏')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      flags: buf.readUInt16LE(p + 8),
      compSize: buf.readUInt32LE(p + 20),
      uncompSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Read + inflate one entry by name (exact match, case-insensitive fallback).
// Supports method 0 (stored) and 8 (deflate); anything else — e.g. method 99,
// the AES flag DRM'd books use — raises a clear Chinese error.
export function zipReadEntry(buf, entries, name) {
  const want = normalizeZipName(name)
  let ent = entries.find((e) => normalizeZipName(e.name) === want)
  if (ent === undefined) {
    const low = want.toLowerCase()
    ent = entries.find((e) => normalizeZipName(e.name).toLowerCase() === low)
  }
  if (ent === undefined) throw new Error('EPUB 中缺少条目: ' + name)
  const lo = ent.localOffset
  if (lo < 0 || lo + 30 > buf.length || buf.readUInt32LE(lo) !== ZIP_LOCAL) {
    throw new Error('EPUB 条目损坏: ' + ent.name)
  }
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const end = start + ent.compSize
  if (end > buf.length) throw new Error('EPUB 条目数据越界: ' + ent.name)
  const data = buf.subarray(start, end)
  if (ent.method === 0) return Buffer.from(data)
  if (ent.method === 8) {
    try { return inflateRawSync(data) }
    catch { try { return inflateSync(data) } catch { throw new Error('EPUB 条目解压失败: ' + ent.name) } }
  }
  throw new Error('不支持的 EPUB 压缩方式 ' + ent.method + ': ' + ent.name)
}

// Decode XML/XHTML bytes: UTF-8 (spec default) or UTF-16 when a BOM says so.
function decodeXmlBuf(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  return buf.toString('utf8')
}

function xmlAttr(tag, attr) {
  const m = tag.match(new RegExp('\\b' + attr + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i'))
  return m ? m[2] : ''
}

// Match an XML element's text regardless of namespace prefix: "dc:title",
// "dcterms:title", or a bare "title" all hit the same rule.
function firstXmlText(xml, tag) {
  const bare = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag
  const re = new RegExp('<[\\w-]*:?' + bare + '\\b[^>]*>([\\s\\S]*?)</[\\w-]*:?' + bare + '>', 'i')
  const m = xml.match(re)
  return m ? decodeEntities(m[1].trim()) : ''
}

// Small HTML named-entity table — enough for real-world (esp. Chinese) prose;
// unknown entities are left as-is. Numeric entities (&#...; / &#x...;) are
// decoded separately, so no full HTML spec table is needed.
const HTML_ENTITIES = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', times: '\u00d7',
  middot: '\u00b7', copy: '\u00a9', dagger: '\u2020', Dagger: '\u2021',
  emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  bull: '\u2022', sect: '\u00a7', para: '\u00b6', deg: '\u00b0', plusmn: '\u00b1',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
  laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
}
export function decodeEntities(s) {
  const fromCodePoint = (cp) => (Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '')
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]+);/g, (m, n) => (n in HTML_ENTITIES ? HTML_ENTITIES[n] : m))
}

// Block-level elements that must start a new text line (paragraphs, headings,
// list items, table cells), so extracted text looks like a plain .txt novel —
// which the line-based parseBookStructure expects.
const HTML_BLOCK_TAGS = 'p|div|h1|h2|h3|h4|h5|h6|li|ul|ol|dl|dt|dd|blockquote|pre|section|article|header|footer|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|details|summary|main|aside'
// Elements whose whole content is dropped (metadata / non-prose markup).
const HTML_DROP_TAGS = 'script|style|nav|svg|head|template|object|iframe|embed|link|meta|base|map|noscript|rp|rt|ruby'

// Convert an XHTML chapter into plain text (one paragraph per line). Well-formed
// XHTML means tags nest and close, so the whole-element and tag-stripping
// regexes are safe on real files.
export function htmlToText(html) {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '') // comments
  for (const t of HTML_DROP_TAGS.split('|')) {
    s = s.replace(new RegExp('<' + t + '(?:\\s[^>]*)?>[\\s\\S]*?</' + t + '>', 'gi'), '')
  }
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n\n')
  for (const t of HTML_BLOCK_TAGS.split('|')) {
    s = s.replace(new RegExp('<' + t + '(?:\\s[^>]*)?>', 'gi'), '\n')
    s = s.replace(new RegExp('</' + t + '>', 'gi'), '\n')
  }
  s = s.replace(/<[^>]+>/g, '') // any remaining tags (spans, links, images…)
  s = decodeEntities(s)
  // Collapse horizontal whitespace, keep paragraph breaks as single newlines.
  s = s.replace(/[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  // Drop common reading artifacts that are empty/whitespace-only lines after
  // collapsing, then return trimmed.
  return s.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n')
}

// Turn an EPUB byte buffer into plain text (spine reading order) plus the OPF
// title/author. Throws a Chinese error on malformed/DRM'd/encrypted books so
// the caller can surface it (the /book routes already map throws to 500).
export function readEpubBuffer(buf) {
  const entries = zipEntries(buf)
  const zipRead = (name) => {
    const norm = normalizeZipName(name)
    const hit = entries.some((e) => {
      const en = normalizeZipName(e.name)
      return en === norm || en.toLowerCase() === norm.toLowerCase()
    })
    return hit ? zipReadEntry(buf, entries, name) : null
  }

  // 1. container.xml → path of the package document (OPF).
  const container = zipRead('META-INF/container.xml')
  if (container === null) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const rootfile = decodeXmlBuf(container).match(/<[\w-]*:?rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i)
  if (rootfile === null) throw new Error('不是有效的 EPUB：container.xml 缺少 rootfile')
  const opfPath = rootfile[1]
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // 2. Package document: metadata + manifest + spine (reading order).
  const opfBuf = zipRead(opfPath)
  if (opfBuf === null) throw new Error('EPUB 缺少包文档: ' + opfPath)
  const opf = decodeXmlBuf(opfBuf)
  const title = firstXmlText(opf, 'dc:title')
  const author = firstXmlText(opf, 'dc:creator')

  const manifest = new Map()
  let m
  const itemRe = /<[\w-]*:?item\b[^>]*\/?>/gi
  while ((m = itemRe.exec(opf)) !== null) {
    const id = xmlAttr(m[0], 'id')
    const href = xmlAttr(m[0], 'href')
    const media = xmlAttr(m[0], 'media-type').toLowerCase()
    if (id !== '' && href !== '') manifest.set(id, { href: decodeEntities(href), media })
  }
  const spine = []
  const spineRe = /<[\w-]*:?itemref\b[^>]*\/?>/gi
  while ((m = spineRe.exec(opf)) !== null) {
    const idref = xmlAttr(m[0], 'idref')
    // linear="no" items (endnotes, footnotes, page lists) are not part of the
    // primary reading order — skip them for read-aloud.
    if (idref !== '' && xmlAttr(m[0], 'linear').toLowerCase() !== 'no') spine.push(idref)
  }

  // 3. Encrypted/DRM'd entries (META-INF/encryption.xml) — skip the spine items
  // we cannot decrypt instead of reading mojibake.
  const encrypted = new Set()
  const encBuf = zipRead('META-INF/encryption.xml')
  if (encBuf !== null) {
    const encRe = /<(?:\w+:)?CipherReference\b[^>]*URI\s*=\s*["']([^"']+)["']/gi
    let em
    while ((em = encRe.exec(decodeXmlBuf(encBuf))) !== null) {
      encrypted.add(normalizeZipName(decodeEntities(em[1])))
    }
  }

  // 4. Concatenate spine XHTML in reading order into one plain-text novel.
  const parts = []
  for (const idref of spine) {
    const item = manifest.get(idref)
    if (item === undefined) continue
    if (item.media !== '' && !/html|xhtml/.test(item.media)) continue // images/css/ncx in spine
    const href = opfDir + item.href
    if (encrypted.has(normalizeZipName(href))) continue
    const xhtmlBuf = zipRead(href)
    if (xhtmlBuf === null) continue
    const text = htmlToText(decodeXmlBuf(xhtmlBuf))
    if (text !== '') parts.push(text)
  }
  if (parts.length === 0) throw new Error('EPUB 中没有任何可朗读的正文内容')
  return { text: parts.join('\n\n'), title, author }
}

// ---- book chunking into TTS blocks ----
// Maximum length of a "clean, short" chapter heading that gets its own
// dedicated TTS chunk. Real headings are a handful of characters (e.g.
// "第一章 闪电划过星空"); anything longer is almost certainly an inline heading
// that has already swallowed the following body text (parseBookStructure
// classifies whole lines), so we refuse to isolate it — isolating would only
// move the merged body into a "heading" chunk. Keep the old merge behaviour
// for those instead.
const MAX_HEADING_CHARS = 30

// Locate where a heading ends inside a sentence segment, using two bounds and
// taking the smaller one:
//   1) the end of the heading's own line (next '\n') — exact when the heading
//      sits on its own line (the normal case);
//   2) the end of an elastic-whitespace match of the heading string against the
//      source — guards against inline headings so a short heading never
//      swallows the rest of a long paragraph.
// `heading` is the cleaned heading (WPS codes / full-width spaces already
// stripped by structClassifyLine), so source whitespace runs are treated
// elastically.
function headingEndInSegment(segText, from, heading) {
  // Bound 1: end of the heading's line in the raw segment (newlines preserved).
  const nl = segText.indexOf('\n', from)
  const lineEnd = nl === -1 ? segText.length : nl
  // Bound 2: elastic whitespace match of the heading string.
  let i = from
  let j = 0
  while (j < heading.length) {
    const hc = heading[j]
    if (/\s/.test(hc)) { j++; continue } // heading whitespace: skip (any run)
    while (i < segText.length && /\s/.test(segText[i])) i++ // source whitespace: skip
    if (i >= segText.length || segText[i] !== hc) break // mismatch → heading ends here
    i++
    j++
  }
  // Skip a trailing whitespace run so "标题　" does not keep its padding.
  while (i < segText.length && /\s/.test(segText[i])) i++
  return Math.min(lineEnd, i)
}

// Split one over-long (and already quote-atomic) sentence into pieces each
// <= MAX_TTS_CHARS. Adaptive: prefer breaking at a natural clause pause so the
// TTS halts at a comma/semicolon rather than mid-word; only hard-slice where
// there is no such break. Never cuts inside a quoted dialogue or a surrogate
// pair (so rare CJK extensions / emoji stay intact).
function splitOversize(sentence) {
  const n = sentence.length
  // Positions inside a quoted span: these are atomic, we must not cut there.
  const inQuote = new Array(n).fill(false)
  let k = 0
  while (k < n) {
    if (isQuoteOpen(sentence[k])) {
      const close = sentence.indexOf(QUOTE_PAIRS[sentence[k]], k + 1)
      if (close !== -1) {
        for (let q = k; q <= close; q++) inQuote[q] = true
        k = close + 1
        continue
      }
    }
    k++
  }
  const pieces = []
  let start = 0
  while (start < n) {
    let end = Math.min(n, start + MAX_TTS_CHARS)
    // Don't split a surrogate pair: if end lands on a low surrogate, back off one.
    if (end < n && isLowSurrogate(sentence.charCodeAt(end))) end--
    // Last natural clause break inside [start, end) that is outside quotes.
    let brk = -1
    for (let j = start; j < end; j++) {
      if (!inQuote[j] && CLAUSE_BREAKS.indexOf(sentence[j]) !== -1) brk = j
    }
    let pieceEnd
    if (brk > start) {
      pieceEnd = brk + 1
    } else {
      // No clause break in range: prefer to end the piece on the last
      // outside-quote character, so a quoted dialogue isn't split apart. Only
      // fall back to a hard slice when the whole window is inside one quote.
      let outside = -1
      for (let j = end - 1; j > start; j--) {
        if (!inQuote[j]) { outside = j; break }
      }
      pieceEnd = outside > start ? outside + 1 : Math.max(start + 1, end)
    }
    pieces.push(sentence.slice(start, pieceEnd))
    start = pieceEnd
  }
  return pieces
}

/**
 * Split prose into natural chunks (<= MAX_TTS_CHARS each). Sentences are
 * accumulated up to the cap (so each block is a few sentences of speech),
 * only closing a block when the next sentence would overflow. Paragraph
 * newlines are folded into whitespace. Quoted dialogue (“...”) is atomic — a
 * .?!…; inside the quotes never splits it, so the whole utterance stays in one
 * chunk. A single over-long sentence is split adaptively at clause pauses
 * (never inside quotes) instead of a raw hard slice at the cap.
 *
 * Optional `breaks` = sorted list of section headings, each
 * { start, text } where `start` is the heading's char offset in `text` and
 * `text` is the heading string (s.heading from parseBookStructure). A break is
 * applied at sub-segment precision: text before the break stays in the previous
 * chunk, and the heading itself opens a NEW chunk — so a chapter jump starts
 * exactly at the heading even when a divider page ("《书名》作者") shares the
 * sentence segment with it.
 *
 * A clean short heading (< = MAX_HEADING_CHARS) gets its own dedicated chunk so
 * the TTS reads the chapter title alone with a natural pause before the body;
 * long/inline-polluted headings fall back to the old merge (title + body in the
 * same chunk) so we never turn a whole paragraph into a "heading" block.
 *
 * Exported for tests (same pattern as parseBookStructure).
 * Returns { chunks, fromChunkOfBreak } where fromChunkOfBreak[i] is the chunk
 * index opened by breaks[i] (undefined if that break opened no chunk).
 */
export function splitBookChunks(text, breaks = null) {
  const chunks = []
  const fromChunkOfBreak = []
  // Sentence segments with their original char offsets in `text`. Quoted dialogue
  // (…“...”…) is atomic: a 。！？…； inside the quotes never cuts the segment, so the
  // whole dialogue stays together and the TTS reads it as a single utterance.
  const segs = []
  let segStart = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (isQuoteOpen(c)) {
      // Find this opener's closing quote; if present, the whole quoted span is
      // atomic — skip past it so nothing inside can split the segment.
      const close = text.indexOf(QUOTE_PAIRS[c], i + 1)
      if (close !== -1) { i = close + 1; continue }
      // Unmatched opener: treat as a normal character and keep scanning.
    }
    if ('。！？；…'.indexOf(c) !== -1) {
      segs.push({ s: text.slice(segStart, i + 1), start: segStart })
      segStart = i + 1
    }
    i++
  }
  if (segStart < text.length) segs.push({ s: text.slice(segStart), start: segStart })
  let cur = ''
  let curOpener = -1 // break index that opened the chunk being accumulated
  let bi = 0
  const push = () => {
    if (cur.trim().length > 0) {
      if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
      chunks.push(cur.trim())
    }
    cur = ''
    curOpener = -1
  }
  const addSentence = (rawSentence) => {
    const sentence = rawSentence.replace(/\s*\n+\s*/g, ' ').trim()
    if (sentence.length === 0) return
    if (cur.length > 0 && cur.length + sentence.length > MAX_TTS_CHARS) push()
    // A single sentence longer than the cap is split adaptively: prefer breaking
    // at a natural clause pause (，、；… ) outside quotes, only hard-slicing when
    // there is no such break. Never cut a surrogate pair or inside a dialogue.
    if (sentence.length > MAX_TTS_CHARS) {
      if (cur.length > 0) push()
      for (const piece of splitOversize(sentence)) {
        if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
        chunks.push(piece)
        curOpener = -1
      }
    } else {
      cur += sentence
    }
  }
  for (const seg of segs) {
    if (breaks && breaks.length > 0) {
      while (bi < breaks.length && breaks[bi].start < seg.start) bi++
      if (bi < breaks.length && breaks[bi].start < seg.start + seg.s.length) {
        const off = breaks[bi].start - seg.start
        if (off > 0) addSentence(seg.s.slice(0, off))
        push()
        const headingText = breaks[bi].text
        // A clean short heading gets its own dedicated chunk so the TTS reads
        // "第一章 闪电划过星空" alone with a natural pause before the body.
        // Long headings are almost certainly inline-polluted (the parser has
        // already merged the body into the heading string) — keep them merged.
        const cleanShort = typeof headingText === 'string' && headingText.length > 0 && headingText.length <= MAX_HEADING_CHARS
        if (cleanShort) {
          const hEnd = headingEndInSegment(seg.s, off, headingText)
          const headingPiece = seg.s.slice(off, hEnd).trim()
          if (headingPiece.length > 0 && hEnd > off) {
            curOpener = bi // the heading chunk opens this section
            addSentence(headingPiece)
            push() // records fromChunkOfBreak[bi] = heading chunk index
            addSentence(seg.s.slice(hEnd)) // body continues in a fresh chunk
          } else {
            // Could not match the heading in the source — fall back to the
            // original behaviour (heading + body share a chunk).
            curOpener = bi
            addSentence(seg.s.slice(off))
          }
        } else {
          curOpener = bi
          addSentence(seg.s.slice(off))
        }
        bi++
        // swallow any further breaks inside this same segment (rare)
        while (bi < breaks.length && breaks[bi].start < seg.start + seg.s.length) bi++
        continue
      }
    }
    addSentence(seg.s)
  }
  push()
  if (chunks.length === 0) chunks.push(text.trim())
  return { chunks, fromChunkOfBreak }
}

// ---- LRC 歌词解析 ----
// 把标准 .lrc 解析为 [{ t, text }]（t 为秒）。支持一行多个时间戳、[offset:±ms]
// 全局偏移标签；[ti:]/[ar:]/[al:] 等元数据标签与空行直接跳过。乱序时间戳按 t 重排。
export function parseLrc(text) {
  const out = []
  let offsetS = 0
  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    // [offset:±ms] 对整个文件生效（偏移量毫秒）。
    const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/.exec(line)
    if (om !== null) { offsetS = (parseInt(om[1], 10) || 0) / 1000; continue }
    const tags = []
    let m
    TIME_RE.lastIndex = 0
    let contentStart = 0
    // 注意：exec 匹配失败后 lastIndex 会被重置为 0，所以文本起点要在循环里记录。
    while ((m = TIME_RE.exec(line)) !== null) { tags.push(m); contentStart = TIME_RE.lastIndex }
    if (tags.length === 0) continue
    const content = line.slice(contentStart).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (content === '') continue
    for (const tag of tags) {
      const min = parseInt(tag[1], 10) || 0
      const sec = parseInt(tag[2], 10) || 0
      const fracS = tag[3] !== undefined && tag[3] !== '' ? Number('0.' + tag[3]) : 0
      out.push({ t: min * 60 + sec + fracS + offsetS, text: content })
    }
  }
  out.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
  return out
}

export const name = 'dsh-music-plus'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt']

export function apply(ctx) {
  let home = null
  let musicRoot = null
  let tracks = []
  let pendingIntent = null
  let startupPromise = null

  const getHome = async () => {
    if (home !== null) return home
    try {
      // os.homedir() resolves the user's home cross-platform (Windows uses
      // C:\Users\<name>; POSIX /Users/<name> or /home/<name>). The $HOME shell
      // variable does not exist under cmd/powershell on Windows, so fall back
      // to the shell only when os.homedir() is unusable.
      const osHome = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
      if (osHome !== '') { home = osHome; return home }
    } catch { /* fall through to shell */ }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf %s "$HOME"' }))
      const value = String((result.stdout && result.stdout.text) || '').trim()
      home = value || null
    } catch {
      home = null
    }
    return home
  }
  // ---- persisted music root (survives DSH restarts) ----
  // A tiny JSON state file under the DSH home keeps the configured root across
  // process restarts; an unreadable or non-directory stored root is ignored so
  // the player falls back to the default ~/Music instead of failing to load.
  const stateFile = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/dsh-music-plus-state.json'
  }
  const loadStoredRoot = async () => {
    const file = await stateFile()
    if (file === null) return { music: null }
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      return {
        music: data && typeof data.root === 'string' && data.root !== '' ? data.root : null,
      }
    } catch {
      return { music: null }
    }
  }
  const saveRoot = async (patched) => {
    const file = await stateFile()
    if (file === null) return
    try {
      // Write directly with node:fs: the host ctx.fs service may fence writes
      // under a workspace policy, which silently dropped the state file.
      let prev = {}
      if (existsSync(file)) {
        const prevText = readFileSync(file, 'utf8')
        if (prevText.trim()) { try { prev = JSON.parse(prevText) } catch { prev = {} } }
      }
      const next = { ...prev, ...patched }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch {
      // persistence is best-effort; an unwritable state file only loses the
      // remembered directory, never breaks playback
    }
  }
  const publicTracks = () => tracks.map((t) => ({
    id: t.id, name: t.name, url: t.url, size: t.size, ext: t.ext, path: t.path,
    quality: t.quality || '',
  }))

  // ---- 自建歌单（playlists）----
  // 歌单数据独立持久化到 ~/.dsh/dsh-music-plus-playlists.json。成员以「绝对路径」为稳定键，
  // 不受曲库重扫的 id 变化影响；「我最喜欢」(pl-fav) 是系统默认歌单，首次启动自动创建。
  const FAV_PLAYLIST_ID = 'pl-fav'
  const FAV_PLAYLIST_NAME = '我最喜欢'
  let playlists = [] // [{id,name,fixed,trackPaths:[absPath],createdAt,updatedAt}]

  const playlistsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/dsh-music-plus-playlists.json'
  }
  const loadPlaylists = async () => {
    const file = await playlistsFile()
    let list = []
    if (file !== null) {
      try {
        const text = readFileSync(file, 'utf8')
        const data = JSON.parse(text)
        if (data && Array.isArray(data.playlists)) list = data.playlists
      } catch { /* unreadable -> start with the system playlist only */ }
    }
    list = list
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: p.id, name: p.name, fixed: !!p.fixed,
        trackPaths: Array.isArray(p.trackPaths)
          ? p.trackPaths.filter((x) => typeof x === 'string' && x !== '')
          : [],
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
      }))
    // 系统默认歌单「我最喜欢」恒存在（固定第二位）。
    if (!list.some((p) => p.id === FAV_PLAYLIST_ID)) {
      list.unshift({ id: FAV_PLAYLIST_ID, name: FAV_PLAYLIST_NAME, fixed: true, trackPaths: [], createdAt: Date.now(), updatedAt: Date.now() })
    }
    playlists = list
  }
  const savePlaylists = async () => {
    const file = await playlistsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, playlists }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }
  const findPlaylist = (id) => playlists.find((p) => p.id === id) || null

  // ---- 播放偏好持久化（volume / mode / playback / 面板 / 频谱 / 沉浸感）----
  // 这些状态原本存在浏览器 localStorage，而 localStorage 按「源(origin)」隔离。
  // dsh-desktop 每次启动给 Harness Web 服务分配一个随机端口，导致源每次变化、
  // localStorage 每次都读不到——重启后音量/播放顺序/上次播放内容全丢。现在
  // 所有持久化状态统一存 Host 端文件（DSH_HOME 固定不变，DSH 进程重启不丢），
  // 客户端启动时 GET /prefs 以快照为准恢复，改动经 POST /prefs 合并写回。
  // 值一律以字符串存储，与客户端 loadPref 对齐。
  let serverPrefs = {} // { 'dsh-music-volume': '0.8', 'dsh-music-mode': 'order', ... }
  const PREF_ALLOW = new Set([
    'dsh-music-mode', 'dsh-music-volume', 'dsh-music-scope',
    'dsh-music-panel-pos', 'dsh-music-playback',
    'dsh-music-show-viz', 'dsh-music-show-progress',
    'dsh-music-show-quality', 'dsh-music-show-bar-bg',
    'dsh-music-immerse',
    // 频谱样式：柱状图/波形图（与客户端 PREF_KEYS 对齐，漏掉同样会被 sanitizePrefs
    // 静默丢弃 → 刷新后频谱样式重置回柱状图）。
    'dsh-music-viz-mode',
  ])
  const VIZ_MODE_ALLOW = new Set(['bars', 'wave'])
  const PREF_VALUE_MAX = 256 * 1024
  const sanitizePrefs = (input) => {
    const out = {}
    if (!input || typeof input !== 'object') return out
    for (const k of Object.keys(input)) {
      if (!PREF_ALLOW.has(k)) continue
      const v = input[k]
      if (typeof v !== 'string' || v === '' || v.length > PREF_VALUE_MAX) continue
      if (k === 'dsh-music-volume') {
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        out[k] = String(Math.min(1, Math.max(0, n)))
        continue
      }
      if (k === 'dsh-music-immerse') {
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        out[k] = String(Math.min(1, Math.max(0, n)))
        continue
      }
      if (k === 'dsh-music-mode') {
        if (v !== 'single' && v !== 'order' && v !== 'shuffle') continue
        out[k] = v
        continue
      }
      if (k === 'dsh-music-viz-mode') {
        // 枚举校验：只接受 bars / wave，脏数据丢弃。
        if (!VIZ_MODE_ALLOW.has(v)) continue
        out[k] = v
        continue
      }
      out[k] = v
    }
    return out
  }
  const prefsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/dsh-music-plus-prefs.json'
  }
  const loadPrefs = async () => {
    const file = await prefsFile()
    serverPrefs = {}
    if (file === null) return serverPrefs
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      if (data && typeof data === 'object' && data.prefs && typeof data.prefs === 'object') {
        serverPrefs = sanitizePrefs(data.prefs)
      }
    } catch { /* 不可读 -> 空 */ }
    return serverPrefs
  }
  const savePrefs = async () => {
    const file = await prefsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 2, prefs: serverPrefs }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  // 把歌单成员（绝对路径）解析为可播放对象；文件已删/不可读 -> null（计入 missing）。
  // 读取音频文件头解析音质（按路径缓存，曲库扫描与歌单成员共用，避免重复读盘）。
  // 返回 { codec, sampleRate, ..., label } 或 null（不可读/无法识别 → 无音质标签）。
  // MP3/FLAC 若带超大 ID3v2 标签（如内嵌大封面），真实容器/首帧会被推到 64KB 之后——
  // 一次性连续读取「标签 + 其后一段」，保证解析器的偏移与文件偏移对齐。
  const audioMetaCache = {}
  const readAudioMeta = (absPath, size) => {
    if (audioMetaCache[absPath] !== undefined) return audioMetaCache[absPath]
    let meta = null
    try {
      const fd = openSync(absPath, 'r')
      try {
        const first = Buffer.alloc(AUDIO_HEADER_LEN)
        const got = readSync(fd, first, 0, AUDIO_HEADER_LEN, 0)
        let header = first.subarray(0, got)
        if (got >= 10 && first[0] === 0x49 && first[1] === 0x44 && first[2] === 0x33) { // 'ID3'
          const tagSize = ((first[6] & 0x7f) << 21) | ((first[7] & 0x7f) << 14) | ((first[8] & 0x7f) << 7) | (first[9] & 0x7f)
          const tagEnd = 10 + tagSize + ((first[5] & 0x10) ? 10 : 0)
          if (tagEnd > got && size > 0 && tagEnd < size) {
            const want = Math.min(tagEnd + AUDIO_HEADER_LEN, size)
            const full = Buffer.alloc(want)
            const got2 = readSync(fd, full, 0, want, 0)
            header = full.subarray(0, got2)
          }
        }
        const parsed = parseAudioMeta(header, '', size)
        if (parsed) meta = { ...parsed, label: audioQualityLabel(parsed) }
      } finally { closeSync(fd) }
    } catch { /* 不可读/损坏 → 无标签 */ }
    audioMetaCache[absPath] = meta
    return meta
  }

  const resolvePlaylistMember = (path) => {
    try {
      const st = statSync(path)
      if (!st.isFile()) return null
      return {
        id: 'p:' + path,
        name: basename(path),
        url: '/dsh-music-plus/file?path=' + encodeURIComponent(path),
        size: st.size || 0,
        path,
        quality: (readAudioMeta(path, st.size || 0) || {}).label || '',
      }
    } catch { return null }
  }
  const publicPlaylist = (p) => {
    const members = p.trackPaths.map(resolvePlaylistMember).filter(Boolean)
    return {
      id: p.id, name: p.name, fixed: p.fixed,
      count: members.length,
      missing: p.trackPaths.length - members.length,
      tracks: members,
    }
  }
  const publicPlaylists = () => playlists.map(publicPlaylist)
  // /dsh-music-plus/file 只放行已登记路径（歌单成员 ∪ 曲库扫描集），防任意文件访问。
  const isRegisteredAudioPath = (path) => {
    const inPlaylist = playlists.some((p) => p.trackPaths.includes(path))
    const inLibrary = tracks.some((t) => t.path === path)
    return inPlaylist || inLibrary
  }

  // ---- 播客：订阅 RSS/Atom 订阅源，在线播放各集音频 ----
  let podcasts = [] // [{ id, url, title, description, image, episodes:[{title,url,duration,pubDate,description,image,guid}], addedAt, refreshedAt, err }]
  const PODCAST_EPISODE_MAX = 300
  // 播客「断点续播」专用：独立于 prefs flush 的即时持久化通道，避免被本地音乐覆盖。
  let podPlay = null // { podId, epIdx, name, position, duration, ts, queue, queueSource }
  const podPlayFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/dsh-music-plus-podcast-play.json'
  }
  const loadPodPlay = async () => {
    const file = await podPlayFile()
    if (file === null) return
    try { podPlay = JSON.parse(readFileSync(file, 'utf8')) } catch { podPlay = null }
  }
  const savePodPlay = async (play) => {
    const file = await podPlayFile()
    if (file === null) return
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(play, null, 2) + '\n', 'utf8') } catch { /* best-effort */ }
  }
  const podcastsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/dsh-music-plus-podcasts.json'
  }
  const loadPodcasts = async () => {
    const file = await podcastsFile()
    let list = []
    if (file !== null) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        if (data && Array.isArray(data.podcasts)) list = data.podcasts
      } catch { /* unreadable -> start empty */ }
    }
    podcasts = list
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.url === 'string')
      .map((p) => ({
        id: p.id, url: p.url, title: String(p.title || ''), description: String(p.description || ''),
        image: String(p.image || ''), addedAt: p.addedAt || 0, refreshedAt: p.refreshedAt || 0,
        err: String(p.err || ''),
        episodes: Array.isArray(p.episodes)
          ? p.episodes.filter((e) => e && typeof e === 'object' && typeof e.url === 'string')
          : [],
      }))
  }
  const savePodcasts = async () => {
    const file = await podcastsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, podcasts }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }
  const podId = () => 'pod-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
  const fetchAndParseFeed = async (feedUrl) => {
    const ctrl = new AbortController()
    const tm = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(feedUrl, { signal: ctrl.signal, headers: { 'user-agent': 'dsh-music-plus/0.7 (podcast)' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      if (!/<\s*(rss|feed|channel)\b/i.test(text)) throw new Error('不是有效的 RSS/Atom 订阅源')
      const feed = parseFeed(text)
      if (!feed.title && feed.episodes.length === 0) throw new Error('未能解析出订阅内容')
      return {
        title: feed.title || '未命名播客',
        description: feed.description || '',
        image: feed.image || '',
        episodes: feed.episodes.slice(0, PODCAST_EPISODE_MAX),
      }
    } finally {
      clearTimeout(tm)
    }
  }
  const publicPodcasts = () => podcasts.map((p) => ({
    id: p.id, url: p.url, title: p.title, description: p.description, image: p.image,
    addedAt: p.addedAt, refreshedAt: p.refreshedAt, err: p.err, episodes: p.episodes,
  }))

  const scan = async (rootPath) => {
    const target = await ctx.fs.resolve(rootPath)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') {
      throw new Error('不是有效的目录: ' + rootPath)
    }
    const rootStr = ctx.fs.processPath(target)
    const found = []
    const walk = async (dir, depth) => {
      if (depth > 4 || found.length >= 500) return
      // Tolerant listing (all entries, see listEntries): dsh-fs-local's listDir
      // aborts on the first unreadable child, so scanning a drive root (or any
      // dir with protected entries) would silently yield zero tracks.
      const entries = listEntries(dir)
      for (const entry of entries) {
        if (found.length >= 500) return
        const abs = pathJoin(dir, entry.name)
        try {
          if (entry.isDir) { await walk(abs, depth + 1); continue }
          if (isAudioName(entry.name)) {
            const st = statSync(abs)
            if (!st.isFile()) continue
            const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
            found.push({
              name: rel, path: abs, size: st.size || 0,
              ext: entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase(),
              quality: (readAudioMeta(abs, st.size || 0) || {}).label || '',
            })
          }
        } catch {
          // unreadable entry: skip it, keep walking the rest
        }
      }
    }
    await walk(rootStr, 0)
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { rootPath: rootStr, found }
  }

  const refresh = async () => {
    if (musicRoot === null) {
      tracks = []
      return { root: null, tracks: [], count: 0 }
    }
    tracks = []
    try {
      const { found } = await scan(musicRoot)
      tracks = found.map((t, i) => ({
        id: String(i), name: t.name, path: t.path, size: t.size, ext: t.ext, url: '/dsh-music-plus/' + i,
        quality: t.quality || '',
      }))
    } catch { /* keep empty */ }
    return { root: musicRoot, tracks: publicTracks(), count: tracks.length }
  }
  const init = async () => {
    const h = await getHome()
    // Use path.join so the default root uses the platform separator; on Windows
    // a bare h + '/Music' produced a mixed "C:\Users\x/Music" root.
    let root = h === null ? null : pathJoin(h, 'Music')
    const stored = await loadStoredRoot()
    // music root
    if (stored.music) {
      try {
        const target = await ctx.fs.resolve(stored.music)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') root = ctx.fs.processPath(target)
      } catch { /* keep default */ }
    }
    musicRoot = root
    await loadPlaylists()
    await loadPodcasts()
    try {
      return await refresh()
    } catch (err) {
      musicRoot = null
      tracks = []
      return { root: null, tracks: [], count: 0, error: String((err && err.message) || err) }
    }
  }
  const ensureStarted = () => { if (startupPromise === null) startupPromise = init(); return startupPromise }


  // Tolerant directory listing for the picker and the scan. dsh-fs-local's
  // listDir is all-or-nothing: one unreadable child (pagefile.sys, System
  // Volume Information, ...) aborts the entire listing, which made drive roots
  // (and any dir containing protected entries) show up empty. Enumerate with
  // node:fs instead, skip entries that cannot be stat'd, and report every
  // entry with an isDir flag so callers can filter (picker: dirs only;
  // scan: dirs to recurse + audio files to collect).
  const listEntries = (dirPath) => {
    let dirents = []
    try { dirents = readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
    const out = []
    for (const ent of dirents) {
      try {
        const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(pathJoin(dirPath, ent.name)).isDirectory())
        out.push({ name: ent.name, isDir })
      } catch {
        // unreadable entry (EPERM/EBUSY/...): skip it, keep listing the rest
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  }

  // Breadcrumb segments for an absolute native path, ordered from the root down
  // to the deepest component. Each crumb carries its cumulative path so the
  // browser picker can jump straight to any ancestor directory (and, at the
  // root crumb, back to the filesystem root). The root itself (e.g. "/" or
  // "C:\") is the leading crumb. The sentinel drive-list view has no real path,
  // so it yields no crumbs.
  const buildCrumbs = (abs) => {
    if (!abs || abs === '__drives__') return []
    const parsed = pathParse(abs)
    const root = parsed.root || ''
    const crumbs = []
    if (root) crumbs.push({ name: root, path: root })
    const parts = []
    let d = parsed.dir
    if (d && d !== root) {
      while (d && d !== root) { parts.unshift(basename(d)); d = dirname(d) }
    }
    let cur = root
    for (const p of parts) {
      cur = cur === '' ? p : pathJoin(cur, p)
      crumbs.push({ name: p, path: cur })
    }
    if (parsed.base && parsed.base !== root) {
      cur = cur === '' ? parsed.base : pathJoin(cur, parsed.base)
      crumbs.push({ name: parsed.base, path: cur })
    }
    return crumbs
  }

  // ---- shared HTTP helpers ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname
      // JSON API routes
      if (pathname === '/dsh-music-plus/manifest' && req.method === 'GET') {
        await ensureStarted()
        writeJson(res, {
          root: musicRoot, tracks: publicTracks(), count: tracks.length,
          playlists: publicPlaylists(),
        })
        return
      }
      // 手动重扫：重新遍历当前音乐目录并返回最新列表（面板「刷新」按钮调用）。
      if (pathname === '/dsh-music-plus/rescan' && req.method === 'POST') {
        await ensureStarted()
        try {
          const r = await refresh()
          writeJson(res, {
            ok: true, root: r.root,
            tracks: r.tracks, count: r.count,
            playlists: publicPlaylists(),
          })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // 播放偏好读写（volume/mode/voice/scope/panel-pos/playback/books-playback）。
      // GET 返回完整快照；POST 为合并语义：{ prefs: {k:v,...} } 写入，
      // { remove: [k,...] } 删除指定键。见 lib/index.js 的 serverPrefs 说明。
      if (pathname === '/dsh-music-plus/prefs' && req.method === 'GET') {
        await loadPrefs()
        writeJson(res, { ok: true, prefs: serverPrefs })
        return
      }
      if (pathname === '/dsh-music-plus/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        await loadPrefs()
        const patch = sanitizePrefs(body && body.prefs ? body.prefs : body)
        serverPrefs = { ...serverPrefs, ...patch }
        const remove = Array.isArray(body && body.remove)
          ? body.remove.filter((k) => typeof k === 'string' && PREF_ALLOW.has(k))
          : []
        for (const k of remove) delete serverPrefs[k]
        await savePrefs()
        writeJson(res, { ok: true, prefs: serverPrefs })
        return
      }
      if (pathname === '/dsh-music-plus/set-root' && req.method === 'POST') {
        const body = await readBody(req)
        const rawPath = body && typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') { writeJson(res, { ok: false, error: '路径不能为空' }, 400); return }
        const expanded = rawPath.startsWith('~/') ? ((await getHome()) || '') + '/' + rawPath.slice(2) : rawPath
        try {
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { ok: false, error: '目录不存在或不可读: ' + expanded }, 400)
            return
          }
          musicRoot = ctx.fs.processPath(target)
          const data = await refresh()
          await saveRoot({ root: musicRoot })
          writeJson(res, { ok: true, root: data.root, tracks: data.tracks, count: data.count })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // List the immediate subdirectories of a library-visible path, for the
      // browser directory picker used by the playback-list "选择音乐目录" button.
      // List the immediate subdirectories AND files of a library-visible path,
      // for the browser directory picker used by the playback-list
      // "选择音乐目录" button. Directories come first (their entries are
      // browsable); file entries are informational and not navigable. An
      // empty/missing path starts from the user's home directory.
      if (pathname === '/dsh-music-plus/dir' && req.method === 'GET') {
        await ensureStarted()
        const raw = url.searchParams.get('path') || ''
        try {
          // Windows has no single root that lists every drive, so expose a
          // sentinel ("__drives__") that enumerates the available drive roots.
          // Browsing "up" from a drive root (e.g. C:\) lands here so users can
          // switch to another drive.
          if (raw === '__drives__') {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            if (isWin) {
              const roots = []
              for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
                const root = letter + ':\\'
                try { if (existsSync(root)) roots.push({ name: root, path: root }) } catch {}
              }
              writeJson(res, { path: '__drives__', name: '本机磁盘', up: null, dirs: roots, files: [], crumbs: [] })
            } else {
              writeJson(res, { path: '/', name: '/', up: null, dirs: [], files: [], crumbs: buildCrumbs('/') })
            }
            return
          }
          const base = raw === '' ? ((await getHome()) || '/') : raw
          const expanded = base.startsWith('~/') ? ((await getHome()) || '') + '/' + base.slice(2) : base
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { error: '目录不存在或不可读', path: expanded }, 400)
            return
          }
          const abs = ctx.fs.processPath(target)
          // Parent / name computation must use the host filesystem's separators
          // (Windows uses "\" and drive roots like C:\, POSIX uses "/"), so do it
          // with node:path rather than guessing a separator in the browser.
          const atRoot = pathParse(abs).dir === abs
          // On Windows, "up" from a drive root goes to the drive-list sentinel so
          // users can switch drives; at the POSIX root there is nowhere to go.
          const up = atRoot
            ? (process.platform === 'win32' ? '__drives__' : null)
            : dirname(abs)
          // Tolerant listing (see listEntries): skip unreadable entries so
          // drive roots like C:\ still show their normal folders instead of an
          // empty list. Directories are offered by the picker (browsable);
          // plain files are listed after them purely as context (not navigable).
          const dirs = []
          const files = []
          for (const e of listEntries(abs)) {
            const item = { name: e.name, path: pathJoin(abs, e.name) }
            if (e.isDir) dirs.push(item); else files.push(item)
          }
          writeJson(res, { path: abs, name: basename(abs) || abs, up, dirs, files, crumbs: buildCrumbs(abs) })
        } catch (err) {
          writeJson(res, { error: String((err && err.message) || err) }, 500)
        }
        return
      }
      if (pathname === '/dsh-music-plus/intent' && req.method === 'GET') {
        const it = pendingIntent
        pendingIntent = null
        writeJson(res, it || null)
        return
      }
      // ---- 自建歌单 CRUD ----
      // POST /dsh-music-plus/playlist {name} -> 新建
      if (pathname === '/dsh-music-plus/playlist' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const name = body && typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        const id = 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        playlists.push({ id, name, fixed: false, trackPaths: [], createdAt: Date.now(), updatedAt: Date.now() })
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(findPlaylist(id)) })
        return
      }
      // POST /dsh-music-plus/playlist/rename {id,name}
      if (pathname === '/dsh-music-plus/playlist/rename' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const name = body && typeof body.name === 'string' ? body.name.trim() : ''
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        if (pl.fixed) { writeJson(res, { ok: false, error: '系统默认歌单不可重命名' }, 400); return }
        pl.name = name
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music-plus/playlist/delete {id}
      if (pathname === '/dsh-music-plus/playlist/delete' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const id = body && typeof body.id === 'string' ? body.id : ''
        const idx = playlists.findIndex((p) => p.id === id)
        if (idx < 0) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        if (playlists[idx].fixed) { writeJson(res, { ok: false, error: '系统默认歌单不可删除' }, 400); return }
        playlists.splice(idx, 1)
        await savePlaylists()
        writeJson(res, { ok: true })
        return
      }
      // POST /dsh-music-plus/playlist/add {id,paths:[...]}（去重、保序追加、跳过无效/非音频）
      if (pathname === '/dsh-music-plus/playlist/add' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = Array.isArray(body && body.paths)
          ? body.paths.filter((x) => typeof x === 'string' && x.trim() !== '')
          : []
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        let added = 0
        for (const raw of paths) {
          const p = raw.trim()
          if (!isAudioName(p) || pl.trackPaths.includes(p)) continue
          try { const st = statSync(p); if (!st.isFile()) continue } catch { continue }
          pl.trackPaths.push(p)
          added++
        }
        if (added > 0) pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, added, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music-plus/playlist/remove {id,paths:[...]}
      if (pathname === '/dsh-music-plus/playlist/remove' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = new Set(Array.isArray(body && body.paths) ? body.paths : [])
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const before = pl.trackPaths.length
        pl.trackPaths = pl.trackPaths.filter((p) => !paths.has(p))
        if (pl.trackPaths.length !== before) pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, removed: before - pl.trackPaths.length, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music-plus/playlist/clear {id}（一键清空：移出全部歌曲，含已失效；任何歌单都允许，fixed 也可清空）
      if (pathname === '/dsh-music-plus/playlist/clear' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const cleared = pl.trackPaths.length
        pl.trackPaths = []
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, cleared, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music-plus/playlist/reorder {id,paths:[...]}（全量顺序替换，补回未提及的旧成员）
      if (pathname === '/dsh-music-plus/playlist/reorder' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = Array.isArray(body && body.paths) ? body.paths.filter((x) => typeof x === 'string') : []
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const current = new Set(pl.trackPaths)
        const reordered = paths.filter((p) => current.has(p))
        for (const p of pl.trackPaths) if (!reordered.includes(p)) reordered.push(p)
        pl.trackPaths = reordered
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(pl) })
        return
      }
      // ---- 播客订阅：列表 / 订阅 / 取消 / 刷新 ----
      if (pathname === '/dsh-music-plus/podcasts' && req.method === 'GET') {
        await ensureStarted()
        await loadPodcasts()
        writeJson(res, { ok: true, podcasts: publicPodcasts() })
        return
      }
      if (pathname === '/dsh-music-plus/podcasts/add' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const feedUrl = body && typeof body.url === 'string' ? body.url.trim() : ''
        if (feedUrl === '') { writeJson(res, { ok: false, error: '订阅链接不能为空' }, 400); return }
        if (podcasts.length >= 50) { writeJson(res, { ok: false, error: '订阅源已达上限（50 个）' }, 400); return }
        if (podcasts.some((p) => p.url === feedUrl)) { writeJson(res, { ok: false, error: '已订阅该链接' }, 400); return }
        let feed
        try {
          feed = await fetchAndParseFeed(feedUrl)
        } catch (err) {
          writeJson(res, { ok: false, error: '订阅失败：' + String((err && err.message) || err) }, 502)
          return
        }
        const pod = {
          id: podId(), url: feedUrl, title: feed.title, description: feed.description,
          image: feed.image, episodes: feed.episodes, addedAt: Date.now(), refreshedAt: Date.now(), err: '',
        }
        podcasts.push(pod)
        await savePodcasts()
        writeJson(res, { ok: true, podcast: publicPodcasts().find((p) => p.id === pod.id) })
        return
      }
      if (pathname === '/dsh-music-plus/podcasts/remove' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const id = body && typeof body.id === 'string' ? body.id : ''
        const before = podcasts.length
        podcasts = podcasts.filter((p) => p.id !== id)
        await savePodcasts()
        writeJson(res, { ok: true, removed: before - podcasts.length })
        return
      }
      if (pathname === '/dsh-music-plus/podcasts/refresh' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const id = body && typeof body.id === 'string' ? body.id : ''
        const pod = podcasts.find((p) => p.id === id)
        if (pod === undefined) { writeJson(res, { ok: false, error: '订阅源不存在' }, 404); return }
        try {
          const feed = await fetchAndParseFeed(pod.url)
          pod.title = feed.title
          pod.description = feed.description
          pod.image = feed.image
          pod.episodes = feed.episodes
          pod.refreshedAt = Date.now()
          pod.err = ''
        } catch (err) {
          pod.err = String((err && err.message) || err)
        }
        await savePodcasts()
        writeJson(res, { ok: true, podcast: publicPodcasts().find((p) => p.id === id) })
        return
      }
      // ---- 播客断点续播（独立持久化通道，不走 prefs flush）----
      if (pathname === '/dsh-music-plus/podcast-play' && req.method === 'GET') {
        await loadPodPlay()
        writeJson(res, { ok: true, play: podPlay })
        return
      }
      if (pathname === '/dsh-music-plus/podcast-play' && req.method === 'POST') {
        const body = await readBody(req)
        const play = body && typeof body === 'object' ? body : null
        if (!play || typeof play.podId !== 'string' || !Number.isFinite(Number(play.epIdx))) {
          writeJson(res, { ok: false, error: 'bad play' }, 400)
          return
        }
        podPlay = {
          podId: play.podId, epIdx: Number(play.epIdx), name: String(play.name || ''),
          position: Number.isFinite(play.position) ? play.position : 0,
          duration: Number.isFinite(play.duration) && play.duration > 0 ? play.duration : 0,
          ts: Date.now(),
          queueSource: play.queueSource || null,
          queue: Array.isArray(play.queue) ? play.queue : [],
        }
        await savePodPlay(podPlay)
        writeJson(res, { ok: true, play: podPlay })
        return
      }

      // ---- 文件系统多选器：列目录 + 音频文件（歌单「添加歌曲」用）----
      // 与 /dsh-music-plus/dir 相同的浏览体验（上级/跨盘符），但额外返回音频文件供多选勾选。
      if (pathname === '/dsh-music-plus/files' && req.method === 'GET') {
        await ensureStarted()
        const raw = url.searchParams.get('path') || ''
        try {
          if (raw === '__drives__') {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            if (isWin) {
              const roots = []
              for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
                const root = letter + ':\\'
                try { if (existsSync(root)) roots.push({ name: root, path: root }) } catch {}
              }
              writeJson(res, { path: '__drives__', name: '本机磁盘', up: null, dirs: roots, files: [], crumbs: [] })
            } else {
              writeJson(res, { path: '/', name: '/', up: null, dirs: [], files: [], crumbs: buildCrumbs('/') })
            }
            return
          }
          const base = raw === '' ? ((await getHome()) || '/') : raw
          const expanded = base.startsWith('~/') ? ((await getHome()) || '') + '/' + base.slice(2) : base
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { error: '目录不存在或不可读', path: expanded }, 400)
            return
          }
          const abs = ctx.fs.processPath(target)
          const atRoot = pathParse(abs).dir === abs
          const up = atRoot ? (process.platform === 'win32' ? '__drives__' : null) : dirname(abs)
          const dirs = []
          const files = []
          for (const e of listEntries(abs)) {
            try {
              if (e.isDir) { dirs.push({ name: e.name, path: pathJoin(abs, e.name) }); continue }
              if (isAudioName(e.name)) {
                const st = statSync(pathJoin(abs, e.name))
                if (st.isFile()) {
                  files.push({ name: e.name, path: pathJoin(abs, e.name), size: st.size || 0, ext: e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() })
                }
              }
            } catch { /* skip unreadable entries */ }
          }
          writeJson(res, { path: abs, name: basename(abs) || abs, up, dirs, files, crumbs: buildCrumbs(abs) })
        } catch (err) {
          writeJson(res, { error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // ---- 通用文件流式路由（歌单成员专用，Range/seek）----
      // 只放行已登记路径（任一歌单成员 ∪ 曲库扫描集）。直接用 node:fs 读写，
      // 避免 DSH ctx.fs 对工作区外路径的围栏（与讲书读取小说文件的方式一致）。
      if (pathname === '/dsh-music-plus/file' && (req.method === 'GET' || req.method === 'HEAD')) {
        await ensureStarted()
        const rawPath = url.searchParams.get('path') || ''
        if (rawPath === '') { res.writeHead(400); res.end(); return }
        if (!isAudioName(rawPath) || !isRegisteredAudioPath(rawPath)) { res.writeHead(403); res.end(); return }
        let st
        try { st = statSync(rawPath) } catch { res.writeHead(404); res.end(); return }
        if (!st.isFile()) { res.writeHead(404); res.end(); return }
        const size = st.size || 0
        let start = 0
        let end = size - 1
        let status = 200
        const range = req.headers.range
        if (typeof range === 'string') {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
          if (m !== null && (m[1] !== '' || m[2] !== '')) {
            if (m[1] !== '') {
              start = parseInt(m[1], 10)
              end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
            } else {
              start = Math.max(size - parseInt(m[2], 10), 0)
              end = size - 1
            }
            if (!Number.isFinite(start) || start > end || start >= size) {
              res.writeHead(416, { 'Content-Range': 'bytes */' + size })
              res.end()
              return
            }
            status = 206
          }
        }
        const bytes = readFileSync(rawPath)
        const slice = bytes.slice(start, end + 1)
        const headers = {
          'Content-Type': audioType(rawPath),
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Cache-Control': 'no-store',
        }
        if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
        res.writeHead(status, headers)
        if (req.method === 'HEAD') { res.end(); return }
        res.end(slice)
        return
      }
      // audio streaming
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      // Ensure the library scan completes before resolving a track, so a
      // streaming/HEAD request that arrives before any manifest call (or at
      // startup) still finds its track instead of spuriously 404ing.
      await ensureStarted()
      const id = pathname.slice('/dsh-music-plus/'.length)
      const track = tracks.find((t) => t.id === id)
      if (track === undefined) { res.writeHead(404); res.end(); return }
      const target = await ctx.fs.resolve(track.path)
      const info = await ctx.fs.stat(target)
      if (info === undefined || info.type !== 'file' || info.size === undefined) { res.writeHead(404); res.end(); return }
      const size = info.size
      let start = 0
      let end = size - 1
      let status = 200
      const range = req.headers.range
      if (typeof range === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (m !== null && (m[1] !== '' || m[2] !== '')) {
          if (m[1] !== '') {
            start = parseInt(m[1], 10)
            end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
          } else {
            start = Math.max(size - parseInt(m[2], 10), 0)
            end = size - 1
          }
          if (!Number.isFinite(start) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + size })
            res.end()
            return
          }
          status = 206
        }
      }
      const bytes = await ctx.fs.readBytes(target, undefined, size)
      const slice = bytes.slice(start, end + 1)
      const headers = {
        'Content-Type': audioType(track.name),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
      }
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
      res.writeHead(status, headers)
      if (req.method === 'HEAD') { res.end(); return }
      res.end(slice)
    } catch (err) {
      try { res.writeHead(500); res.end() } catch {}
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-music-plus', handler: serve }), 'music-player-plus: routes')

  // ---- model tool: music_play_plus ----
  const PLAY_ACTIONS = ['play', 'pause', 'resume', 'stop', 'next', 'prev']
  const tool = {
    name: 'music_play_plus',
    description: '控制 DSH 本地音乐库的播放。播放时可按歌曲名/歌手关键词搜索并播放（不传 query 则播放第一首音乐），或按歌单名播放自建歌单（playlist 参数）；也可用 action 执行暂停/继续/停止/下一首/上一首。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '歌曲名/歌手关键词，用于搜索并播放。仅当 action 为 play（默认）时使用，可留空' },
        playlist: { type: 'string', description: '歌单名关键词，播放指定自建歌单（含默认歌单「我最喜欢」）。仅当 action 为 play（默认）时使用，优先级高于 query，可留空' },
        action: { type: 'string', enum: PLAY_ACTIONS, description: '要执行的动作：play 播放（默认）、pause 暂停、resume 继续、stop 停止、next 下一首、prev 上一首' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string' }, played: { type: 'boolean' }, kind: { type: 'string' },
          track: { type: 'string' }, matches: { type: 'number' }, count: { type: 'number' },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || (value && value.track ? '已请求播放：' + value.track : '音乐库为空') }]
      },
    },
    async execute(args) {
      await ensureStarted()
      const musicCount = tracks.length
      const action = args && typeof args.action === 'string' && PLAY_ACTIONS.includes(args.action) ? args.action : 'play'
      // 歌单播放不依赖曲库是否为空（歌单可含曲库外的本地文件），因此先于空库守卫判断。
      const playlistQuery = args && typeof args.playlist === 'string' ? args.playlist.trim().toLowerCase() : ''

      if (musicCount === 0 && playlistQuery === '') {
        const notice = '本地音乐库为空。请打开播放列表面板，点击「选择音乐目录」配置。'
        return { action, played: false, track: '', matches: 0, count: 0, notice }
      }

      // Non-play actions just relay a transport command to the browser player.
      if (action !== 'play') {
        pendingIntent = { action }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          next: '已请求播放下一首', prev: '已请求播放上一首',
        }
        const notice = labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。'
        return { action, played: false, track: '', matches: 0, count: musicCount, notice }
      }

      // play with a playlist name: play the whole playlist (priority over query).
      if (playlistQuery !== '') {
        const pools = playlists.filter((p) => p.name.toLowerCase().includes(playlistQuery))
        const hit = playlists.find((p) => p.name.toLowerCase() === playlistQuery) || pools[0]
        if (hit === undefined) {
          const names = playlists.map((p) => p.name).join('、') || '（暂无歌单）'
          return { action, played: false, track: '', matches: 0, count: 0, notice: '没有找到歌单「' + (args && args.playlist) + '」。现有歌单：' + names }
        }
        const members = publicPlaylist(hit).tracks
        if (members.length === 0) {
          return { action, played: false, track: '', matches: 0, count: 0, notice: '歌单「' + hit.name + '」为空，请先在播放面板该歌单里点「添加歌曲」加入音乐。' }
        }
        pendingIntent = { action: 'play', playlistId: hit.id, playlistName: hit.name, id: members[0].id, name: members[0].name }
        return {
          action, played: true, track: members[0].name, matches: members.length, count: members.length,
          notice: '已请求播放歌单「' + hit.name + '」（' + members.length + ' 首）。若被拦截请点 ▶ 解锁。',
        }
      }

      // play: search local music tracks by name/artist.
      const query = args && typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const musicPool = query === '' ? tracks : tracks.filter((t) => t.name.toLowerCase().includes(query))

      // Empty query: play the first available track.
      if (query === '') {
        const pick = tracks[0]
        pendingIntent = { action: 'play', id: pick.id, name: pick.name }
        return {
          action, played: true, track: pick.name, matches: tracks.length, count: musicCount,
          notice: '已请求播放「' + pick.name + '」。浏览器可能拦截自动播放，请在页面播放条上点击一次▶解锁。',
        }
      }

      if (musicPool.length === 0) {
        const notice = '没有找到包含「' + (args && args.query) + '」的音乐（共 ' + musicCount + ' 首）。'
        return { action, played: false, track: '', matches: 0, count: musicCount, notice }
      }
      // Prefer an exact (case-insensitive) filename match over the first substring hit.
      const pick = tracks.find((t) => t.name.toLowerCase() === query) || musicPool[0]
      pendingIntent = { action: 'play', id: pick.id, name: pick.name }
      return {
        action, played: true, track: pick.name, matches: musicPool.length, count: musicCount,
        notice: '已请求播放「' + pick.name + '」（匹配 ' + musicPool.length + ' / 共 ' + musicCount + ' 首）。浏览器可能拦截自动播放，请在页面播放条上点击一次▶解锁。',
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'music-player-plus: music_play_plus tool')

  // ---- light prompt hint so the agent knows it can play local music ----
  ctx.systemPrompt.section({
    name: 'tool:music-player-plus', order: 116,
    text: '本机已挂载 DSH音乐播放器：可用 music_play_plus 工具按关键词播放 ~/Music（或设置的目录）里的音乐，或按歌单名播放自建歌单（playlist 参数）；并支持 action 暂停/继续/停止/下一首/上一首。',
  })

  void ensureStarted()
}
