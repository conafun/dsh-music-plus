# 自建歌单功能 · 设计定稿（v3）

> 目标：在 dsh-music-plus 的音乐播放之上新增「自建歌单」。用户可把本地音乐文件组织成多个歌单，
> 并可把歌单作为播放来源——此时**顺序/乱序/单曲循环只在该歌单范围内发生**。AI 讲书不受影响。
>
> 状态：已确认。实现里程碑见文末。

## 1. 已确认决策

| 项 | 决定 |
|---|---|
| 范围语义 | **来源即范围**：在歌单里点歌 → 循环限该歌单；在曲库点歌 → 循环限全库 |
| 持久化 | Host 端 `~/.dsh/dsh-music-plus-playlists.json`（node:fs 直写，沿用 `dsh-music-plus-state.json` 模式） |
| 加歌交互 | 歌单详情「添加歌曲」→ **文件系统级多选框**（浏览/上级/跨盘符/多选），也可从任意目录选非曲库文件 |
| 默认歌单 | 系统默认「我最喜欢」`pl-fav`：固定第二位、不可重命名、不可删除（可清空），作为收藏总集 |
| 附加能力 | `music_play_plus` 支持 `playlist` 参数；歌单内排序（上移/下移按钮，**明确不做拖拽排序**）；一键清空（含系统歌单） |
| 收藏 | 播放条爱心按钮：当前曲收藏/取消收藏于「我最喜欢」 |

## 2. UI 结构（最终）

**播放面板**：顶部大 tab 为 `本地音乐 | QQ音乐 | AI讲书`（自建歌单属于「本地音乐」）。

**音乐页内部**（目录设置下方新增子 tab 标签行）：

```
[曲库] [❤我最喜欢] [歌单A] [歌单B] … [+]
```

- **曲库**：歌曲列表保持现状，每行行尾新增「＋」按钮 → 弹出「加入歌单」菜单（列出全部歌单 + 新建歌单），把该曲加入任一歌单。
- **❤ 我最喜欢**：系统默认，固定第二位、不可删/改名（可清空）。
- **歌单标签**（在 ＋ 之前）：进入详情；详情内可重命名 / 删除。
- **＋**（固定在末尾）：新建自建歌单（就地输入名 → 插入到 ＋ 之前并切入）。

**歌单详情页**（不显示歌单名，操作按钮在一行，同款 ghost 样式）：

```
[＋ 添加歌曲] [清空] [重命名] [删除]     （fixed 歌单无重命名/删除；所有歌单都有清空；失效数靠右）
♩ 歌曲1  4.2MB  [↑][↓] [×]
♩ 歌曲2  3.1MB  [↑][↓] [×]
```

- 「添加歌曲」→ 文件系统级多选器（勾选多个音频 → 追加到末尾）。
- 「清空」→ 二次确认后移除该歌单全部歌曲（含已失效；任何歌单都可用，含「我最喜欢」，不删文件）。
- 每行：移除 ×、上移/下移 ↑↓ 排序；点歌播放并设范围 = 该歌单。
- 空态：「歌单为空，点击「添加歌曲」」；空态文案在列表区域内水平+垂直居中。

**播放条**：新增爱心按钮。当前曲已收藏显示实心 ❤（**主题色**），未收藏显示 ♡；点击 = 收藏/取消收藏
（增删于「我最喜欢」），状态随当前曲实时切换。不显示当前列表/范围徽标。

## 3. Host 端新增能力

| 路由 | 方法 | 说明 |
|---|---|---|
| `GET /dsh-music-plus/files?path=` | GET | 文件多选器：列目录 + 音频文件（多选勾选），复用目录浏览体验 |
| `GET /dsh-music-plus/file?path=` | GET/HEAD | 通用流式路由（Range/seek）；**仅放行已登记路径**（歌单成员 ∪ 曲库内路径）防任意访问 |
| `POST /dsh-music-plus/playlist` | POST | `{name}` 新建（空名拒绝；重名允许） |
| `POST /dsh-music-plus/playlist/rename` | POST | `{id,name}`；`fixed` 歌单拒绝 |
| `POST /dsh-music-plus/playlist/delete` | POST | `{id}`；`fixed` 歌单拒绝 |
| `POST /dsh-music-plus/playlist/add` | POST | `{id,paths:[]}` 按路径去重、追加到末尾，跳过无效/非音频 |
| `POST /dsh-music-plus/playlist/remove` | POST | `{id,paths:[]}` 移出歌曲 |
| `POST /dsh-music-plus/playlist/clear` | POST | `{id}` 一键清空（移出全部含已失效；任何歌单都可用，fixed 也可清空） |
| `POST /dsh-music-plus/playlist/reorder` | POST | `{id,paths:[]}` 全量顺序替换（补回未提及的旧成员，防丢歌） |
| `GET /dsh-music-plus/manifest`（扩展） | GET | 追加 `playlists:[{id,name,fixed,count,missing,tracks:[{id,name,url,size,path}]}]`；`pl-fav` 首次启动自动创建 |

