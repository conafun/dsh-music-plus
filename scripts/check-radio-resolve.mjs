// 真机验证（需要联网）：清单型电台（.pls）能否被宿主解析成真实流地址；顺带试一次真实探活。
//
// 用法（任意目录都可以 —— 路径都相对本脚本解析）：
//     node scripts/check-radio-resolve.mjs
//
// 这是**一次性的联网诊断**脚本，不进 CI：结果依赖当前网络与电台存活情况。
// 解析逻辑本身的单元测试在 test/radio.test.js（「lib/radio.js — PLS / XSPF / ASX」）。
// 状态目录用系统临时目录，**不碰真实的 ~/.dsh**。
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createRadio } = await import('../lib/radio-host.js')

const TMP = join(tmpdir(), 'dsh-music-plus-radio-resolve')
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true })
const radio = createRadio({ stateDir: async () => TMP, writeJson: () => {}, readBody: async () => null })

const snap = await radio.snapshot()
const pls = snap.stations.filter((s) => s.playlist)
console.log('清单型电台（需解析）:', pls.length)
for (const st of pls.slice(0, 3)) {
  const r = await radio.resolveStream(st.url)
  console.log(' ', st.name, '\n     <-', st.url, '\n     ->', r.ok ? r.url + (r.format ? ' [' + r.format + ']' : '') : 'FAIL ' + r.error)
}
// 真探活几个高知名度台
const alive = snap.stations.filter((s) => ['jazz-blues', 'electronic'].includes(s.categoryId) && !s.hls && !s.playlist).slice(0, 4)
for (const st of alive) {
  const [p] = await radio.probe([st.id])
  console.log('探活', p.status.padEnd(4), String(p.ms).padStart(5) + 'ms', st.name)
}
