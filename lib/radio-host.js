/**
 * dsh-music-plus — 网络电台 Host 半：电台库的持久化、源管理、探活与路由。
 *
 * 与播客（podcast）同构，但电台是一个「多源 + 分类」的库，所以状态模型分成两层：
 *
 *   1. 内容层（可再生成）：内置快照 lib/radio-data.json（CC0，来自
 *      conafun/recommended-radio-streams）＋ 用户添加的外部源（m3u/pls/xspf/JSON）
 *      ＋ 用户手填的单台电台。
 *   2. 用户层（不可丢）：收藏、隐藏、改名、改分类、探活结果，全部按**电台 id**
 *      （= 流地址 hash，见 radio.js 的 stationId）保存。
 *
 * 这样「从 GitHub 更新内置库」「刷新外部源」只是替换内容层，用户的收藏/隐藏/
 * 改名一律按 id 命中并保留；上游即使改版，同一台电台的 id 也不变。
 *
 * 状态文件：~/.dsh/dsh-music-plus-radio.json
 * 路由（都挂在 /dsh-music-plus 前缀下，由 lib/index.js 的 serve 分发进来）：
 *   GET  /radio                  设置页快照
 *   POST /radio/station/add|update|remove|favorite
 *   POST /radio/category/add|update|remove
 *   POST /radio/source/add|remove|refresh
 *   POST /radio/probe            探活（单台或批量）
 *   POST /radio/prefs
 *   GET  /radio/resolve?url=     把 .pls/.m3u 清单地址解析成真实流地址
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  stationId, categoryId, parsePlaylist, parseReadmeStations, isHlsUrl,
  isPlaylistUrl, normalize, qualityLabel,
} from './radio.js'

export const BUILTIN_SOURCE_ID = 'builtin-recommended'
export const BUILTIN_SOURCE_NAME = '推荐网络电台'
export const UPSTREAM_REPO = 'https://github.com/conafun/recommended-radio-streams'
export const UPSTREAM_README = 'https://raw.githubusercontent.com/conafun/recommended-radio-streams/main/README.md'
export const CUSTOM_SOURCE_ID = 'custom'
export const UNCATEGORIZED_ID = 'uncategorized'

const MAX_SOURCES = 20
const MAX_CUSTOM_STATIONS = 500
const PROBE_TIMEOUT_MS = 6000
const PROBE_CONCURRENCY = 6
const RESOLVE_TIMEOUT_MS = 8000
const FETCH_TIMEOUT_MS = 15000
const MAX_FETCH_BYTES = 4 * 1024 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-music-plus/radio'

/** 插件内置快照（lib/radio-data.json）；读不到就退化成空库，绝不抛。 */
export function loadBundledSnapshot() {
  try {
    const text = readFileSync(new URL('./radio-data.json', import.meta.url), 'utf8')
    const data = JSON.parse(text)
    if (data && Array.isArray(data.categories)) return data
  } catch { /* 打包缺失/损坏 -> 空内置库 */ }
  return {
    version: 1,
    source: { id: BUILTIN_SOURCE_ID, kind: 'builtin', name: BUILTIN_SOURCE_NAME, url: UPSTREAM_REPO, raw: UPSTREAM_README, license: 'CC0-1.0', revision: '' },
    generatedAt: '',
    categories: [],
  }
}

function clean(s, max = 300) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max)
}

function httpUrl(s) {
  const v = clean(s, 2000)
  return /^https?:\/\//i.test(v) ? v : ''
}

/** 带超时的 fetch；电台源常见「连上就不撒手」，所以必须能主动放弃。 */
async function fetchWithTimeout(url, { timeout = FETCH_TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...headers },
    })
  } finally {
    clearTimeout(timer)
  }
}

// Node 侧与浏览器侧各自有一套默认分类排序；内置库自带 order，其余按出现顺序。
function defaultOrder(list) {
  const seen = new Map()
  let n = 0
  for (const c of list) if (!seen.has(c.id)) seen.set(c.id, n++)
  return seen
}