### 数据模型

```js
// ~/.dsh/dsh-music-plus-playlists.json
{ version: 1, playlists: [ { id, name, fixed, trackPaths: [absPath, ...], createdAt, updatedAt } ] }
```

- 成员身份 = **绝对路径**（稳定键），不受曲库重扫的 id 变化影响。
- 曲库歌曲仍走 `/dsh-music-plus/<id>`；**歌单成员统一走 `/dsh-music-plus/file?path=`**（路径稳定、URL 稳定）。
- 成员解析：`name = basename(path)`，`size = statSync`；文件已删/不可读 → 计入 `missing` 并从 `tracks` 剔除（存储保留，文件回来自动恢复）。

### 安全

`/dsh-music-plus/file` 仅放行「已登记」路径（属于任一歌单成员或曲库扫描集），避免开放任意路径访问；
`/dsh-music-plus/files` 沿袭 `/dsh-music-plus/dir` 的本地开发定位。

## 4. Web 端引擎（client.js）

- 引入 `scope = { kind:'library' } | { kind:'playlist', id }` 与 `activeIds()`，替换 5 处：
  `step()`、`buildShuffleQueue()/syncShufflePos()`、`prefetchNext()`、`togglePlay()` 默认首曲、`onEnded→step(1)`。
- 歌单成员解析表：`manifest.playlists` 即数据源；`startPlay` 支持按歌单成员 id（`'p:'+path`）解析 url/name，
  成员不依赖 `store.tracks`。
- 范围恢复：localStorage `dsh-music-scope`，刷新后歌单存在则恢复，否则回退全库；
  与现有 `restoreLatest`（断点续播）兼容。
- 爱心状态：当前曲路径 ∈ `pl-fav` → ❤。

## 5. music_play_plus 扩展（M4）

`parameters` 增加 `playlist`（歌单名关键词）。命中 → intent 携带 `playlistId` → 浏览器切范围并播放该歌单；
未命中提示可用歌单。

## 6. 边界情况

1. 文件被移走/失效：manifest 解析时剔除并 `missing` 计数，UI 提示缺失数量，不崩溃。
2. 删除正在播放的歌单：范围回退全库，当前曲继续播放但循环按全库。
3. 移除/删除正在播放的歌单内歌曲：切到歌单内下一首；歌单清空后**回退全库继续播放（明确不做"停止并提示"）**。
4. 歌单与讲书互斥：歌单仅音乐，`stepBook` 不受影响。
5. 重名歌单：允许（id 唯一）。

## 7. 里程碑

| M | 内容 | 预估 |
|---|---|---|
| M1 | Host：歌单 CRUD+reorder+持久化+`pl-fav`+manifest 扩展+`/file`+`/files` 路由+单测 | ~260 行 + 测试 ~160 行 |
| M2 | Web：音乐页子 tab（曲库/❤/＋）+ 歌单详情（添加歌曲/移除/↑↓排序/重命名/删除）+ 文件多选器 | ~260 行 |
| M3 | 播放条爱心按钮 + `activeIds()` 引擎重构 + scope 恢复 | ~150 行 |
| M4 | `music_play_plus` `playlist` 参数 + README/CONTRIBUTING 更新 + 测试补全 | ~100 行 |

每步 `npm test` 全绿 + 本地 `dsh plugin add ./` link 验证。

> 补充：M3 的范围徽标已按用户要求移除（内部 scope 语义保留）；拖拽排序与"空歌单停止提示"明确不做（见上文）。
> 前端回归防线：`test/client.test.js`（jsdom + react-dom）渲染冒烟 + 交互测试（打开面板/切歌单/清空），`npm test` 一并运行。
> 另：歌单详情新增「清空」按钮（所有歌单可用，含系统「我最喜欢」），对应 Host `POST /dsh-music-plus/playlist/clear`。
