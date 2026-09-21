/**
 * 构建内置电台快照：拉取 conafun/recommended-radio-streams（CC0）并解析成
 * dsh-music-plus 的内置库数据 lib/radio-data.json。
 *
 * 用插件自己的 lib/radio.js 解析 —— 顺便当作对上游 readme_to_m3u.py 的交叉校验：
 * README 解析出的每类台数应与 playlists/<slug>.m3u 的台数一致。
 *
 * 用法（在插件仓库根目录，或任意目录都可以 —— 路径都相对本脚本解析）：
 *     node scripts/build-radio-snapshot.mjs
 *
 * 说明：这只是**开发期的引导/重建工具**。插件运行时也内置了「从 GitHub 更新内置库」
 * （`docs/radio-design.md` 的 `/radio/source/refresh`），那条路径不依赖本脚本。
 *
 * ⚠️ 注意：本脚本会**覆盖 lib/radio-data.json**，运行后请 `git diff` 确认上游变更再提交。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReadmeStations, parseM3U, isHlsUrl, categoryId } from '../lib/radio.js'

const REPO = 'conafun/recommended-radio-streams'
const RAW = `https://raw.githubusercontent.com/${REPO}/main`
// 写回插件自己的内置快照；用 import.meta.url 定位，与当前工作目录无关
const OUT = fileURLToPath(new URL('../lib/radio-data.json', import.meta.url))

// 上游分类 slub → 中文显示名（UI 主显示中文，数据里保留英文原名以便和上游对照）
const ZH = {
  'ambient-lo-fi-chill': '氛围 · Lo-Fi · 放松',
  'campus-public-radio': '校园与公共电台',
  'christmas-holiday': '圣诞与节日',
  'classical-opera': '古典与歌剧',
  'decades-oldies-nostalgia': '年代金曲 · 怀旧',
  'electronic': '电子',
  'experimental-nerdy-scanners': '实验 · 极客',
  'funk-soul-hip-hop-disco': '放克 · 灵魂 · 嘻哈',
  'global-independent-online-communities': '全球独立与网络社区',
  'jazz-blues': '爵士 · 布鲁斯',
  'metal-heavy': '金属 · 重型',
  'news-spoken-word': '新闻 · 谈话',
  'reggae-dub': '雷鬼 · Dub',
  'rock-indie-alternative-country-folk': '摇滚 · 独立 · 民谣',
  'video-game-chiptune-soundtracks': '游戏 · 芯片音乐',
  'world-regional': '世界音乐 · 地域',
}

const gh = async (path) => {
  const res = await fetch(`${RAW}/${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.text()
}

// 1) README（单一事实源）
const readme = await gh('README.md')
let readmeSha = ''
try {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`)
  if (r.ok) readmeSha = (await r.json()).sha || ''
} catch (e) { readmeSha = '' }

// 2) 用插件解析器切分类
const cats = parseReadmeStations(readme)

// 3) 逐个核对上游生成的 m3u（台数应一致）
const slugs = Object.keys(ZH)
const report = []
for (const slug of slugs) {
  let text = ''
  try { text = await gh(`playlists/${slug}.m3u`) } catch (e) { report.push([slug, -1, -1]); continue }
  const m3u = parseM3U(text)
  const mine = cats.find((c) => c.id === slug)
  report.push([slug, mine ? mine.stations.length : 0, m3u.length])
}

// 4) 组装快照
let total = 0, hls = 0, pls = 0, down = 0
const categories = cats.map((c, i) => {
  const stations = c.stations.map((s) => {
    total++
    if (isHlsUrl(s.url)) hls++
    if (/\.pls(\?|#|$)/i.test(s.url)) pls++
    if (s.down) down++
    return {
      name: s.name,
      url: s.url,
      homepage: s.homepage,
      ...(s.label ? { label: s.label } : {}),
      ...(s.down ? { down: true } : {}),
    }
  })
  return { id: c.id, name: c.name, nameZh: ZH[c.id] || '', order: i, stations }
})

const snapshot = {
  version: 1,
  source: {
    id: 'builtin-recommended',
    kind: 'builtin',
    name: '推荐网络电台',
    url: `https://github.com/${REPO}`,
    raw: `${RAW}/README.md`,
    license: 'CC0-1.0',
    revision: readmeSha,
  },
  generatedAt: new Date().toISOString(),
  categories,
}

writeFileSync(OUT, JSON.stringify(snapshot, null, 1) + '\n', 'utf8')

console.log(`写入 ${OUT}`)
console.log(`分类 ${categories.length} · 电台 ${total}（HLS ${hls} · PLS ${pls} · 标记失效 ${down}）`)
console.log('交叉校验（分类: 插件解析 / 上游 m3u）')
for (const [slug, mine, theirs] of report) {
  const flag = mine === theirs ? 'ok ' : '!! '
  console.log(`${flag}${slug}: ${mine} / ${theirs}`)
}
console.log('revision:', readmeSha.slice(0, 12))
