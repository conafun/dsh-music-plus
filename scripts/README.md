# scripts/

开发期工具脚本。**运行时不需要它们** —— 插件本身已经内置了「从 GitHub 更新内置库」
（`docs/radio-design.md` 的 `/radio/source/refresh`），那条路径不依赖这里。

| 脚本 | 用途 | 是否需要联网 |
|---|---|:--:|
| `build-radio-snapshot.mjs` | 重新生成内置快照 `lib/radio-data.json`（拉上游 CC0 清单 → 用插件自己的解析器切分类 → 与上游 `playlists/*.m3u` 交叉校验台数） | 是 |
| `smoke-radio-host.mjs` | 冒烟测试 `lib/radio-host.js` 的全部路由（内置库 / 搜索 / 手填台 / 收藏 / 隐藏 / 改名 / 分类管理 / prefs / 状态落盘与重载 / 探活 / 未知路由） | 仅第 8 步探活 |
| `check-radio-resolve.mjs` | 一次性联网诊断：`.pls` 清单能否被解析成真实流地址 + 抽样探活 | 是 |

```bash
node scripts/build-radio-snapshot.mjs   # ⚠️ 会覆盖 lib/radio-data.json，跑完请 git diff
node scripts/smoke-radio-host.mjs       # 退出码 0 = 全通过
node scripts/check-radio-resolve.mjs
```

- 三个脚本的路径都**相对脚本自身**解析（`import.meta.url`），在哪个目录执行都一样。
- 会产生状态文件的脚本一律写**系统临时目录**下的独立子目录，**不碰真实的 `~/.dsh`**。
- 解析逻辑本身的单元测试在 `test/radio.test.js`，日常跑 `npm test` 即可，不必跑这里的脚本。
