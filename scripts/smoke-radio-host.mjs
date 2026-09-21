// 电台 Host 模块冒烟测试：直接打 createRadio() 的全部路由，覆盖内置库/搜索/手填台/
// 收藏/隐藏/改名/分类管理/prefs/状态落盘与重载/探活/未知路由。
//
// 用法（任意目录都可以 —— 路径都相对本脚本解析）：
//     node scripts/smoke-radio-host.mjs
//
// 状态文件写到系统临时目录下的独立子目录，**不碰真实的 ~/.dsh**。
// 第 8 步「探活」会发一次真实网络请求；网络不通只会打印 dead，不会让脚本失败。
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createRadio, BUILTIN_SOURCE_ID } = await import('../lib/radio-host.js')

const TMP = join(tmpdir(), 'dsh-music-plus-radio-smoke')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

let lastJson = null
let lastBody = null
const res = { writeHead() {}, end() {} }
const radio = createRadio({
  stateDir: async () => TMP,
  writeJson: (_res, v) => { lastJson = v },
  readBody: async () => lastBody,
})

const call = async (pathname, method = 'GET', body = null) => {
  lastJson = null
  lastBody = body
  const url = new URL('http://x' + pathname)
  const handled = await radio.handle(pathname, { method }, res, url)
  if (!handled) throw new Error('route not handled: ' + pathname)
  return lastJson
}

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 1) 快照
const snap = await call('/dsh-music-plus/radio')
check('GET /radio ok', snap.ok === true)
check('内置 432 台', snap.stats.stations === 432, 'got ' + snap.stats.stations)
check('16 个分类', snap.categories.length === 16, 'got ' + snap.categories.length)
check('分类都有台数', snap.categories.every((c) => c.count > 0))
check('revision 有值', snap.builtin.revision.length >= 7, snap.builtin.revision.slice(0, 7))
check('HLS 被标记', snap.stats.hls > 0, snap.stats.hls + ' 台')
check('PLS 被标记', snap.stats.playlist > 0, snap.stats.playlist + ' 台')
const jazz = snap.categories.find((c) => c.id === 'jazz-blues')
check('jazz-blues 分类存在', jazz !== undefined, jazz ? jazz.count + ' 台' : '')

// 2) 搜索（工具用）
const s1 = await radio.search('jazz')
check('搜索 jazz 有结果', s1.stations.length > 0, s1.total + ' 个匹配 / 首个 ' + (s1.stations[0] || {}).name)
const s2 = await radio.search('', '爵士')
check('按风格搜「爵士」有结果', s2.stations.length > 0, s2.total + ' 个')
const s3 = await radio.search('这个台不存在xyz')
check('搜不到时返回空', s3.stations.length === 0)

// 3) 手填电台
const add = await call('/dsh-music-plus/radio/station/add', 'POST', { name: '我的测试台', url: 'http://example.com/live.mp3', categoryId: 'jazz-blues' })
check('新增手填电台', add.ok === true && add.stats.stations === 433, 'stations=' + add.stats.stations)
const mine = add.stations.find((x) => x.custom)
check('手填台带 custom 标记', mine !== undefined && mine.name === '我的测试台')
check('手填台归到指定分类', mine.categoryId === 'jazz-blues')
const dup = await call('/dsh-music-plus/radio/station/add', 'POST', { name: 'dup', url: 'http://example.com/live.mp3' })
check('重复流地址被拒', dup.ok === false && /已经/.test(dup.error), dup.error)

// 4) 收藏 / 隐藏 / 改名（用户层按 id 保存）
const first = add.stations.find((x) => x.sourceId === BUILTIN_SOURCE_ID)
const fav = await call('/dsh-music-plus/radio/favorite', 'POST', { id: first.id, fav: true })
check('收藏电台', fav.favorites.includes(first.id))
const ren = await call('/dsh-music-plus/radio/station/update', 'POST', { id: first.id, name: '改过的名字' })
check('内置台改名走 overrides', ren.stations.find((x) => x.id === first.id).name === '改过的名字')
const hid = await call('/dsh-music-plus/radio/station/remove', 'POST', { id: first.id })
check('内置台删除=隐藏', hid.ok === true && hid.stations.find((x) => x.id === first.id).hidden === true)
const del = await call('/dsh-music-plus/radio/station/remove', 'POST', { id: mine.id })
check('手填台删除=真删', del.ok === true && del.stats.stations === 432, 'stations=' + del.stats.stations)

// 5) 分类管理
const nc = await call('/dsh-music-plus/radio/category/add', 'POST', { name: '深夜' })
check('新建分类', nc.ok === true && nc.categories.some((c) => c.name === '深夜'))
const newCat = nc.categories.find((c) => c.name === '深夜')
const hideCat = await call('/dsh-music-plus/radio/category/update', 'POST', { id: 'christmas-holiday', hidden: true })
check('隐藏内置分类', hideCat.categories.find((c) => c.id === 'christmas-holiday').hidden === true)
const renCat = await call('/dsh-music-plus/radio/category/update', 'POST', { id: 'jazz-blues', name: '爵士乐' })
check('重命名内置分类', renCat.categories.find((c) => c.id === 'jazz-blues').name === '爵士乐')
const delCat = await call('/dsh-music-plus/radio/category/remove', 'POST', { id: newCat.id })
check('删除自定义分类', delCat.categories.every((c) => c.id !== newCat.id))

// 6) prefs
const pr = await call('/dsh-music-plus/radio/prefs', 'POST', { prefs: { lastStationId: first.id, hideDead: true } })
check('保存 prefs', pr.prefs.hideDead === true && pr.prefs.lastStationId === first.id)

// 7) 状态文件落盘 + 重载（模拟重启）
const stateFile = join(TMP, 'dsh-music-plus-radio.json')
check('状态文件已写入', existsSync(stateFile))
const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
check('状态只存用户层', raw.builtin === null && raw.custom.length === 0 && Object.keys(raw.overrides).length >= 1)
const radio2 = createRadio({ stateDir: async () => TMP, writeJson: (_r, v) => { lastJson = v }, readBody: async () => null })
const snap2 = await radio2.snapshot()
check('重启后仍 432 台', snap2.stats.stations === 432, 'got ' + snap2.stats.stations)
check('重启后隐藏仍生效', snap2.stations.find((x) => x.id === first.id).hidden === true)
check('重启后改名仍生效', snap2.stations.find((x) => x.id === first.id).name === '改过的名字')
check('重启后收藏仍在', snap2.favorites.includes(first.id))

// 8) 探活：不可达地址应判 dead
const p = await call('/dsh-music-plus/radio/probe', 'POST', { ids: [first.id] })
check('探活返回结果', Array.isArray(p.results) && p.results.length === 1)
console.log('     探活状态: ' + JSON.stringify(p.results[0]))

// 9) 未知路由
const un = await call('/dsh-music-plus/radio/nope', 'POST', {})
check('未知操作返回错误', un.ok === false)

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '：' + pass + ' ok / ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