export function createRadio(deps) {
  const { stateDir, writeJson, readBody } = deps
  const bundled = loadBundledSnapshot()

  let state = null
  let loading = null

  const emptyState = () => ({
    version: 1,
    builtin: null,          // null = 用插件内置快照；非空 = 「从 GitHub 更新」后的快照
    sources: [],            // 外部源 [{id,kind:'remote',name,url,format,addedAt,refreshedAt,categories:[],stations:[]}]
    categories: [],         // 用户自定义分类 [{id,name,order}]
    custom: [],             // 手填电台 [{id,name,url,homepage,categoryId,tags,addedAt}]
    overrides: {},          // { [stId]: {hidden,customName,categoryId,tags,probe,resolved} }
    favorites: [],
    prefs: { lastStationId: '', hideDead: false },
  })

  const stateFile = async () => {
    const dir = await stateDir()
    return dir === null ? null : dir + '/dsh-music-plus-radio.json'
  }

  /** 读状态文件（幂等、容错；坏文件退化成空状态而不是让插件挂掉）。 */
  async function ensureLoaded() {
    if (state !== null) return state
    if (loading !== null) return loading
    loading = (async () => {
      const st = emptyState()
      const file = await stateFile()
      if (file !== null && existsSync(file)) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'))
          if (data && typeof data === 'object') {
            if (data.builtin && Array.isArray(data.builtin.categories)) st.builtin = data.builtin
            if (Array.isArray(data.sources)) {
              st.sources = data.sources.filter((s) => s && typeof s.id === 'string' && typeof s.url === 'string')
            }
            if (Array.isArray(data.categories)) {
              st.categories = data.categories.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
            }
            if (Array.isArray(data.custom)) {
              st.custom = data.custom.filter((c) => c && typeof c.url === 'string' && c.url !== '')
            }
            if (data.overrides && typeof data.overrides === 'object') st.overrides = data.overrides
            if (Array.isArray(data.favorites)) st.favorites = data.favorites.filter((x) => typeof x === 'string')
            if (data.prefs && typeof data.prefs === 'object') {
              st.prefs = {
                lastStationId: typeof data.prefs.lastStationId === 'string' ? data.prefs.lastStationId : '',
                hideDead: data.prefs.hideDead === true,
              }
            }
          }
        } catch { /* 损坏 -> 空状态 */ }
      }
      state = st
      return state
    })()
    return loading
  }

  async function save() {
    const file = await stateFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(state, null, 1) + '\n', 'utf8')
    } catch { /* 持久化尽力而为：写不进去只丢用户层改动，不影响播放 */ }
  }

  // ---- 内容层合并 ----

  /** 内置库（用户更新过就用状态里的，否则用插件内置快照）。 */
  function builtinSnapshot() {
    return (state.builtin && Array.isArray(state.builtin.categories)) ? state.builtin : bundled
  }

  function builtinInfo() {
    const snap = builtinSnapshot()
    const src = snap.source || bundled.source || {}
    return {
      name: src.name || BUILTIN_SOURCE_NAME,
      url: src.url || UPSTREAM_REPO,
      raw: src.raw || UPSTREAM_README,
      license: src.license || 'CC0-1.0',
      revision: src.revision || '',
      generatedAt: snap.generatedAt || '',
      updated: state.builtin !== null,
    }
  }

  /**
   * 合并全部内容层 -> 有效电台表。
   * 去重按流地址；优先级：手填 > 内置 > 外部源（用户的显式意图优先）。
   */
  function effective() {
    const byUrl = new Map()
    const catSeen = []            // 分类出现顺序（{id,name,nameZh}）
    const pushCat = (id, name, nameZh) => {
      if (id === '' || id === undefined) return
      if (!catSeen.some((c) => c.id === id)) catSeen.push({ id, name: name || id, nameZh: nameZh || '' })
    }

    const add = (raw, sourceId, sourceName, opts) => {
      const url = clean(raw.url, 2000)
      if (url === '') return
      if (byUrl.has(url)) return
      const catName = raw.group || '未分类'
      const catId = opts.categoryId || categoryId(catName)
      const id = stationId(url)
      const ov = state.overrides[id] || {}
      byUrl.set(url, {
        id,
        url,
        name: clean(ov.customName || raw.name || '') || '未命名电台',
        homepage: httpUrl(ov.homepage !== undefined ? ov.homepage : raw.homepage),
        categoryId: ov.categoryId || catId,
        categoryName: catName,
        sourceId,
        sourceName,
        custom: opts.custom === true,
        hidden: ov.hidden === true,
        down: raw.down === true,
        tags: Array.isArray(ov.tags) ? ov.tags : (Array.isArray(raw.tags) ? raw.tags : []),
        country: clean(raw.country || '', 60),
        codec: clean(raw.codec || '', 20),
        bitrate: Number.isFinite(raw.bitrate) ? raw.bitrate : 0,
        hls: isHlsUrl(url),
        playlist: isPlaylistUrl(url) && !isHlsUrl(url),
      })
    }

    // 1) 手填电台
    for (const c of state.custom) {
      const cat = state.categories.find((x) => x.id === c.categoryId)
      add({ ...c, group: cat ? cat.name : '未分类' }, CUSTOM_SOURCE_ID, '我的电台', { custom: true, categoryId: c.categoryId })
      pushCat(c.categoryId || UNCATEGORIZED_ID, cat ? cat.name : '未分类', '')
    }
    // 2) 内置库
    for (const c of builtinSnapshot().categories) {
      pushCat(c.id, c.name, c.nameZh)
      // 内置分类可能被用户在状态里改名/隐藏；名称以状态为准（在 categories() 里统一覆盖）
      for (const s of (c.stations || [])) add({ ...s, group: c.name }, BUILTIN_SOURCE_ID, BUILTIN_SOURCE_NAME, { categoryId: c.id })
    }
    // 3) 外部源
    for (const src of state.sources) {
      if (src.enabled === false) continue
      for (const s of (src.stations || [])) add(s, src.id, src.name, {})
    }
    // 4) 分类：内置/外部源分类 + 用户自定义分类
    for (const c of state.categories) pushCat(c.id, c.name, '')

    for (const st of byUrl.values()) {
      if (st.categoryId === '' || !catSeen.some((c) => c.id === st.categoryId)) {
        catSeen.push({ id: st.categoryId || UNCATEGORIZED_ID, name: st.categoryName || '未分类', nameZh: '' })
      }
    }
    return { stations: [...byUrl.values()], catSeen }
  }

  /** 有效分类列表：合并用户改名/隐藏/排序 + 台数统计。 */
  function categoriesOf(eff) {
    const order = defaultOrder(eff.catSeen)
    const out = eff.catSeen.map((c) => {
      const ov = state.categories.find((x) => x.id === c.id)
      const count = eff.stations.filter((s) => s.categoryId === c.id && !s.hidden).length
      return {
        id: c.id,
        name: (ov && ov.name) || c.name || c.id,
        nameZh: c.nameZh || '',
        order: ov && Number.isFinite(ov.order) ? ov.order : (order.get(c.id) || 0),
        hidden: (ov && ov.hidden === true) || false,
        custom: state.categories.some((x) => x.id === c.id),
        count,
      }
    }).filter((c) => c.count > 0 || c.custom)
    out.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name))
    return out
  }

  function publicStations(eff, cats) {
    const favSet = new Set(state.favorites)
    const catName = new Map(cats.map((c) => [c.id, (c.nameZh ? c.nameZh + ' · ' : '') + c.name]))
    return eff.stations.map((s) => {
      const ov = state.overrides[s.id] || {}
      const probe = ov.probe || null
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        homepage: s.homepage || '',
        categoryId: s.categoryId,
        categoryName: catName.get(s.categoryId) || s.categoryName || '未分类',
        sourceId: s.sourceId,
        sourceName: s.sourceName,
        custom: s.custom,
        hidden: s.hidden,
        fav: favSet.has(s.id),
        down: s.down,
        hls: s.hls,
        playlist: s.playlist,
        quality: qualityLabel(s),
        tags: s.tags,
        country: s.country,
        probe: probe === null ? null : { status: probe.status, at: probe.at, ms: probe.ms, error: probe.error || '' },
        resolved: ov.resolved && ov.resolved.url ? ov.resolved.url : '',
      }
    })
  }

  /** 设置页用的完整快照。 */
  async function snapshot() {
    await ensureLoaded()
    const eff = effective()
    const cats = categoriesOf(eff)
    const stations = publicStations(eff, cats)
    let ok = 0, dead = 0, unknown = 0, lastProbeAt = 0
    for (const s of stations) {
      const p = s.probe
      if (p === null) unknown++
      else if (p.status === 'ok') ok++
      else if (p.status === 'dead') dead++
      else unknown++
      if (p && p.at > lastProbeAt) lastProbeAt = p.at
    }
    return {
      ok: true,
      builtin: builtinInfo(),
      sources: state.sources.map((s) => ({
        id: s.id, kind: 'remote', name: s.name, url: s.url, format: s.format || '',
        addedAt: s.addedAt || 0, refreshedAt: s.refreshedAt || 0,
        count: (s.stations || []).length, err: s.err || '', enabled: s.enabled !== false,
      })),
      categories: cats,
      stations,
      favorites: [...state.favorites],
      prefs: { ...state.prefs },
      stats: {
        stations: stations.length,
        visible: stations.filter((s) => !s.hidden).length,
        categories: cats.length,
        custom: stations.filter((s) => s.custom).length,
        hls: stations.filter((s) => s.hls).length,
        playlist: stations.filter((s) => s.playlist).length,
        probe: { ok, dead, unknown, lastProbeAt },
      },
    }
  }

  /** 供 music_play_plus 工具用：按台名/风格关键词搜电台。 */
  async function search(query, categoryQuery = '', limit = 10) {
    await ensureLoaded()
    const eff = effective()
    const cats = categoriesOf(eff)
    const stations = publicStations(eff, cats)
    const q = clean(query).toLowerCase()
    const cq = clean(categoryQuery).toLowerCase()
    const catLabel = (s) => {
      const c = cats.find((x) => x.id === s.categoryId)
      return (((c ? c.name + ' ' + c.nameZh : '') + ' ' + (s.categoryName || ''))).toLowerCase()
    }
    // HLS 台浏览器原生播不了，选台时直接跳过，免得 agent 点名一个放不出声的台。
    let pool = stations.filter((s) => !s.hidden && !s.hls)
    if (cq !== '') pool = pool.filter((s) => catLabel(s).includes(cq))
    if (q !== '') {
      // 关键词同时匹配台名/国家/标签与风格名：用户说「放个爵士电台」时 radio 参数
      // 传的可能就是风格名，这里一并兜住；全都不中就是真的没找到（不回退全量）。
      pool = pool.filter((s) => (s.name + ' ' + s.country + ' ' + s.tags.join(' ')).toLowerCase().includes(q)
        || catLabel(s).includes(q))
    }
    // 同名精确命中优先（find 未命中返回 undefined，不能用 !== null 判断）。
    const exact = q === '' ? undefined : pool.find((s) => s.name.toLowerCase() === q)
    const list = exact === undefined ? pool : [exact, ...pool.filter((s) => s !== exact)]
    const n = Math.max(1, Math.min(20, Number.isFinite(limit) ? limit : 10))
    return { total: pool.length, stations: list.slice(0, n), categories: cats.filter((c) => !c.hidden) }
  }

  // ---- 探活 ----

  async function probeOne(st) {
    const started = Date.now()
    let status = 'unknown'
    let error = ''
    try {
      const res = await fetchWithTimeout(st.url, {
        timeout: PROBE_TIMEOUT_MS,
        headers: { 'Icy-MetaData': '1', Accept: '*/*' },
      })
      if (res.ok || res.status === 206) {
        status = 'ok'
        // 电台流连上就不会结束：拿到响应头即算活，立刻掐断，别把连接挂着。
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel() } catch { /* ignore */ }
      } else {
        status = 'dead'
        error = 'HTTP ' + res.status
      }
    } catch (err) {
      status = 'dead'
      const name = err && err.name
      error = name === 'AbortError' || name === 'TimeoutError' ? '超时' : clean((err && err.message) || err, 120)
    }
    return { status, at: Date.now(), ms: Date.now() - started, error }
  }

  /** 批量探活（有并发上限，避免一次性打几百个连接）。 */
  async function probe(ids) {
    await ensureLoaded()
    const eff = effective()
    const wanted = Array.isArray(ids) && ids.length > 0
      ? eff.stations.filter((s) => ids.includes(s.id))
      : eff.stations
    const queue = [...wanted]
    const results = []
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const st = queue.shift()
        if (st === undefined) return
        const probe = await probeOne(st)
        const ov = state.overrides[st.id] || (state.overrides[st.id] = {})
        ov.probe = probe
        results.push({ id: st.id, ...probe })
      }
    })
    await Promise.all(workers)
    await save()
    return results
  }

  // ---- 播放列表解析（.pls / .m3u 清单 -> 真实流地址）----

  async function resolveStream(url, force = false) {
    await ensureLoaded()
    const target = httpUrl(url)
    if (target === '') return { ok: false, error: '地址无效' }
    const id = stationId(target)
    const ov = state.overrides[id] || {}
    if (!force && ov.resolved && ov.resolved.url && Date.now() - ov.resolved.at < 7 * 24 * 3600 * 1000) {
      return { ok: true, url: ov.resolved.url, cached: true }
    }
    // 本身就是 HLS 的，原样返回（本插件不代理解析 HLS）。
    if (isHlsUrl(target)) return { ok: true, url: target, hls: true }
    try {
      const res = await fetchWithTimeout(target, { timeout: RESOLVE_TIMEOUT_MS })
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      const text = (await res.text()).slice(0, MAX_FETCH_BYTES)
      const { format, stations } = parsePlaylist(target, res.headers.get('content-type') || '', text)
      const first = stations.find((s) => !isPlaylistUrl(s.url) || isHlsUrl(s.url)) || stations[0]
      if (first === undefined) return { ok: false, error: '清单里没有可用流地址', format }
      const o = state.overrides[id] || (state.overrides[id] = {})
      o.resolved = { url: first.url, at: Date.now(), format }
      await save()
      return { ok: true, url: first.url, format }
    } catch (err) {
      return { ok: false, error: clean((err && err.message) || err, 160) }
    }
  }

  // ---- 变更操作 ----

  async function addStation(body) {
    const url = httpUrl(body && body.url)
    if (url === '') return { error: '流地址必须是 http/https 链接' }
    if (state.custom.length >= MAX_CUSTOM_STATIONS) return { error: '自定义电台已达上限（' + MAX_CUSTOM_STATIONS + ' 个）' }
    const id = stationId(url)
    if (state.custom.some((c) => stationId(c.url) === id)) return { error: '这个流地址已经在「我的电台」里了' }
    state.custom.push({
      id,
      name: clean((body && body.name) || '') || url.replace(/^https?:\/\//, '').split('/')[0],
      url,
      homepage: httpUrl(body && body.homepage),
      categoryId: clean((body && body.categoryId) || '', 80),
      tags: Array.isArray(body && body.tags) ? body.tags.map((t) => clean(t, 40)).filter((t) => t !== '').slice(0, 8) : [],
      addedAt: Date.now(),
    })
    await save()
    return { ok: true, id }
  }

  async function updateStation(body) {
    const id = clean((body && body.id) || '', 40)
    if (id === '') return { error: '缺少电台 id' }
    const custom = state.custom.find((c) => c.id === id)
    if (custom !== undefined) {
      if (body.name !== undefined) custom.name = clean(body.name)
      if (body.url !== undefined) {
        const u = httpUrl(body.url)
        if (u === '') return { error: '流地址必须是 http/https 链接' }
        custom.url = u
      }
      if (body.homepage !== undefined) custom.homepage = httpUrl(body.homepage)
      if (body.categoryId !== undefined) custom.categoryId = clean(body.categoryId, 80)
      if (Array.isArray(body.tags)) custom.tags = body.tags.map((t) => clean(t, 40)).filter((t) => t !== '').slice(0, 8)
      await save()
      return { ok: true }
    }
    // 内置/外部源的电台不落盘内容，只在 overrides 里记用户层改动。
    const ov = state.overrides[id] || (state.overrides[id] = {})
    if (body.name !== undefined) ov.customName = clean(body.name)
    if (body.homepage !== undefined) ov.homepage = httpUrl(body.homepage)
    if (body.categoryId !== undefined) ov.categoryId = clean(body.categoryId, 80)
    if (Array.isArray(body.tags)) ov.tags = body.tags.map((t) => clean(t, 40)).filter((t) => t !== '').slice(0, 8)
    if (body.hidden !== undefined) ov.hidden = body.hidden === true
    await save()
    return { ok: true }
  }

  /**
   * 删除：手填电台真删；内置/外部源电台只做「隐藏」（否则下次刷新又回来了，
   * 用户会以为删除没生效）。传 purge=true 才清掉该台的用户层记录。
   */
  async function removeStation(body) {
    const id = clean((body && body.id) || '', 40)
    if (id === '') return { error: '缺少电台 id' }
    const before = state.custom.length
    state.custom = state.custom.filter((c) => c.id !== id)
    if (state.custom.length !== before) {
      delete state.overrides[id]
      state.favorites = state.favorites.filter((f) => f !== id)
      await save()
      return { ok: true, deleted: true }
    }
    const ov = state.overrides[id] || (state.overrides[id] = {})
    ov.hidden = true
    await save()
    return { ok: true, hidden: true }
  }

  async function favorite(body) {
    const id = clean((body && body.id) || '', 40)
    if (id === '') return { error: '缺少电台 id' }
    const fav = body.fav === true
    const has = state.favorites.includes(id)
    if (fav && !has) state.favorites.push(id)
    if (!fav && has) state.favorites = state.favorites.filter((f) => f !== id)
    await save()
    return { ok: true, fav }
  }

  async function addCategory(body) {
    const name = clean((body && body.name) || '', 40)
    if (name === '') return { error: '分类名不能为空' }
    const id = categoryId(name)
    if (state.categories.some((c) => c.id === id)) return { error: '分类已存在' }
    const eff = effective()
    const maxOrder = Math.max(0, ...categoriesOf(eff).map((c) => c.order))
    state.categories.push({ id, name, order: maxOrder + 1 })
    await save()
    return { ok: true, id }
  }

  async function updateCategory(body) {
    const id = clean((body && body.id) || '', 80)
    if (id === '') return { error: '缺少分类 id' }
    let cat = state.categories.find((c) => c.id === id)
    if (cat === undefined) {
      // 内置分类：第一次改就在状态里落一条覆盖记录。
      const eff = effective()
      const base = categoriesOf(eff).find((c) => c.id === id)
      cat = { id, name: base ? base.name : id, order: base ? base.order : 0, hidden: false }
      state.categories.push(cat)
    }
    if (body.name !== undefined) {
      const name = clean(body.name, 40)
      if (name === '') return { error: '分类名不能为空' }
      cat.name = name
    }
    if (body.hidden !== undefined) cat.hidden = body.hidden === true
    if (body.order !== undefined && Number.isFinite(body.order)) cat.order = Math.round(body.order)
    await save()
    return { ok: true }
  }

  async function removeCategory(body) {
    const id = clean((body && body.id) || '', 80)
    const cat = state.categories.find((c) => c.id === id)
    if (cat === undefined) return { error: '只能删除自定义分类' }
    state.categories = state.categories.filter((c) => c.id !== id)
    for (const c of state.custom) if (c.categoryId === id) c.categoryId = ''
    await save()
    return { ok: true }
  }

  /** 添加外部源：拉取 + 解析 + 落盘（失败不写，返回错误给 UI）。 */
  async function addSource(body) {
    const url = httpUrl(body && body.url)
    if (url === '') return { error: '电台源地址必须是 http/https 链接' }
    if (state.sources.length >= MAX_SOURCES) return { error: '外部源已达上限（' + MAX_SOURCES + ' 个）' }
    if (state.sources.some((s) => s.url === url)) return { error: '这个源已经添加过了' }
    const fetched = await fetchSource(url)
    if (fetched.error !== undefined) return fetched
    const src = {
      id: 'src-' + stationId(url).slice(3),
      kind: 'remote',
      name: clean((body && body.name) || '') || fetched.name || url.replace(/^https?:\/\//, '').split('/')[0],
      url,
      format: fetched.format,
      addedAt: Date.now(),
      refreshedAt: Date.now(),
      stations: fetched.stations,
      err: '',
    }
    state.sources.push(src)
    await save()
    return { ok: true, source: { id: src.id, name: src.name, count: src.stations.length, format: src.format } }
  }

  async function fetchSource(url) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: '*/*' } })
      if (!res.ok) return { error: '拉取失败：HTTP ' + res.status }
      const text = (await res.text()).slice(0, MAX_FETCH_BYTES)
      const { format, stations } = parsePlaylist(url, res.headers.get('content-type') || '', text, url)
      if (stations.length === 0) return { error: '没解析出任何电台（格式：' + format + '）' }
      return { format, stations }
    } catch (err) {
      return { error: '拉取失败：' + clean((err && err.message) || err, 160) }
    }
  }

  async function removeSource(body) {
    const id = clean((body && body.id) || '', 60)
    const before = state.sources.length
    state.sources = state.sources.filter((s) => s.id !== id)
    await save()
    return { ok: true, removed: before - state.sources.length }
  }

  /** 刷新：内置库重新拉上游 README；外部源重拉自己的地址。 */
  async function refreshSource(body) {
    const id = clean((body && body.id) || '', 60)
    if (id === BUILTIN_SOURCE_ID) {
      try {
        const res = await fetchWithTimeout(UPSTREAM_README)
        if (!res.ok) return { error: '拉取上游失败：HTTP ' + res.status }
        const text = (await res.text()).slice(0, MAX_FETCH_BYTES)
        const cats = parseReadmeStations(text)
        if (cats.length === 0) return { error: '上游内容没解析出分类，已保留原有内置库（可能上游改版了）' }
        let revision = ''
        try {
          const r = await fetchWithTimeout('https://api.github.com/repos/conafun/recommended-radio-streams/commits/main', { timeout: 8000 })
          if (r.ok) revision = (await r.json()).sha || ''
        } catch { revision = '' }
        state.builtin = {
          version: 1,
          source: { ...(builtinInfo()), raw: UPSTREAM_README, revision, updatedAt: new Date().toISOString() },
          generatedAt: new Date().toISOString(),
          categories: cats.map((c, i) => ({ id: c.id, name: c.name, nameZh: '', order: i, stations: normalize(c.stations) })),
        }
        await save()
        return { ok: true, builtin: builtinInfo(), categories: state.builtin.categories.length, stations: state.builtin.categories.reduce((n, c) => n + c.stations.length, 0) }
      } catch (err) {
        return { error: '拉取上游失败：' + clean((err && err.message) || err, 160) }
      }
    }
    const src = state.sources.find((s) => s.id === id)
    if (src === undefined) return { error: '源不存在' }
    const fetched = await fetchSource(src.url)
    if (fetched.error !== undefined) {
      src.err = fetched.error
      await save()
      return { error: fetched.error }
    }
    src.stations = fetched.stations
    src.format = fetched.format
    src.refreshedAt = Date.now()
    src.err = ''
    await save()
    return { ok: true, count: src.stations.length }
  }

  async function updatePrefs(body) {
    const p = (body && body.prefs) || {}
    if (typeof p.lastStationId === 'string') state.prefs.lastStationId = clean(p.lastStationId, 40)
    if (p.hideDead !== undefined) state.prefs.hideDead = p.hideDead === true
    await save()
    return { ok: true, prefs: { ...state.prefs } }
  }

  /** 把内置库恢复成插件快照（撤销「从 GitHub 更新」）。 */
  async function resetBuiltin() {
    state.builtin = null
    await save()
    return { ok: true, builtin: builtinInfo() }
  }

  // ---- 路由 ----

  /** 返回 true 表示已处理该请求。 */
  async function handle(pathname, req, res, url) {
    const p = pathname.slice('/dsh-music-plus'.length)
    const POST = req.method === 'POST'
    if (!p.startsWith('/radio')) return false

    try {
      if (p === '/radio' && req.method === 'GET') {
        writeJson(res, await snapshot())
        return true
      }
      if (p === '/radio/resolve' && req.method === 'GET') {
        const target = url.searchParams.get('url') || ''
        const out = await resolveStream(target, url.searchParams.get('force') === '1')
        writeJson(res, out, out.ok ? 200 : 502)
        return true
      }
      if (!POST) { writeJson(res, { ok: false, error: '不支持的请求' }, 405); return true }

      // 任何写操作前先加载状态文件：如果不是先 GET 过（脚本化调用、或设置页尚未打开
      // 就被 agent 直接点播），内部 state 还是 null，直接改会整片抛错。
      await ensureLoaded()
      const body = await readBody(req)
      const routes = {
        '/radio/station/add': addStation,
        '/radio/station/update': updateStation,
        '/radio/station/remove': removeStation,
        '/radio/favorite': favorite,
        '/radio/category/add': addCategory,
        '/radio/category/update': updateCategory,
        '/radio/category/remove': removeCategory,
        '/radio/source/add': addSource,
        '/radio/source/remove': removeSource,
        '/radio/source/refresh': refreshSource,
        '/radio/source/reset': resetBuiltin,
        '/radio/prefs': updatePrefs,
      }
      if (p === '/radio/probe') {
        const ids = Array.isArray(body && body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 600) : []
        const results = await probe(ids)
        const ok = results.filter((r) => r.status === 'ok').length
        writeJson(res, { ok: true, probed: results.length, alive: ok, results })
        return true
      }
      const fn = routes[p]
      if (fn === undefined) { writeJson(res, { ok: false, error: '未知的电台操作' }, 404); return true }
      const out = await fn(body)
      if (out && out.error !== undefined) { writeJson(res, { ok: false, error: out.error }, 400); return true }
      writeJson(res, { ...(await snapshot()), ...out })
      return true
    } catch (err) {
      writeJson(res, { ok: false, error: clean((err && err.message) || err, 300) }, 500)
      return true
    }
  }

  return {
    ensureLoaded, save, handle, snapshot, search, probe, resolveStream,
    builtinInfo, stationId, BUILTIN_SOURCE_ID,
    /** 测试用：直接看内部状态（不对外暴露给 UI）。 */
    _state: () => state,
    _bundled: bundled,
  }
}
