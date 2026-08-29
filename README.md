# dsh-music-plus

> 一个基于 **dsh-music-player** 修改而来的 DeepSeek Harness 本地音乐 / 播客插件。它保留本地音乐播放、频谱可视化、自建歌单，**移除**了原版的在线 QQ 音乐、在线酷狗音乐、AI 讲书（TTS）、实时歌词/字幕，并**新增**了**播客 RSS 订阅与在线播放**。为与原版共存不混淆，包名与内部标识已整体改名为 **dsh-music-plus**（独立插件行、独立 `/dsh-music-plus/*` 路由、独立状态文件、独立 `music_play_plus` 工具）。

---

## 来源项目（Based on）

- **原项目**：[kendu76/dsh-music-player](https://github.com/kendu76/dsh-music-player)
- **基准提交**：`4eb448d` — `fix: 酷狗取链进行中去重——HEAD/GET 并发只取一次链（减少重复请求）`（原作者 `kendu76`）
- **本项目**：`dsh-music-plus`（在原项目基础上的本地修改版）

> 本仓库属于个人学习/二次开发用途：未改动原项目的 `MIT` 许可；在线 QQ/酷狗、AI 讲书、歌词等能力是基于原作者实现做的功能裁剪与扩展。

---

## 主要变更（逐条）

1. **移除在线 QQ 音乐**：删除 QQ 登录/搜索/歌单/排行榜/取链等整套能力，以及 `lib/qq.js`、`lib/qrc.js` 与对应路由、客户端 QQ 面板。
2. **移除在线酷狗音乐**：删除酷狗扫码登录/榜单/搜索/取链/KRC 歌词整套能力，以及 `lib/kugou.js`、`lib/krc.js` 与对应路由、客户端酷狗面板。
3. **移除 AI 讲书（TTS）**：删除 `.txt`/`.epub` 小说扫描、结构解析、MiMo TTS 合成、章节目录/声音选择/进度细线，以及 `/dsh-music-plus/book/*`、`/dsh-music-plus/tts-logs` 路由；`lib/index.js` 不再依赖 `llm`。
4. **移除实时歌词 / 字幕**：删除本地 `.lrc` 匹配、在线兜底取词、歌词动效 / 卡拉OK 扫色、`/dsh-music-plus/lyric*` 路由，以及 `lib/lyric.js` 与播放条的歌词 UI。
5. **新增播客 RSS 订阅与在线播放**：
   - 新增 `lib/podcast.js`（纯 RSS 2.0 / Atom 解析：CDATA、命名空间 `media:*`、自闭合 `<link/>`、`itunes:duration` 秒/时间串、enclosure 音频地址识别）。
   - Host 端新增 `/dsh-music-plus/podcasts`（列表）、`/podcasts/add`、`/podcasts/refresh`、`/podcasts/remove` 路由，订阅持久化到 `~/.dsh/dsh-music-plus-podcasts.json`。
   - 客户端新增「播客」页签：**顶部订阅源横排卡片 + 聚合视图**。默认（不点任何源）显示**所有源的最新单集**（按发布时间新→旧，每行带来源徽标）；点具体源则只显示该源全部单集（同样新→旧）；点末尾的「全部」回到聚合视图。点任意一集即用现有播放器在线播放。
6. **整体改名与完全隔离**（避免与原版混淆/冲突）：
   - `package.json` `name → dsh-music-plus`。
   - `cordis.patch.yml` 行 `id: music-player-plus`、`name: dsh-music-plus`。
   - `lib/index.js` `export const name = 'dsh-music-plus'`。
   - `lib/client.js` `.load({ id: 'dsh-music-plus' })`。
   - HTTP 路由前缀 `/dsh-music` → `/dsh-music-plus`。
   - Host 状态文件改名：`music-player-*.json` → `dsh-music-plus-*.json`（prefs / playlists / podcasts / state）。
   - 模型工具 `music_play` → `music_play_plus`（`systemPrompt` 同步更新）。
   - `lib/index.js` 的 `inject` 移除已不使用的 `llm`。
7. **目录选择器跨盘符修复**：给「选择音乐目录」与歌单「添加歌曲」等选择器加了「⬆ 上级目录」/「⬆ 本机磁盘（切换盘符）」按钮，解决 Windows 上只能选 `C:\Users\...\Music`、选不到 `E:\` / `F:\` 的问题（根因是客户端 `browse()` 未使用服务端返回的 `up` 字段）。
8. **精简与测试同步**：删除对应旧测试（`qq*`、`kugou*`、`kg-*`、`lyric`、`qrc`），重写 `test/index.test.js` 与 `test/client.test.js`，新增 `test/podcast.test.js`；`docs/` 删除已过时的 QQ/酷狗/在线歌词等调研文档，保留 `playlists-design.md`。调整 `package.json` 的 description / keywords / `test` 脚本（`--pool=threads` 以规避部分环境 fork 池 `EPERM`）。

---

## 与原版的差异 & 亮点

**差异一目了然：**

| 能力 | 原版 dsh-music-player | 本版 dsh-music-plus |
|------|:---------------------:|:-------------------:|
| 本地音乐播放（音质识别/断点续播） | ✅ | ✅（保留） |
| 实时频谱（柱状图/波形图） | ✅ | ✅（保留） |
| 自建歌单 / 收藏「我最喜欢」 | ✅ | ✅（保留） |
| music_play 模型工具 | `music_play` | `music_play_plus` |
| 在线 QQ 音乐 | ✅ | ❌（移除） |
| 在线酷狗音乐 | ✅ | ❌（移除） |
| AI 讲书（TTS 朗读小说） | ✅ | ❌（移除） |
| 实时歌词 / 字幕 | ✅ | ❌（移除） |
| **播客 RSS 订阅 + 在线播放** | ❌ | ✅（**新增，亮点**） |
| 目录选择器跨盘符（E/F 盘） | ⚠️ 选不到 | ✅（修复） |

**亮点：**
- **多订阅源聚合视图**：顶部一排订阅源卡片，默认展示**所有源的最新单集**（新→旧、带来源徽标），点具体源只看它，点「全部」返回聚合——订阅再多也不乱。
- **纯本地解析**：播客 RSS/Atom 解析无第三方依赖（`lib/podcast.js`），Host 用 Node 内置 `fetch` 拉取，`music_play_plus` 工具让 agent 可搜索本地音乐/歌单。
- **与原版完全隔离**：独立插件行、独立 `/dsh-music-plus/*` 路由、独立状态文件，可与原版**并存**不冲突；模型工具改为 `music_play_plus` 避免与 `music_play` 重复注册。

---

## 环境要求

- Node.js ≥ 20（播客 Host 端用内置 `fetch`）
- 已安装 `dsh` CLI（DeepSeek Harness）
- npm / pnpm（DSH 的 `plugin` 子命令通过 pnpm 管理 profile 依赖）

---

## 功能特性

- **本地音频流式播放**（HTTP Range）
- **断点续播**：本地音乐与播客在刷新/重启后都会恢复到上次播放的曲目/单集与进度（点一下 ▶ 续播，无需重新翻找）
- **可拖动进度条**：播放条底部的细进度线可点击/拖动，定点播放任意位置（音乐与播客通用）
- 顺序 / 单曲循环 / 乱序三种模式
- **实时频谱可视化**（柱状图 12 段 / 波形图三频段，两种样式可在「系统配置」切换）
- 播放时申请屏幕唤醒锁
- **自建歌单**（新建/添加歌曲/排序/清空；播放条爱心收藏到「我最喜欢」）
- **播客订阅**（订阅/刷新/退订；聚合视图 + 单源详情；在线播放）
- 支持格式：`mp3 / m4a / m4b / aac / flac / wav / ogg / opus / webm / aiff`（递归扫描，上限 500 首）
- **真实音质识别**：解析文件头显示「格式 · 音质档」（如 `FLAC · 无损`）

---

## 本地安装（重要：非 npm 安装）

> 本项目**不是**通过 `npm install -g` 或 `dsh plugin add <npm 包名>` 安装，而是**把本地源码目录作为插件源**安装到某个 DSH profile。请按下面步骤做。

### 1. 把项目放到本地

```powershell
# 方式 A：git 克隆（推荐）
git clone <你的仓库 URL> dsh-music-plus
cd dsh-music-plus

# 方式 B：直接下载 ZIP 解压到本地某个目录（记住这个目录路径，下面会用到）
```

### 2. 用 `dsh plugin add` 以**本地目录**方式装入 profile

```powershell
# 把 <profile> 换成实际 profile 名（如 web），把 <项目绝对路径> 换成上面那个目录
dsh plugin --profile <profile> add <项目绝对路径>
```

例如：
```powershell
dsh plugin --profile web add F:\DeepseekHarness\dsh-music-plus
```

> **说明**：`dsh plugin add` 会把 `pnpm add <dir>` 转发到该 profile 目录；正因为本地目录里的 `package.json` `name` 已是 `dsh-music-plus`，所以它会作为独立插件 `dsh-music-plus` 安装，**不会**覆盖/和原版 `dsh-music-player` 混淆。

### 3. 重启 DSH / 刷新 Web 页面

重启 DSH 或刷新 `http://127.0.0.1:3080`，聊天区上方会出现「DSH音乐播放器」播放条；点「列表」打开面板：
- **本地音乐**：点「选择音乐目录」选音乐目录（默认 `~/Music`）→ 自动扫描 → 点歌播放。
- **播客**：粘贴任意 RSS / Atom 订阅链接，点「订阅」，顶部源卡片选源、默认看「全部」聚合最新单集，点任意一集在线播放。

### 4. （可选）让 agent 直接播放

`music_play_plus` 工具已注册：在对话框说「播放周杰伦的歌」即可按关键词搜本地音乐，或「播放歌单 我最喜欢」按歌单名播放。

> 小提示：播客音频以源站地址流式播放；若某源未开 CORS，频谱可能不显示，但**播放不受影响**。

---

### 本地安装可能遇到的坑

- **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（供应链最小发布年龄策略）**：若是 profile 里某些三方包发布太新被 DSH/pnpm 的供应链策略拦截，可用「本次临时关闭年龄校验」的方式安装：
  ```powershell
  dsh plugin --profile <profile> add --config.minimumReleaseAge=0 <项目绝对路径>
  ```
  或按 DSH 提示，在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加入这些包名。

---

## 本地卸载

因为是用本地目录安装的，卸载就是**从 profile 里移除这个包**：

```powershell
dsh plugin --profile <profile> remove dsh-music-plus
```

例如：
```powershell
dsh plugin --profile web remove dsh-music-plus
```

> - 若卸载也被供应链策略拦截，同样加 `--config.minimumReleaseAge=0`：
>   ```powershell
>   dsh plugin --profile <profile> remove --config.minimumReleaseAge=0 dsh-music-plus
>   ```
> - 卸载后，该 profile 里不再有 `dsh-music-plus` 这个插件；Host 端状态文件（`~/.dsh/dsh-music-plus-*.json`，含歌单/播客订阅/播放偏好）会保留在磁盘上（不影响其它插件），如需彻底清理可手动删除这些文件。

---

## 目录选择器（跨盘符）

「选择音乐目录」会列出**本机所有磁盘**（`__drives__` 视图），并提供「⬆ 本机磁盘（切换盘符）」/「⬆ 上级目录」按钮，因此可以方便切到 `E:\`、`F:\` 等任意盘符的目录。

---

## 播客使用一览

- **订阅**：粘贴 RSS 2.0 / Atom 链接 → 订阅。
- **聚合视图（默认）**：顶部源横排，默认显示所有源最新单集（新→旧，带来源徽标）。
- **单源视图**：点某个源卡片 → 只看该源（新→旧）。
- **返回聚合**：点横排末尾的「全部」。
- **播放**：点任意一集即用现有播放器播放；当前订阅即播放来源，顺序/乱序在该订阅内循环。

---

## 测试

```powershell
cd <项目根目录>
npm install          # 安装开发依赖（vitest / react / jsdom）
npm test             # 跑全量：Host 单测 + 播客解析 + Web 渲染冒烟
```

> 若 `npm test` 报 `spawn EPERM`（fork 池被部分环境拦截），`package.json` 的 `test`/`ci` 已用 `--pool=threads` 规避。

---

## License

[MIT](LICENSE) — 原项目版权归原作者，本修改版同样以 MIT 发布。
