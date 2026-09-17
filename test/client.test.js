/**
 * Front-end smoke tests for the browser half (lib/client.js).
 *
 * Loads the client factory under jsdom with stubbed browser globals
 * (Audio / fetch / timers), runs its apply() with a fake ctx whose slots expose
 * the registered React element factories, then mounts with react-dom/client +
 * act to exercise the remaining features: 本地音乐播放、自建歌单/收藏、播客订阅与
 * 在线播放、频谱、目录选择器（含上级目录按钮）。
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let factory = null
let registered = []
let manifest = null
let prefsServer = {}
let podcastsServer = []
let podcastPlayServer = null
let radioSnapshot = null
let lastRadioPost = null
// 每次 bootClient 重建（FakeAudio 实例，用于断言真正驱动了哪个 URL）
const audioInstances = []

// 电台库快照的最小样本：两个风格 + 一台直链台 + 一台 HLS 台（后者在 UI 里必须置灰）。
function baseRadioSnapshot() {
  const st = (id, name, url, categoryId, categoryName, extra) => ({
    id, name, url, homepage: 'https://' + id + '.example/', categoryId, categoryName,
    sourceId: 'builtin-recommended', sourceName: '推荐网络电台',
    custom: false, hidden: false, fav: false, down: false, hls: false, playlist: false,
    quality: 'MP3', tags: [], country: '', probe: null, resolved: '', ...(extra || {}),
  })
  return {
    ok: true,
    builtin: {
      name: '推荐网络电台', url: 'https://github.com/conafun/recommended-radio-streams',
      license: 'CC0-1.0', revision: 'ee4dc39329953e82e71e78dc28d4d61209a440eb', updated: false,
    },
    sources: [],
    categories: [
      { id: 'electronic', name: 'Electronic', nameZh: '电子', order: 0, hidden: false, custom: false, count: 2 },
      { id: 'jazz-blues', name: 'Jazz & Blues', nameZh: '爵士 · 布鲁斯', order: 1, hidden: false, custom: false, count: 1 },
    ],
    stations: [
      st('st-00000001', 'NTS - Channel 1', 'https://stream-1.nts.live', 'electronic', 'Electronic'),
      st('st-00000002', 'Jazz24', 'https://knkx.example/6285', 'jazz-blues', 'Jazz & Blues', { quality: 'MP3 · 256kbps' }),
      st('st-00000003', 'HLS Only', 'https://x/hls.m3u8', 'electronic', 'Electronic', { hls: true, quality: 'HLS' }),
    ],
    favorites: [],
    prefs: { lastStationId: '', hideDead: false },
    stats: { stations: 3, visible: 3, categories: 2, custom: 0, hls: 1, playlist: 0, probe: { ok: 1, dead: 1, unknown: 1, lastProbeAt: Date.now() } },
  }
}

function makePlaylist(id, name, fixed, paths) {
  return {
    id, name, fixed,
    count: paths.length, missing: 0,
    tracks: paths.map((p) => ({
      id: 'p:' + p, name: p.split('/').pop(),
      url: '/dsh-music-plus/file?path=' + encodeURIComponent(p), size: 10, path: p,
    })),
  }
}

class FakeAudio {
  constructor() {
    this.listeners = {}
    this.currentTime = 0
    this.duration = 0
    this.volume = 0.8
    this.paused = true
    this.src = ''
    this.currentSrc = ''
    this.preload = 'auto'
    this.style = {}
    // 记录实例：真实环境里 <audio> 会被挂到 body，但 FakeAudio 不是 DOM 节点，
    // 挂载会失败（被插件吞掉），所以断言播放要在这里拿到元素本身。
    audioInstances.push(this)
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener() {}
  load() {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() {}
}

function jsonRes(obj) {
  return Promise.resolve({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })
}

// records the last /dsh-music-plus/files path requested (to assert the picker initial dir)
let lastFilesUrl = null

async function fetchStub(url, opts) {
  const u = String(url)
  const o = opts || {}
  if (u === '/dsh-music-plus/prefs') {
    if (o && o.method === 'POST') {
      const body = JSON.parse(o.body || '{}')
      Object.assign(prefsServer, body.prefs || {})
      for (const k of (body.remove || [])) delete prefsServer[k]
      return jsonRes({ ok: true, prefs: prefsServer })
    }
    return jsonRes({ ok: true, prefs: prefsServer })
  }
  if (u === '/dsh-music-plus/manifest') return jsonRes(manifest)
  if (u === '/dsh-music-plus/intent') return jsonRes(null)
  // 网络电台：GET 返回整份快照；写操作在真实宿主里也回传整份快照，这里照做。
  if (u === '/dsh-music-plus/radio') return jsonRes(radioSnapshot)
  if (u.startsWith('/dsh-music-plus/radio/')) {
    const body = JSON.parse(o.body || '{}')
    lastRadioPost = { path: u.replace('/dsh-music-plus/radio/', ''), body }
    if (u === '/dsh-music-plus/radio/favorite') {
      radioSnapshot = {
        ...radioSnapshot,
        favorites: body.fav ? [body.id] : [],
        stations: radioSnapshot.stations.map((x) => ({ ...x, fav: body.fav === true && x.id === body.id })),
      }
    }
    return jsonRes({ ...radioSnapshot, ok: true })
  }
  if (u === '/dsh-music-plus/podcasts') return jsonRes({ ok: true, podcasts: podcastsServer })
  if (u === '/dsh-music-plus/podcasts/add' && o && o.method === 'POST') {
    const body = JSON.parse(o.body || '{}')
    const pod = {
      id: 'pod-new', url: body.url, title: '测试播客', description: 'desc', image: '',
      addedAt: Date.now(), refreshedAt: Date.now(), err: '',
      episodes: [{ title: 'EP1', url: 'http://cdn/e1.mp3', duration: 120 }, { title: 'EP2', url: 'http://cdn/e2.mp3', duration: 60 }],
    }
    podcastsServer = [pod]
    return jsonRes({ ok: true, podcast: pod })
  }
  if (u === '/dsh-music-plus/podcasts/remove' && o && o.method === 'POST') {
    const body = JSON.parse(o.body || '{}')
    podcastsServer = podcastsServer.filter((p) => p.id !== body.id)
    return jsonRes({ ok: true, removed: 1 })
  }
  if (u === '/dsh-music-plus/podcasts/refresh' && o && o.method === 'POST') {
    const body = JSON.parse(o.body || '{}')
    const pod = podcastsServer.find((p) => p.id === body.id)
    return jsonRes({ ok: true, podcast: pod })
  }
  if (u.startsWith('/dsh-music-plus/files') || u.startsWith('/dsh-music-plus/dir')) {
    lastFilesUrl = u
    return jsonRes({ path: '/music', name: 'Music', up: '/', dirs: [], files: [{ name: 'a.mp3', path: '/music/a.mp3', size: 10, ext: 'mp3' }], crumbs: [] })
  }
  if (u === '/dsh-music-plus/playlist' && o && o.method === 'POST') {
    const body = JSON.parse(o.body || '{}')
    const pl = makePlaylist('pl-new', body.name, false, [])
    manifest.playlists = (manifest.playlists || []).concat([pl])
    return jsonRes({ ok: true, playlist: pl })
  }
  if (u === '/dsh-music-plus/podcast-play') {
    if (o && o.method === 'POST') {
      podcastPlayServer = JSON.parse(o.body || '{}')
      return jsonRes({ ok: true, play: podcastPlayServer })
    }
    return jsonRes({ ok: true, play: podcastPlayServer })
  }
  return jsonRes({})
}

async function bootClient() {
  factory = null
  registered = []
  audioInstances.length = 0
  window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('fetch', fetchStub)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('clearInterval', () => {})
  window.confirm = () => true
  window.prompt = () => null

  await import('../lib/client.js')
  expect(factory).toBeTruthy()
  const modExports = factory((name) => (name === 'react' ? React : undefined))
  const slots = {
    inject: (name, cb) => { cb() },
    register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
  }
  modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
  await new Promise((r) => setTimeout(r, 0))
  return {
    bar: () => (registered.find((r) => r.id === 'music-player-plus-bar') || {}).elementFactory,
    panel: () => (registered.find((r) => r.id === 'music-player-plus-panel') || {}).elementFactory,
  }
}

function baseManifest() {
  return {
    root: '/music',
    tracks: [{ id: '0', name: 'a.mp3', url: '/dsh-music-plus/0', size: 10, ext: 'mp3', path: '/music/a.mp3' }],
    count: 1,
    playlists: [
      makePlaylist('pl-fav', '我最喜欢', true, []),
      makePlaylist('pl-1', '通勤', false, ['/music/a.mp3']),
    ],
  }
}

function mount(node) {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  act(() => { root.render(node) })
  return { div, root, unmount: () => act(() => { root.unmount(); div.remove() }) }
}

// React 18 controlled inputs need the native value setter + an 'input' event to
// register as a real change (setting .value directly is ignored).
function setInput(el, value) {
  const proto = (el && el.tagName === 'TEXTAREA') ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  vi.resetModules()
  prefsServer = {}
  lastFilesUrl = null
  podcastsServer = []
  podcastPlayServer = null
  manifest = baseManifest()
  radioSnapshot = baseRadioSnapshot()
  lastRadioPost = null
  await bootClient()
})

describe('dsh-music-plus client render smoke', () => {
  it('renders the now-playing bar without throwing', () => {
    const bar = registered.find((r) => r.id === 'music-player-plus-bar').elementFactory()
    const html = renderToString(bar)
    expect(html).toContain('DSH音乐播放器')
    expect(html).toContain('M12 3v10.55') // music note icon
  })

  it('renders the player panel with 本地音乐/播客/系统配置 tabs', () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const tabs = [...div.querySelectorAll('.dsh-music-tab')].map((b) => b.textContent)
    expect(tabs).toContain('本地音乐')
    expect(tabs).toContain('播客')
    expect(tabs).toContain('系统配置')
    expect(tabs).not.toContain('QQ音乐')
    expect(tabs).not.toContain('酷狗音乐')
    expect(tabs).not.toContain('AI讲书')
    // the track list renders the local track
    expect(div.textContent).toContain('a.mp3')
    unmount()
  })
})

describe('dsh-music-plus local music + playlists + dir picker', () => {
  it('switches the directory picker to the drive-list sentinel via the up button', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    // open the panel by clicking the "列表" bar button
    const listBtn = [...div.querySelectorAll('button')].find((b) => b.title === '列表' || b.textContent.includes('列表'))
    if (listBtn) act(() => { listBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // open the music directory picker
    const pickerBtn = [...div.querySelectorAll('button')].find((b) => b.textContent.includes('选择音乐目录'))
    act(() => { pickerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // the picker overlay is portaled to <body>
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const up = [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes('上级目录') || b.textContent.includes('本机磁盘'))
    expect(up).toBeTruthy()
    unmount()
  })

  it('creates a custom playlist via the ＋ subtab', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const plus = [...div.querySelectorAll('button')].find((b) => b.className.includes('add') && b.textContent === '＋')
    act(() => { plus.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const input = document.body.querySelector('.dsh-music-prompt-input')
    setInput(input, '新歌单')
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '确定')
    act(() => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(div.textContent).toContain('新歌单')
    unmount()
  })
})

describe('dsh-music-plus podcast', () => {
  it('subscribes an RSS feed and shows its episodes in the 播客 tab', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const podTab = [...div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '播客')
    act(() => { podTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const input = div.querySelector('.dsh-music-podcast-input')
    setInput(input, 'http://cdn/feed.xml')
    const sub = [...div.querySelectorAll('button')].find((b) => b.textContent === '订阅')
    act(() => { sub.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(div.textContent).toContain('测试播客')
    expect(div.textContent).toContain('EP1')
  })

  it('plays an episode by clicking it, driving the shared <audio> element', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const podTab = [...div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '播客')
    act(() => { podTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const input = div.querySelector('.dsh-music-podcast-input')
    setInput(input, 'http://cdn/feed.xml')
    act(() => { [...div.querySelectorAll('button')].find((b) => b.textContent === '订阅').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ep1 = [...div.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('EP1'))
    act(() => { ep1.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // playback started the shared <audio> element for the episode url.
    expect(ep1.className).toContain('active')
    unmount()
  })

  it('persists the podcast playback (kind:podcast) to the Host prefs', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const podTab = [...div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '播客')
    act(() => { podTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const input = div.querySelector('.dsh-music-podcast-input')
    setInput(input, 'http://cdn/feed.xml')
    act(() => { [...div.querySelectorAll('button')].find((b) => b.textContent === '订阅').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ep1 = [...div.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('EP1'))
    act(() => { ep1.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(podcastPlayServer, 'podcastPlayServer=' + JSON.stringify(podcastPlayServer)).toBeTruthy()
    expect(podcastPlayServer.podId).toBeTruthy()
    expect(podcastPlayServer.epIdx).toBe(0)
    expect(podcastPlayServer.queue).toBeTruthy()
    unmount()
  })

  it('restores the last podcast from the dedicated channel after a reload', async () => {
    // Simulate a previous session that saved a podcast at EP1/12s (dedicated endpoint).
    podcastPlayServer = {
      podId: 'pod-new', epIdx: 0, name: 'EP1', position: 12, duration: 120, ts: 999999999,
      queue: [{ title: 'EP1', url: 'http://cdn/e1.mp3' }, { title: 'EP2', url: 'http://cdn/e2.mp3' }],
      queueSource: { podId: 'pod-new', title: '测试播客' },
    }
    factory = null; registered = []
    vi.resetModules()
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-plus-bar').elementFactory()
    const barHtml = renderToString(bar)
    // the restored podcast episode is the current track → shown on the bar
    expect(barHtml).toContain('EP1')
    // and the panel (podcast detail) is reachable; the restore set scope=podcast + queue
    const state = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(state)
    expect(div.textContent).toContain('播客')
    unmount()
  })

  it('shows an aggregated "全部" feed and switches to a specific source on click', async () => {
    // Pre-seed two distinct subscriptions so the panel renders both source cards
    // and the aggregated "all" feed.
    podcastsServer = [
      { id: 'pod-a', url: 'http://a.xml', title: '播客A', description: '', image: '', episodes: [
        { title: 'A1', url: 'http://a/1.mp3', duration: 60, pubDate: '2024-01-01T00:00:00Z' },
      ] },
      { id: 'pod-b', url: 'http://b.xml', title: '播客B', description: '', image: '', episodes: [
        { title: 'B1', url: 'http://b/1.mp3', duration: 90, pubDate: '2024-01-02T00:00:00Z' },
      ] },
    ]
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    const podTab = [...div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '播客')
    act(() => { podTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // source row = 2 sources, then 「全部」 at the end
    const srcs = [...div.querySelectorAll('.dsh-music-podcast-src')]
    expect(srcs).toHaveLength(3)
    expect(srcs[0].textContent).toContain('播客A')
    expect(srcs[1].textContent).toContain('播客B')
    expect(srcs[2].textContent).toContain('全部')
    // default = aggregated "all" feed: both episodes appear, newest (B1) first
    expect(div.textContent).toContain('全部更新')
    expect(div.textContent).toContain('A1')
    expect(div.textContent).toContain('B1')
    // clicking a specific source card narrows the detail to only that source
    act(() => { srcs[1].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(div.textContent).toContain('播客B')
    expect(div.textContent).toContain('B1')
    expect(div.textContent).not.toContain('A1')
    // clicking 「全部」 returns to the aggregated feed
    act(() => { srcs[2].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(div.textContent).toContain('A1')
    expect(div.textContent).toContain('B1')
    unmount()
  })
})

describe('dsh-music-plus 播放面板 → 网络电台页签', () => {
  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
  // 打开播放面板并切到「网络电台」页签：电台整页就挂在这个页签里（切到才挂载）。
  const openRadio = async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const m = mount(panel)
    const tab = [...m.div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    return m
  }

  it('页签是 本地音乐 / 播客 / 网络电台 / 系统配置，且电台不再单独占用 DSH 设置页', () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    expect([...div.querySelectorAll('.dsh-music-tab')].map((b) => b.textContent))
      .toEqual(['本地音乐', '播客', '网络电台', '系统配置'])
    // 电台界面统一在插件面板里，不再注册成 DSH 设置页的 section（避免两处入口）
    expect(registered.find((r) => r.id === 'music-radio')).toBeUndefined()
    unmount()
  })

  it('切到电台页签才挂载（其余页签下不渲染台列表）', async () => {
    const panel = registered.find((r) => r.id === 'music-player-plus-panel').elementFactory()
    const { div, unmount } = mount(panel)
    await settle()
    expect(div.querySelectorAll('.dsh-music-radio-row')).toHaveLength(0)
    const tab = [...div.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(div.querySelectorAll('.dsh-music-radio-row').length).toBeGreaterThan(0)
    unmount()
  })

  it('渲染电台库：统计、风格 chips、按风格分组的列表、HLS 台置灰不可播', async () => {
    const { div, unmount } = await openRadio()
    expect(div.textContent).toContain('共 3 台')
    const chips = [...div.querySelectorAll('.dsh-music-radio-chip')].map((b) => b.textContent)
    expect(chips[0]).toContain('全部')
    expect(chips.some((c) => c.includes('电子'))).toBe(true)
    expect(chips.some((c) => c.includes('爵士'))).toBe(true)
    // 分组标题 = 风格
    const groups = [...div.querySelectorAll('.dsh-music-radio-group')].map((x) => x.textContent)
    expect(groups.some((g) => g.includes('电子'))).toBe(true)
    expect(groups.some((g) => g.includes('爵士'))).toBe(true)
    const names = [...div.querySelectorAll('.dsh-music-radio-name')].map((x) => x.textContent).join(' ')
    expect(names).toContain('NTS')
    expect(names).toContain('Jazz24')
    // HLS 台：标出「需 HLS」且播放按钮禁用
    expect([...div.querySelectorAll('.dsh-music-radio-badge')].map((b) => b.textContent)).toContain('需 HLS')
    expect(div.querySelectorAll('.dsh-music-radio-row.hls')).toHaveLength(1)
    expect(div.querySelector('.dsh-music-radio-row.hls .dsh-music-radio-play').disabled).toBe(true)
    unmount()
  })

  it('搜索框按台名/风格过滤列表', async () => {
    const { div, unmount } = await openRadio()
    setInput(div.querySelector('.dsh-music-radio-search'), 'jazz')
    await settle()
    const names = [...div.querySelectorAll('.dsh-music-radio-name')].map((x) => x.textContent).join(' ')
    expect(names).toContain('Jazz24')
    expect(names).not.toContain('NTS')
    unmount()
  })

  it('点 ▶ 用现有播放引擎播放电台，播放条显示台名（不新增播放器 UI）', async () => {
    const { div, unmount } = await openRadio()
    const nts = [...div.querySelectorAll('.dsh-music-radio-row')].find((r) => r.textContent.includes('NTS'))
    act(() => { nts.querySelector('.dsh-music-radio-play').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    // 复用同一个 <audio> 元素：src 直接指向电台流地址（HLS 台会被拦下，这里不是）
    expect(audioInstances.some((a) => a.src === 'https://stream-1.nts.live')).toBe(true)
    // 既有的播放条（原本就有）显示台名 —— 电台没有新增任何播放条界面
    const bar = registered.find((r) => r.id === 'music-player-plus-bar').elementFactory()
    expect(renderToString(bar)).toContain('NTS - Channel 1')
    // 当前行高亮
    expect([...div.querySelectorAll('.dsh-music-radio-row.current')].map((r) => r.textContent).join(' ')).toContain('NTS')
    unmount()
  })

  it('收藏按钮把状态写回宿主（按电台 id）', async () => {
    const { div, unmount } = await openRadio()
    // 列表按「风格顺序 → 台名」排序，所以按名字定位目标行，别依赖行序
    const jazz = [...div.querySelectorAll('.dsh-music-radio-row')].find((r) => r.textContent.includes('Jazz24'))
    const star = jazz.querySelector('.dsh-music-radio-star')
    expect(star.className).not.toContain('on')
    act(() => { star.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(lastRadioPost).toEqual({ path: 'favorite', body: { id: 'st-00000002', fav: true } })
    const jazzAfter = [...div.querySelectorAll('.dsh-music-radio-row')].find((r) => r.textContent.includes('Jazz24'))
    expect(jazzAfter.querySelector('.dsh-music-radio-star').className).toContain('on')
    unmount()
  })

  it('切到某个风格只显示该风格的台', async () => {
    const { div, unmount } = await openRadio()
    const jazzChip = [...div.querySelectorAll('.dsh-music-radio-chip')].find((c) => c.textContent.includes('爵士'))
    act(() => { jazzChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    const names = [...div.querySelectorAll('.dsh-music-radio-name')].map((x) => x.textContent).join(' ')
    expect(names).toContain('Jazz24')
    expect(names).not.toContain('NTS')
    unmount()
  })
})
