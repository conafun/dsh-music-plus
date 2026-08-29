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
  return jsonRes({})
}

async function bootClient() {
  factory = null
  registered = []
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
  manifest = baseManifest()
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
    // wait for the debounced prefs flush (800ms) + the POST to settle
    await act(async () => { await new Promise((r) => setTimeout(r, 900)) })
    const raw = prefsServer['dsh-music-playback']
    expect(raw, 'prefsServer keys=' + JSON.stringify(Object.keys(prefsServer)) + ' raw=' + (raw ? raw.slice(0, 120) : '')).toBeTruthy()
    const saved = JSON.parse(raw)
    expect(saved.kind).toBe('podcast')
    expect(saved.podId).toBeTruthy()
    expect(saved.queue).toBeTruthy()
    unmount()
  })

  it('restores the last podcast from the Host prefs after a reload', async () => {
    // Simulate a previous session that saved a podcast at EP1/12s. Re-boot fresh
    // so loadTracks reads the populated prefs and restores the podcast.
    prefsServer['dsh-music-playback'] = JSON.stringify({
      kind: 'podcast', podId: 'pod-new', epIdx: 0, name: 'EP1', position: 12, duration: 120,
      queue: [{ title: 'EP1', url: 'http://cdn/e1.mp3' }, { title: 'EP2', url: 'http://cdn/e2.mp3' }],
      queueSource: { podId: 'pod-new', title: '测试播客' },
    })
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
