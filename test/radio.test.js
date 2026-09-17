/**
 * 网络电台单测：解析器（lib/radio.js）+ 电台库 Host 模块（lib/radio-host.js）。
 *
 * 解析器用上游仓库的真实格式样本；Host 模块用临时目录做状态文件，不碰
 * 用户真实的 ~/.dsh。网络相关的两条路径（探活 / 清单解析）只验证「失败也优雅」，
 * 不在测试里打真实电台。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseM3U, parsePLS, parseXSPF, parseASX, parseReadmeStations, parseRadioBrowserJson,
  detectFormat, parsePlaylist, normalize, stationId, categoryId, isHlsUrl, isPlaylistUrl,
  qualityLabel,
} from '../lib/radio.js'
import { createRadio, BUILTIN_SOURCE_ID, loadBundledSnapshot } from '../lib/radio-host.js'

describe('lib/radio.js — M3U / M3U8', () => {
  it('解析上游仓库的 m3u 写法（# Group + # Homepage + #EXTINF）', () => {
    const text = [
      '#EXTM3U',
      '# Group: Jazz & Blues',
      '# Homepage: https://aardvarkbluesfm.com/',
      '#EXTINF:-1,Aardvark Blues FM',
      'http://edge4.peta.live365.net/b77280_128mp3',
      '# Homepage: https://jazz24.org/',
      '#EXTINF:-1,Jazz24',
      'https://knkx-live-a.edge.audiocdn.com/6285_256k',
      '',
    ].join('\n')
    const list = parseM3U(text)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      name: 'Aardvark Blues FM', url: 'http://edge4.peta.live365.net/b77280_128mp3',
      group: 'Jazz & Blues', homepage: 'https://aardvarkbluesfm.com/',
    })
    // 第二条的 # Homepage 覆盖了第一条，组名沿用 # Group
    expect(list[1].homepage).toBe('https://jazz24.org/')
    expect(list[1].group).toBe('Jazz & Blues')
  })

  it('兼容 IPTV 风格属性（group-title / tvg-logo）与裸 URL 行', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-logo="http://x/l.png" group-title="Electronic",NTS 1',
      'https://stream-mixtape-geo.ntslive.net/mixtape3',
      'http://bare.example/stream',
    ].join('\n')
    const list = parseM3U(text)
    expect(list[0]).toMatchObject({ name: 'NTS 1', group: 'Electronic' })
    // 没有 EXTINF 的裸 URL 行也要收，名字留空由上层兜底
    expect(list[1].url).toBe('http://bare.example/stream')
    expect(list[1].name).toBe('')
  })

  it('注释不会打断 EXTINF→URL 的配对', () => {
    const text = '#EXTINF:-1,A\n# 随便一条注释\nhttp://a/1\n'
    const list = parseM3U(text)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'A', url: 'http://a/1' })
  })
})

describe('lib/radio.js — PLS / XSPF / ASX', () => {
  it('解析 PLS（FileN/TitleN）', () => {
    const text = '[playlist]\nNumberOfEntries=2\nFile1=https://somafm.com/a256.pls\nTitle1=SomaFM A\nLength1=-1\nFile2=https://x/b\nTitle2=B\n'
    const list = parsePLS(text)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'SomaFM A', url: 'https://somafm.com/a256.pls' })
    expect(list[1].name).toBe('B')
  })

  it('解析 XSPF（title / location / annotation）', () => {
    const xml = '<?xml version="1.0"?><playlist version="1" xmlns="http://xspf.org/ns/0/">'
      + '<title>My List</title><trackList>'
      + '<track><location>https://a/1</location><title>Station A</title><annotation>https://a</annotation></track>'
      + '<track><location>https://b/2</location><title>Station B</title></track>'
      + '</trackList></playlist>'
    const list = parseXSPF(xml)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'Station A', url: 'https://a/1', homepage: 'https://a', group: 'My List' })
  })

  it('解析 ASX（entry / title / ref href）', () => {
    const xml = '<asx version="3.0"><entry><title>WMA Station</title><ref href="mms://a/1"/></entry></asx>'
    const list = parseASX(xml)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'WMA Station', url: 'mms://a/1' })
  })
})

describe('lib/radio.js — README 电台清单', () => {
  const md = [
    '# Recommended',
    '',
    '## Electronic',
    '- [NTS](https://www.nts.live/): [Channel 1](https://stream-1.nts.live) / [Channel 2](https://stream-2.nts.live)',
    '- ⭐ [Rinse](https://rinse.fm/): [Stream](https://rinse.example/live)',
    '',
    '### Jazz & Blues',
    '- [Jazz24](https://www.jazz24.org/): [Stream](https://knkx.example/6285)',
    '- [Dead One](https://dead.example/): [Stream](https://dead.example/s) *(down 2024-11)*',
    '- 一行没有流链接的说明文字',
    '',
  ].join('\n')

  it('按标题切分类，多路流自动拼「台名 - 频道名」', () => {
    const cats = parseReadmeStations(md)
    expect(cats.map((c) => c.id)).toEqual(['electronic', 'jazz-blues'])
    expect(cats[0].stations.map((s) => s.name)).toEqual(['NTS - Channel 1', 'NTS - Channel 2', 'Rinse'])
    expect(cats[0].stations[0].homepage).toBe('https://www.nts.live/')
  })

  it('识别 (down …) 失效标记，没有流链接的行被跳过', () => {
    const cats = parseReadmeStations(md)
    const jazz = cats[1]
    expect(jazz.stations).toHaveLength(2)
    expect(jazz.stations[0].down).toBe(false)
    expect(jazz.stations[1].down).toBe(true)
  })
})

describe('lib/radio.js — radio-browser JSON 与格式探测', () => {
  it('解析 radio-browser 站点 JSON', () => {
    const json = [{
      name: 'Radio X', url_resolved: 'https://x/stream', homepage: 'https://x',
      tags: ['jazz', 'smooth'], codec: 'MP3', bitrate: 128, country: 'Germany',
    }, { name: 'No URL' }]
    const list = parseRadioBrowserJson(json)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'Radio X', group: 'jazz', codec: 'MP3', bitrate: 128, country: 'Germany' })
  })

  it('detectFormat 覆盖后缀、Content-Type 与正文特征', () => {
    expect(detectFormat('http://a/b.pls')).toBe('pls')
    expect(detectFormat('http://a/b.xspf')).toBe('xspf')
    expect(detectFormat('http://a/b.json')).toBe('json')
    expect(detectFormat('http://a/list', '', '#EXTM3U\n#EXTINF:-1,X\nhttp://a/1')).toBe('m3u')
    expect(detectFormat('http://a/list', '', '[playlist]\nFile1=http://a/1')).toBe('pls')
    expect(detectFormat('http://a/readme', '', '## Jazz\n- [X](https://x): [Stream](https://x/s)')).toBe('readme')
    expect(detectFormat('http://a/stream', 'audio/mpeg', '')).toBe('unknown')
  })

  it('parsePlaylist 对未知格式回退成单条直链电台', () => {
    const r = parsePlaylist('http://a/live.mp3', 'audio/mpeg', '', 'My Station')
    expect(r.format).toBe('unknown')
    expect(r.stations).toHaveLength(1)
    expect(r.stations[0]).toMatchObject({ name: 'My Station', url: 'http://a/live.mp3' })
  })

  it('normalize 去空、去重、补字段', () => {
    const list = normalize([
      { name: 'A', url: 'http://a/1' },
      { name: 'A dup', url: 'http://a/1' },
      { name: '', url: '' },
      { name: 'B', url: '#comment' },
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'A', group: '', down: false, tags: [] })
  })

  it('stationId 由 URL 稳定派生（同一地址永远同一 id）', () => {
    expect(stationId('http://a/1')).toBe(stationId('http://a/1'))
    expect(stationId('http://a/1')).not.toBe(stationId('http://a/2'))
    expect(stationId('http://a/1')).toMatch(/^st-[0-9a-f]{8}$/)
  })

  it('categoryId 对英文出可读 slug，对中文走 hash 兜底', () => {
    expect(categoryId('Jazz & Blues')).toBe('jazz-blues')
    expect(categoryId('深夜')).toMatch(/^cat-[0-9a-f]{8}$/)
  })

  it('isHlsUrl / isPlaylistUrl / qualityLabel', () => {
    expect(isHlsUrl('https://a/b.m3u8')).toBe(true)
    expect(isHlsUrl('https://a/b.m3u')).toBe(false)
    expect(isPlaylistUrl('https://a/b.pls')).toBe(true)
    expect(isPlaylistUrl('https://a/live.mp3')).toBe(false)
    expect(qualityLabel({ codec: 'mp3', bitrate: 128 })).toBe('MP3 · 128kbps')
    expect(qualityLabel({ url: 'http://a/live.aac' })).toBe('AAC')
  })
})

describe('lib/radio-host.js — 内置库与用户层', () => {
  let dir, radio, res, state
  const mk = (extra) => createRadio({
    stateDir: async () => dir,
    writeJson: (_r, v) => { state = v },
    readBody: async () => extra || null,
  })
  const call = async (path, method = 'GET', body = null) => {
    state = null
    radio = mk(body)
    const url = new URL('http://x' + path)
    const handled = await radio.handle('/dsh-music-plus' + path.replace(/^\/dsh-music-plus/, ''), { method }, res, url)
    return { handled, out: state }
  }

  beforeEach(() => {
    dir = join(tmpdir(), 'dsh-music-radio-test-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(dir, { recursive: true })
    res = { writeHead() {}, end() {} }
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch (e) {} })

  it('内置快照被正确加载（16 风格 / 432 台）', () => {
    const snap = loadBundledSnapshot()
    expect(snap.categories).toHaveLength(16)
    expect(snap.categories.reduce((n, c) => n + c.stations.length, 0)).toBe(432)
    expect(snap.source.license).toBe('CC0-1.0')
  })

  it('GET /radio 返回完整快照', async () => {
    const { handled, out } = await call('/dsh-music-plus/radio')
    expect(handled).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.stats.stations).toBe(432)
    expect(out.categories).toHaveLength(16)
    expect(out.categories.every((c) => c.count > 0)).toBe(true)
    expect(out.builtin.revision).not.toBe('')
    // HLS 与清单型电台都要被标出来（UI 据此置灰 / 提示）
    expect(out.stats.hls).toBeGreaterThan(0)
    expect(out.stats.playlist).toBeGreaterThan(0)
  })

  it('非 /radio 路径不接管（交回 index.js 的路由）', async () => {
    const r = mk(null)
    const handled = await r.handle('/dsh-music-plus/manifest', { method: 'GET' }, res, new URL('http://x/dsh-music-plus/manifest'))
    expect(handled).toBe(false)
  })

  it('添加 / 改名 / 收藏 / 隐藏手填电台，并能在重启后恢复', async () => {
    // 添加
    let r = mk({ name: '我的台', url: 'http://example.com/live.mp3', categoryId: 'jazz-blues' })
    await r.handle('/dsh-music-plus/radio/station/add', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/station/add'))
    expect(state.ok).toBe(true)
    expect(state.stats.stations).toBe(433)
    const mine = state.stations.find((x) => x.custom)
    expect(mine).toMatchObject({ name: '我的台', categoryId: 'jazz-blues', sourceId: 'custom' })

    // 重复地址被拒
    r = mk({ name: 'dup', url: 'http://example.com/live.mp3' })
    await r.handle('/dsh-music-plus/radio/station/add', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/station/add'))
    expect(state.ok).toBe(false)

    // 状态文件落地
    expect(existsSync(join(dir, 'dsh-music-plus-radio.json'))).toBe(true)
    const raw = JSON.parse(readFileSync(join(dir, 'dsh-music-plus-radio.json'), 'utf8'))
    expect(raw.custom).toHaveLength(1)
    expect(raw.builtin).toBeNull()

    // 重新加载：手填台还在
    const again = mk(null)
    const snap = await again.snapshot()
    expect(snap.stats.stations).toBe(433)
    expect(snap.stations.find((x) => x.custom).name).toBe('我的台')
  })

  it('内置台删除=隐藏（并在「已隐藏」里可见），手填台删除=真删', async () => {
    const r = mk(null)
    const snap = await r.snapshot()
    const builtin = snap.stations.find((x) => x.sourceId === BUILTIN_SOURCE_ID)

    const r2 = mk({ id: builtin.id })
    await r2.handle('/dsh-music-plus/radio/station/remove', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/station/remove'))
    expect(state.hidden).toBe(true)
    expect(state.stations.find((x) => x.id === builtin.id).hidden).toBe(true)
    // 隐藏后台数不变（内容层没动），只是 visible 减少
    expect(state.stats.stations).toBe(432)
    expect(state.stats.visible).toBe(431)
  })

  it('分类：重命名/隐藏内置分类、新建与删除自定义分类', async () => {
    let r = mk({ id: 'jazz-blues', name: '爵士乐' })
    await r.handle('/dsh-music-plus/radio/category/update', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/category/update'))
    expect(state.categories.find((c) => c.id === 'jazz-blues').name).toBe('爵士乐')

    r = mk({ name: '深夜' })
    await r.handle('/dsh-music-plus/radio/category/add', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/category/add'))
    const custom = state.categories.find((c) => c.name === '深夜')
    expect(custom).toBeDefined()
    expect(custom.custom).toBe(true)

    r = mk({ id: custom.id })
    await r.handle('/dsh-music-plus/radio/category/remove', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/category/remove'))
    expect(state.categories.some((c) => c.id === custom.id)).toBe(false)
  })

  it('search：按台名/风格搜，点名 HLS 台时跳过，搜不到返回空', async () => {
    const r = mk(null)
    const byName = await r.search('jazz24')
    expect(byName.stations.length).toBeGreaterThan(0)
    expect(byName.stations[0].name.toLowerCase()).toContain('jazz24')
    expect(byName.stations[0].hls).toBe(false)

    const byCat = await r.search('', '爵士')
    expect(byCat.total).toBeGreaterThan(0)
    expect((await r.search('', '爵士')).stations.every((s) => !s.hls)).toBe(true)

    const none = await r.search('绝对不存在的电台名zzz')
    expect(none.stations).toHaveLength(0)
    expect(none.total).toBe(0)
  })

  it('prefs 落盘并在重启后保留', async () => {
    const r = mk({ prefs: { lastStationId: 'st-12345678', hideDead: true } })
    await r.handle('/dsh-music-plus/radio/prefs', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/prefs'))
    expect(state.prefs).toMatchObject({ lastStationId: 'st-12345678', hideDead: true })
    const snap = await mk(null).snapshot()
    expect(snap.prefs.hideDead).toBe(true)
  })

  it('未知操作返回错误而不是抛异常', async () => {
    const r = mk({})
    await r.handle('/dsh-music-plus/radio/nope', { method: 'POST' }, res, new URL('http://x/dsh-music-plus/radio/nope'))
    expect(state.ok).toBe(false)
    expect(state.error).toBeTruthy()
  })

  it('探活：连不上的地址标记为 dead 而不抛错', async () => {
    const r = mk(null)
    const snap = await r.snapshot()
    // 指向本机一个必然关闭的端口：应当快速失败并记录为 dead
    const st = snap.stations[0]
    st.url = 'http://127.0.0.1:1/nope'
    const results = await r.probe([st.id])
    expect(results).toHaveLength(1)
    expect(['dead', 'unknown']).toContain(results[0].status)
  }, 20000)
})
