/**
 * dsh-music-plus client half: the browser player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock and a floating player panel (track list / modes / volume /
 * spectrum) that also holds the music-directory setting in-panel.
 *
 * Audio is a native <audio> element. A live spectrum (12 log-spaced bands, or an
 * oscilloscope-style waveform) is drawn on a canvas rAF loop, driven solely by a
 * captureStream()+AnalyserNode tap of the playing element — a read-only tap that NEVER
 * reroutes the media element's output, so it can't mute the player (createMediaElementSource,
 * which does reroute, is avoided because it goes silent whenever its AudioContext/graph isn't
 * running and this Chromium throws a "getTopURL" TypeError). There is no offline fallback:
 * if the live tap fails or yields no signal, the visualization simply shows nothing.
 * Play mode and volume persist across reloads
 * via the Host's prefs endpoint (/dsh-music-plus/prefs — no browser storage); the current
 * track + position are restored without autoplay (a tap on ▶ resumes).
 * Host communication is plain HTTP to the /dsh-music-plus/(manifest|intent|set-root|id)
 * routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-plus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const ReactDOM = require('react-dom');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    // Directory/file pickers are rendered into the panel DOM, but the panel's
    // initial height is small (empty track list => only ~200px + 60px), which
    // would clamp the picker and show just a few directory rows. Portal the
    // overlay to <body> (position: fixed; inset: 0) so it spans the whole DSH
    // window instead of the panel, regardless of the panel size.
    const createPortal = (ReactDOM && typeof ReactDOM.createPortal === 'function')
      ? (node, container) => ReactDOM.createPortal(node, container)
      : (node) => node; // defensive fallback (react-dom is always provided by DSH)
    const portalToBody = (node) => createPortal(node, document.body);

    // 把弹层锚定在某个按钮/容器正上方（fixed 定位，居中于其水平中心）。
    // 用于音量/模式/章节目录等从播放条上弹出的弹层：这些弹层所在的按钮组
    // 在折叠（overflow:hidden）容器内，弹层需 portal 到 body 并以 fixed 定位
    // 才能不被裁剪。maxW 为弹层的最大宽度，用于水平 clamp 防止宽弹层溢出视口。
    // 无目标元素时回退到视口底部中央。
    const anchorAbove = (el, maxW = 380) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const margin = 8;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      const top = (r && r.height > 0) ? Math.max(0, r.top - 6) : vh - 40;
      // 居中后 clamp 左边缘，让最大 maxW 宽的弹层完整落在视口内。
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      return { position: 'fixed', left: Math.round(left), top: Math.round(top), transform: 'translate(-50%, -100%)' };
    };

    // 自动高度弹窗（可变高度）专用锚定：与音量/播放顺序弹窗同款「按钮正上方」效果，
    // 但内容高度不固定（章节目录列表、讲书音量弹窗的 AI 声音选择 + 音量滑块等）。
    // anchorAbove 用 top+translateY(-100%)，弹窗过高时会顶到视口顶被截断、且 top 被
    // clamp 后底边脱离按钮。这里改用 bottom 锚定：底边始终贴住按钮上方 6px（绝不
    // 脱开），高度限制为「视口内可用空间 ∩ 合理上限（60vh / 480px）」，保证弹窗
    // 完整可见且紧贴播放条。固定高度的小弹窗（音量 36px/播放顺序）仍用 anchorAbove。
    const anchorPopAbove = (el, maxW = 380) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const margin = 8;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      const base = { position: 'fixed', left: Math.round(left), transform: 'translateX(-50%)' };
      if (!r || r.height <= 0) {
        // 回退：视口底部中央、贴底显示（无锚点时也能看到完整弹窗）。
        return { ...base, bottom: margin, maxHeight: Math.min(60 * vh / 100, 480) };
      }
      // 底边 = 按钮顶 - 6px（bottom 为距视口底边的距离）；高度上限 = 可用空间 ∩ 合理上限。
      const topGap = 8; // 弹窗顶部到视口顶至少留 8px
      const avail = Math.max(120, r.top - 6 - topGap);
      return {
        ...base,
        bottom: Math.round(vh - r.top + 6),
        maxHeight: Math.round(Math.min(60 * vh / 100, 480, avail)),
      };
    };
    // 搜索历史下拉专用：锚定在搜索框正下方（fixed，左边缘与搜索框对齐、宽度一致），
    // portal 到 body 以避开 .dsh-music-panel(overflow:hidden) / .dsh-music-qq-body
    // (overflow-y:auto) 的裁剪（否则下拉在真实浏览器里不可见）。无锚点时回退到
    // 视口顶部中央。
    const anchorBelow = (el, maxW = 420) => {
      const vw = window.innerWidth;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const margin = 8;
      const width = Math.min((r && r.width > 0) ? r.width : 380, maxW, vw - margin * 2);
      const left = (r && r.width > 0)
        ? Math.max(margin, Math.min(vw - margin - width, r.left))
        : Math.max(margin, Math.round((vw - width) / 2));
      const top = (r && r.height > 0) ? Math.round(r.bottom + 4) : margin;
      return { position: 'fixed', left: Math.round(left), top, width: Math.round(width), maxHeight: 240 };
    };

    // 以播放面板中心为基准的固定定位样式（面板可拖拽，弹窗随其居中）。
    // halfW 为目标弹窗的近似半宽；maxH 为弹窗最大高度（px）：垂直 clamp 用
    // maxH 的一半，保证 translate 居中后弹窗完整落在视口内；内容超过 maxH 时
    // 由内部 .dsh-music-picker-list 滚动承载（底部按钮保持固定可见）。
    // 面板不可见/无尺寸（如关闭态）时回退到视口中心。on 控制是否真正计算。
    const panelCenterStyle = (panelRef, on, halfW, maxH) => {
      if (!on) return null;
      const pr = (panelRef && panelRef.current) ? panelRef.current.getBoundingClientRect() : null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cx = (pr && pr.width > 0) ? pr.left + pr.width / 2 : vw / 2;
      const cy = (pr && pr.height > 0) ? pr.top + pr.height / 2 : vh / 2;
      const clampC = (v, lo, hi) => (lo <= hi ? Math.max(lo, Math.min(v, hi)) : v);
      const halfWm = Math.min(halfW, vw / 2);
      const halfHm = Math.min(maxH / 2, vh / 2);
      return {
        position: 'fixed',
        left: clampC(cx, halfWm, vw - halfWm),
        top: clampC(cy, halfHm, vh - halfHm),
        transform: 'translate(-50%, -50%)',
        maxHeight: maxH + 'px',
        margin: 0,
      };
    };

    // This host/environment throws a harmless, unhandled rejection from
    // Chromium's media pipeline — "Cannot read properties of undefined (reading
    // 'getTopURL')" — whenever an <audio> element loads or plays. Playback and
    // position handling are unaffected, so swallow just that specific error to
    // keep the console clean. Registered at module scope (before any media op)
    // and covering all three surfacing paths.
    (() => {
      const isGetTopUrl = (value) => {
        try { return String((value && value.message) || value || '').indexOf('getTopURL') !== -1; } catch { return false; }
      };
      window.addEventListener('unhandledrejection', (ev) => {
        if (isGetTopUrl(ev && ev.reason)) ev.preventDefault();
      });
      window.addEventListener('error', (ev) => {
        if (isGetTopUrl(ev && ev.message)) ev.preventDefault();
      });
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        const origError = console.error.bind(console);
        console.error = (...args) => {
          if (args.some(isGetTopUrl)) return;
          origError(...args);
        };
      }
    })();

    // ---- persisted prefs (Host-backed, with legacy browser-storage fallback) ----
    // Every pref lives in the Host's dsh-music-plus-prefs.json, served via
    // GET/POST /dsh-music-plus/prefs and held in the in-memory `serverPrefs`
    // snapshot here. dsh-desktop starts the Harness web server on a RANDOM port
    // each launch, so the page origin changes every time — browser localStorage
    // (keyed by origin) is therefore NOT authoritative and is never written.
    // localStorage is kept only as a READ-ONLY upgrade source: old builds (<0.7)
    // persisted these same key names there, so on upgrade we read Host first and
    // fall back to the old browser copy, migrate it into the Host, then delete
    // the browser copy. No user data is lost and no new data touches the browser.
    const PREF_MODE = 'dsh-music-mode';
    const PREF_VOL = 'dsh-music-volume';
    const PREF_PLAYBACK = 'dsh-music-playback';      // 本地音乐/播客播放进度（单键，按 kind 区分）
    const PREF_PANEL_POS = 'dsh-music-panel-pos';
    const PREF_SCOPE = 'dsh-music-scope';
    const PREF_SHOW_VIZ = 'dsh-music-show-viz';       // 播放条频谱显示开关（默认开）
    const PREF_VIZ_MODE = 'dsh-music-viz-mode';       // 播放条频谱样式：'bars' 柱状图 | 'wave' 波形图（默认柱状图）
    const PREF_SHOW_PROGRESS = 'dsh-music-show-progress'; // 播放条进度条显示开关（默认开）
    const PREF_SHOW_QUALITY = 'dsh-music-show-quality'; // 歌名后音质徽章显示开关（默认开）
    const PREF_SHOW_BAR_BG = 'dsh-music-show-bar-bg'; // 播放条边框/背景色显示开关（默认开）
    const PREF_IMMERSE = 'dsh-music-immerse';         // 沉浸感：播放条闲置态透明度 0..1（默认 0.5）
    // Every persisted key: written via savePref, read via loadPref, mirrored to
    // the Host on a debounced flush.
    const PREF_KEYS = new Set([
      PREF_MODE, PREF_VOL, PREF_SCOPE, PREF_PANEL_POS,
      PREF_PLAYBACK,
      PREF_SHOW_VIZ, PREF_VIZ_MODE, PREF_SHOW_PROGRESS, PREF_SHOW_QUALITY, PREF_SHOW_BAR_BG, PREF_IMMERSE,
    ]);
    let serverPrefs = null;          // null = Host snapshot not fetched yet
    let serverPrefsFetched = false;  // distinguishes "not fetched" from an early savePref
    const serverDirtyKeys = new Set(); // keys changed since the last flush
    const serverRemoveKeys = new Set(); // keys cleared since the last flush
    let serverFlushTimer = null;
    let serverFlushSeq = 0;
    // Legacy browser-storage accessors (safe; quota/security errors are ignored).
    // localStorage is READ-ONLY here: it is only a source for upgrading old
    // (<0.7) records into the Host. The client never writes new data to it.
    const legacyGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const legacyRemove = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    function loadPref(k) {
      if (!PREF_KEYS.has(k)) return null;
      // Host is authoritative — it survives origin changes (random port).
      if (serverPrefs !== null && Object.prototype.hasOwnProperty.call(serverPrefs, k)) {
        return serverPrefs[k];
      }
      // Upgrade compatibility: if the Host has no record yet, fall back to the
      // old browser localStorage copy (same key names). loadServerPrefs migrates
      // it into the Host after the snapshot is fetched.
      return legacyGet(k);
    }
    function savePref(k, v) {
      if (!PREF_KEYS.has(k)) return;
      serverPrefs = serverPrefs || {};
      serverPrefs[k] = v;
      serverRemoveKeys.delete(k);
      serverDirtyKeys.add(k);
      // Host-only: no mirror write to localStorage. All data lives in the Host.
      scheduleServerPrefsFlush();
    }
    function clearPref(k) {
      if (!PREF_KEYS.has(k)) return;
      serverPrefs = serverPrefs || {};
      delete serverPrefs[k];
      serverDirtyKeys.delete(k);
      serverRemoveKeys.add(k);
      // Also drop the legacy browser copy — otherwise loadPref would resurrect
      // a cleared value from localStorage on the next read.
      legacyRemove(k);
      scheduleServerPrefsFlush();
    }
    function scheduleServerPrefsFlush() {
      if (serverFlushTimer !== null) return;
      serverFlushTimer = setTimeout(() => { serverFlushTimer = null; void flushServerPrefs(); }, 800);
    }
    async function flushServerPrefs() {
      const seq = ++serverFlushSeq;
      const patch = {};
      for (const k of serverDirtyKeys) {
        if (serverRemoveKeys.has(k)) continue;
        if (serverPrefs && Object.prototype.hasOwnProperty.call(serverPrefs, k)) patch[k] = serverPrefs[k];
      }
      const remove = [...serverRemoveKeys];
      serverDirtyKeys.clear();
      serverRemoveKeys.clear();
      if (Object.keys(patch).length === 0 && remove.length === 0) return;
      try { console.info('[dsh-music-plus] flush /prefs keys=', Object.keys(patch).join(','), 'len=', JSON.stringify({ prefs: patch }).length); } catch (e) {}
      const payload = JSON.stringify({ prefs: patch, remove });
      // keepalive survives page teardown (pagehide flush), but browsers cap a
      // keepalive body at 64KiB and THROW on anything larger — a long QQ queue
      // (the playback save embeds the whole queue) easily exceeds that, which
      // silently dropped playback POSTs. Use keepalive only for small payloads;
      // larger ones go out as a plain fetch (the periodic ~5s saves keep the
      // state current, so a pagehide cutoff is not a real loss).
      const useKeepalive = payload.length <= 60 * 1024;
      try {
        const r = await fetch('/dsh-music-plus/prefs', {
          method: 'POST', cache: 'no-store', keepalive: useKeepalive,
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        if (r.ok && seq === serverFlushSeq) {
          const d = await r.json();
          if (d && d.prefs && typeof d.prefs === 'object') {
            // The server confirms our merge. Keep any value that changed locally
            // while this request was in flight (dirty keys / pending removals win
            // over the response), so a concurrent save is never overwritten.
            serverPrefs = { ...d.prefs, ...serverPrefs };
            for (const k of serverRemoveKeys) delete serverPrefs[k];
          }
        }
      } catch { /* best-effort: the change stays in the in-memory snapshot */ }
    }
    // Fetch the Host snapshot once; merge any pre-fetch local writes on top so
    // an early savePref (before the fetch resolves) is never lost. On a cold
    // start the page can load before the plugin's routes are registered, so a
    // failed/empty first read is retried briefly instead of silently skipping
    // the whole restore (that was why "restart shows nothing" could happen).
    async function loadServerPrefs() {
      if (serverPrefsFetched) return serverPrefs;
      const local = serverPrefs; // possibly written by an early savePref
      let got = false; // route responded with a valid prefs shape
      for (let attempt = 0; attempt < 4 && !got; attempt++) {
        let fetched = {};
        try {
          const d = await jsonGet('/dsh-music-plus/prefs');
          if (d && d.prefs && typeof d.prefs === 'object') { fetched = d.prefs; got = true; }
        } catch { /* transient: route not ready yet */ }
        serverPrefs = { ...fetched, ...(local || {}) };
        if (!got && attempt < 3) await new Promise((r) => setTimeout(r, 250));
      }
      serverPrefsFetched = true;
      migrateLegacyBrowserPrefs();
      return serverPrefs;
    }
    // Upgrade path: adopt any old localStorage record the Host does not yet
    // have (so a <0.7 browser copy survives the move to Host storage). Runs
    // once, after the Host snapshot is fetched, so Host values always win. Once
    // a record is adopted its browser copy is removed — localStorage is a
    // read-only migration source and never holds data after it has been claimed
    // by the Host.
    function migrateLegacyBrowserPrefs() {
      // Any other legacy key: if the Host lacks it, adopt the browser copy (Host
      // becomes authoritative) and remove the browser copy; if the Host already
      // has it, just drop the stale browser duplicate. Either way localStorage
      // ends up holding none of the managed prefs — it is only a one-way upgrade
      // source and never keeps data once the Host snapshot has claimed it.
      for (const k of PREF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(serverPrefs, k)) {
          legacyRemove(k);
          continue;
        }
        const v = legacyGet(k);
        if (v !== null) {
          savePref(k, v);
          legacyRemove(k);
        }
      }
    }
    // Apply persisted mode / volume to the store + audio element.
    // Mutates directly (no set()) so a pre-startup call does not re-trigger
    // savePref; a later set() from loadTracks re-renders the UI.
    function applyStoredPrefs() {
      try {
        const m = loadPref(PREF_MODE);
        if (m === 'single' || m === 'order' || m === 'shuffle') store.mode = m;
        const v = parseFloat(loadPref(PREF_VOL));
        if (Number.isFinite(v)) { store.volume = Math.min(1, Math.max(0, v)); audio.volume = store.volume; }
        // 系统配置开关：默认开启（缺省即 true）。
        const showViz = loadPref(PREF_SHOW_VIZ);
        if (showViz === '0') store.showViz = false;
        const vizMode = loadPref(PREF_VIZ_MODE);
        if (vizMode === 'wave') store.vizMode = 'wave'; // else keep default 'bars'
        const showProgress = loadPref(PREF_SHOW_PROGRESS);
        if (showProgress === '0') store.showProgress = false;
        const showQuality = loadPref(PREF_SHOW_QUALITY);
        if (showQuality === '0') store.showQuality = false;
        const showBarBg = loadPref(PREF_SHOW_BAR_BG);
        if (showBarBg === '0') store.showBarBg = false;
        // 沉浸感：0..1，缺省 0.5。钳制到合法区间防止脏数据。
        const immerse = parseFloat(loadPref(PREF_IMMERSE));
        if (Number.isFinite(immerse)) store.immerse = Math.min(1, Math.max(0, immerse));
      } catch (e) {}
    }
    // Playback-panel geometry: default CSS width (must match .dsh-music-panel),
    // resize bounds, and the viewport-height fraction cap when user-resized.
    const PANEL_W = 600;
    const PANEL_MIN_W = 320;
    const PANEL_MAX_W = 720;
    const PANEL_MIN_H = 200;
    const PANEL_MAX_H_VH = 0.8;
    // Auto-size (never-dragged) default height. The panel's height is content-
    // driven (CSS max-height:72vh), but a fresh install has an empty track list
    // whose min-height is only ~60px, so the panel would open absurdly short.
    // Give the auto-size panel a comfortable default minimum so first-use looks
    // right; this only applies while pos === null (never dragged/resized).
    const PANEL_AUTO_MIN_H = '45vh';
    // Restore the playback-panel position ({x,y,w,h}) previously saved by
    // dragging/resizing, if any. Old saves ({x,y,h}) migrate with a default width.
    function loadPanelPos() {
      const raw = loadPref(PREF_PANEL_POS);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number'
          && typeof p.h === 'number' && p.h > 0) {
          return { x: p.x, y: p.y, w: (typeof p.w === 'number' && p.w > 0) ? p.w : PANEL_W, h: p.h };
        }
      } catch (e) {}
      return null;
    }
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    // ---- engine + shared store (React re-renders on set) ----
    const VIZ_BARS = 12; // spectrum bars (log-spaced real FFT bands)
    const PEAK_DECAY = 0.012; // peak-cap fall per frame (~1.3s, visible 渐落 trail)
    // 波形图垂直振幅放大：固定放大 VIZ_WAVE_GAIN 只作上限，实际每帧按各频段的
    // 慢峰值自适应（见 analyseLiveWave 的 vizBandGain）：大声段落回落到下限 1x
    // （保持全幅、不压缩响度），安静段落最多提到 VIZ_WAVE_GAIN 倍（保持可见），
    // 峰值在 ~1s 内缓慢回落，因此响度变化仍能被看见。音乐峰值很少触及满幅
    // （byte 0/255），默认波形只占画布高度的一小部分；放大后超出画布的上下沿会
    // 被 canvas 自然裁掉，形成顶到边的观感。
    const VIZ_WAVE_GAIN = 2.0;          // 自适应增益上限（安静段落最大放大）
    const VIZ_WAVE_GAIN_MIN = 1.0;      // 增益下限（大声段落保持全幅）
    const VIZ_WAVE_PEAK_TARGET = 0.45;  // 慢峰值归一目标：满幅 → 约 90% 半画布高
    const VIZ_WAVE_PEAK_DECAY = 0.985;  // 慢峰值每帧回落系数（~1s 释放 @60fps）
    // 波形图「分频段多线」：把时域波形按频率分成这几段，每段各自合成一条曲线，形成
    // 层次感（低/中/高频各自起伏）。边界单位为 Hz（与采样率无关的绝对频率）。
    const VIZ_WAVE_BANDS = [
      { label: 'low', lo: 40, hi: 300, alpha: 1.0, width: 1.0 },   // 低音（主轮廓）
      { label: 'mid', lo: 300, hi: 4000, alpha: 0.55, width: 0.8 }, // 中频
      { label: 'high', lo: 4000, hi: 18000, alpha: 0.3, width: 0.6 }, // 高频
    ];
    const audio = new Audio();
    audio.preload = 'auto';
    // Attach the media element to the document (hidden) so it has a proper DOM /
    // document association (some browsers handle attached media elements more
    // predictably). body may not exist yet at module eval, so defer the attach
    // until apply() runs (body is ready there).
    let audioAttached = false;
    function attachAudioElements() {
      if (audioAttached) return;
      audioAttached = true;
      try {
        audio.style.display = 'none';
        if (audio.parentNode === null) document.body.appendChild(audio);
      } catch (e) { /* non-fatal */ }
    }

    // Autoplay unlock without touching the playing <audio> element (which would
    // interrupt playback). Browsers block <audio>.play() once the synchronous
    // user gesture is gone — which is what happens after the async TTS synthesis
    // takes a second or two. Calling audioCtx.resume() synchronously inside the
    // click grants the page sticky audio activation, so the later async play()
    // is allowed. On macOS the context usually runs anyway; on Windows/Chrome
    // this resume is what makes auto-play work.
    let unlockCtx = null;
    function unlockAutoplay() {
      try {
        if (unlockCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          unlockCtx = new Ctor();
        }
        if (unlockCtx.state === 'suspended') {
          const p = unlockCtx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* unlock is best-effort */ }
      // The live-spectrum analyser rides its own AudioContext; resume it too so
      // the bars react on the very first frame after the gesture that unlocks
      // autoplay (books + online QQ) rather than staying silent.
      resumeVizCtx();
    }

    const store = {
      root: null, tracks: [], count: 0, currentId: null, currentName: null,
      // 本地曲目的「格式 · 音质」标签（如 FLAC · 无损 / MP3 · 高音质），随播放流响应头回传；
      // 空串 = 未取到 / 不可读，播放条只显示歌名。
      currentQuality: '',
      playing: false, position: 0, duration: 0, volume: 0.8,
      panelOpen: false, loading: false, error: null, pendingId: null, pendingName: null,
      mode: 'order', vizMode: 'bars', tab: 'music',
      // true once the Host prefs snapshot is loaded (volume/mode/playback from
      // /dsh-music-plus/prefs are authoritative); panel position re-applies on it.
      prefsReady: false,
      // 系统配置：频谱 / 进度条 / 音质徽章 / 外壳边框背景显示开关（默认开启，存 Host prefs）。
      showViz: true, showProgress: true, showQuality: true, showBarBg: true,
      // 沉浸感：播放条闲置态透明度（0..1，默认 0.5），存 Host prefs。
      immerse: 0.5,
      // 播放模式弹层是否打开（portal 到 body 时让播放条按钮保持展开、不因移出而收起）。
      modeMenuOpen: false,
      // 自建歌单：manifest.playlists 即数据源；scope 为当前播放范围（曲库/歌单），
      // subTab 为音乐页内的子标签（'library' 或歌单 id）。
      playlists: [], scope: { kind: 'library' }, subTab: 'library',
      // 自定义输入弹窗（替代浏览器 prompt）：{ id, title, initial, onOk } | null。
      prompt: null,
      // 自定义确认弹窗（替代浏览器 confirm）：{ title, message, onOk, okText, danger } | null。
      confirm: null,
      // 「加入歌单」成功/失败提示：{ text, ok, id } | null。面板窗口内居中显示，2s 自动消失。
      toast: null,
      // 播客：订阅列表 + 正在播放的订阅单集队列（scope.kind==='podcast' 时）。
      podcasts: [], podcastQueue: [], podcastQueueSource: null,
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      if ('mode' in patch) savePref(PREF_MODE, patch.mode);
      if ('volume' in patch) savePref(PREF_VOL, String(patch.volume));
      if ('scope' in patch) savePref(PREF_SCOPE, JSON.stringify(patch.scope));
      if ('showViz' in patch) savePref(PREF_SHOW_VIZ, patch.showViz ? '1' : '0');
      if ('vizMode' in patch) savePref(PREF_VIZ_MODE, patch.vizMode === 'wave' ? 'wave' : 'bars');
      if ('showProgress' in patch) savePref(PREF_SHOW_PROGRESS, patch.showProgress ? '1' : '0');
      if ('showQuality' in patch) savePref(PREF_SHOW_QUALITY, patch.showQuality ? '1' : '0');
      if ('showBarBg' in patch) savePref(PREF_SHOW_BAR_BG, patch.showBarBg ? '1' : '0');
      if ('immerse' in patch) savePref(PREF_IMMERSE, String(Math.min(1, Math.max(0, patch.immerse))));
      for (const fn of [...listeners]) fn();
    }
    function useStore() {
      const [snap, setSnap] = useState(store);
      useEffect(() => {
        const update = () => setSnap({ ...store });
        listeners.add(update);
        update();
        return () => { listeners.delete(update); };
      }, []);
      return snap;
    }
    // 「加入歌单」成功/失败提示：统一在面板窗口内居中显示（成功绿色 / 失败红色），
    // 2 秒后自动消失。连续触发时只保留最后一条（前一条立即被顶掉）。
    let toastTimer = null;
    let toastSeq = 0;
    function showToast(text, ok) {
      const id = ++toastSeq;
      set({ toast: { text, ok: !!ok, id } });
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (store.toast && store.toast.id === id) set({ toast: null });
      }, 2000);
    }
    // 自定义输入弹窗（替代浏览器 prompt）：openPrompt 打开、closePrompt 关闭，
    // onOk(value) 在用户点「确定」时收到去空格后的值；点「取消」/关闭不回调。
    let promptSeq = 0;
    function openPrompt(title, initial, onOk) {
      set({ prompt: { id: ++promptSeq, title, initial: (initial || ''), onOk } });
    }
    function closePrompt() {
      set({ prompt: null });
    }
    // 自定义确认弹窗（替代浏览器 confirm）：点「确定」回调 onOk()；
    // 点「取消」/关闭/Esc 不回调。danger=true 时确定按钮用危险色提示。
    function openConfirm(title, message, onOk, okText, danger) {
      set({ confirm: { title, message: (message || ''), onOk, okText: (okText || '确定'), danger: !!danger } });
    }
    function closeConfirm() {
      set({ confirm: null });
    }

    const trackById = (id) => (store.tracks || []).find((t) => t.id === id) || null;

    // ---- 自建歌单：范围 / 解析 / 收藏 ----
    const FAV_PLAYLIST_ID = 'pl-fav';
    const playlistById = (id) => (store.playlists || []).find((p) => p.id === id) || null;
    // 解析任意可播放对象：歌单成员 id（'p:'+path）优先，其次曲库曲目。
    function resolvePlayable(id) {
      if (id === null || id === undefined) return null;
      if (String(id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === id);
          if (m) return m;
        }
        return null;
      }
      if (String(id).startsWith('pod:')) {
        const idx = Number(String(id).slice(4).split(':')[0]);
        const ep = (store.podcastQueue || [])[idx];
        if (!ep) return null;
        const src = store.podcastQueueSource;
        return { id, name: ep.title || '未命名单集', url: ep.url, artists: src && src.title ? [src.title] : [], quality: '' };
      }
      return trackById(id);
    }
    // 当前范围的有序 id 列表：歌单非空则用歌单，否则回退曲库（空/已删歌单优雅回退）。
    function activeIds() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'playlist') {
        const pl = playlistById(s.id);
        if (pl && pl.tracks && pl.tracks.length > 0) return pl.tracks.map((t) => t.id);
        return (store.tracks || []).map((t) => t.id);
      }
      if (s.kind === 'podcast') {
        return (store.podcastQueue || []).map((e, i) => 'pod:' + i);
      }
      return (store.tracks || []).map((t) => t.id);
    }
    function scopeKey() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'playlist') return 'pl:' + s.id;
      if (s.kind === 'podcast') return 'pod:' + s.id;
      return 'lib';
    }
    // 当前播放曲目对应的绝对路径（用于收藏判断）。
    function currentTrackPath() {
      if (store.currentId === null) return null;
      if (String(store.currentId).startsWith('p:')) return String(store.currentId).slice(2);
      if (String(store.currentId).startsWith('pod:')) return null;
      const t = trackById(store.currentId);
      return t && t.path ? t.path : null;
    }
    function isCurrentFaved() {
      const path = currentTrackPath();
      if (path === null) return false;
      const fav = playlistById(FAV_PLAYLIST_ID);
      return fav !== null && (fav.tracks || []).some((m) => m.path === path);
    }
    function updatePlaylistInStore(pl) {
      if (!pl || !pl.id) return;
      set({ playlists: (store.playlists || []).map((p) => (p.id === pl.id ? pl : p)) });
    }
    function apiPlaylistAdd(id, paths, then) {
      fetch('/dsh-music-plus/playlist/add', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => { if (then) then(null); });
    }
    function apiPlaylistRemove(id, paths, then) {
      fetch('/dsh-music-plus/playlist/remove', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => {});
    }
    function apiPlaylistReorder(id, paths) {
      fetch('/dsh-music-plus/playlist/reorder', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
    }
    // ---- 播客：订阅 / 刷新 / 退订 / 播放 ----
    function loadPodcastsFromHost() {
      fetch('/dsh-music-plus/podcasts', { cache: 'no-store' })
        .then((r) => r.json())
        .then((r) => { if (r && Array.isArray(r.podcasts)) set({ podcasts: r.podcasts }); })
        .catch(() => {});
    }
    function apiPodcastAdd(url, then) {
      fetch('/dsh-music-plus/podcasts/add', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
      }).then((r) => r.json())
        .then((r) => { if (r && r.podcast) set({ podcasts: (store.podcasts || []).filter((p) => p.id !== r.podcast.id).concat([r.podcast]) }); if (then) then(r); })
        .catch(() => { if (then) then(null); });
    }
    function apiPodcastRemove(id, then) {
      fetch('/dsh-music-plus/podcasts/remove', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then((r) => r.json())
        .then(() => { set({ podcasts: (store.podcasts || []).filter((p) => p.id !== id) }); if (then) then(r); })
        .catch(() => { if (then) then(null); });
    }
    function apiPodcastRefresh(id, then) {
      fetch('/dsh-music-plus/podcasts/refresh', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then((r) => r.json())
        .then((r) => { if (r && r.podcast) set({ podcasts: (store.podcasts || []).map((p) => (p.id === id ? r.podcast : p)) }); if (then) then(r); })
        .catch(() => { if (then) then(null); });
    }
    // 播放某一订阅的一集：把该订阅设为播放来源（podcast scope），用现有播放器流播。
    function playPodcastEp(podId, idx) {
      const pod = (store.podcasts || []).find((p) => p.id === podId);
      if (!pod) return;
      const eps = pod.episodes || [];
      if (!eps[idx]) return;
      try { console.info('[dsh-music-plus] playPodcastEp podId=', podId, 'idx=', idx); } catch (e) {}
      set({ scope: { kind: 'podcast', id: podId }, podcastQueue: eps, podcastQueueSource: { podId, title: pod.title } });
      startPlay('pod:' + idx);
    }
    // 收藏切换：加入/移出「我最喜欢」。
    function toggleFav() {
      const path = currentTrackPath();
      if (path === null) return;
      const fav = playlistById(FAV_PLAYLIST_ID);
      if (fav === null) return;
      if (isCurrentFaved()) apiPlaylistRemove(FAV_PLAYLIST_ID, [path]);
      else apiPlaylistAdd(FAV_PLAYLIST_ID, [path]);
    }
    // 从歌单/曲库点歌：来源即范围。
    function startPlayFrom(id, kind, plId) {
      if (kind === 'playlist') set({ scope: { kind: 'playlist', id: plId } });
      else set({ scope: { kind: 'library' } });
      startPlay(id);
    }
    // 歌单管理：新建 / 重命名 / 删除 / 移动歌曲。
    function onCreatePlaylist() {
      openPrompt('新建歌单名称', '', (trimmed) => {
        if (!trimmed) return;
        fetch('/dsh-music-plus/playlist', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) {
            set({ playlists: [...(store.playlists || []), r.playlist], subTab: r.playlist.id });
          }
        }).catch(() => {});
      });
    }
    function onRenamePlaylist(pl) {
      openPrompt('重命名歌单「' + pl.name + '」', pl.name, (trimmed) => {
        if (trimmed === pl.name) return;
        fetch('/dsh-music-plus/playlist/rename', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id, name: trimmed }),
        }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
      });
    }
    function onDeletePlaylist(pl) {
      openConfirm('删除歌单', '删除歌单「' + pl.name + '」？歌曲文件不会被删除。', () => {
        fetch('/dsh-music-plus/playlist/delete', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.ok) {
            const next = (store.playlists || []).filter((p) => p.id !== pl.id);
            set({ playlists: next, subTab: 'library' });
            if (store.scope && store.scope.kind === 'playlist' && store.scope.id === pl.id) {
              set({ scope: { kind: 'library' } });
            }
          }
        }).catch(() => {});
      }, '删除', true);
    }
    // 一键清空歌单（任何歌单都可用，含系统「我最喜欢」；仅从歌单移除，不删文件）。
    function onClearPlaylist(pl) {
      const n = (pl.tracks || []).length;
      if (n === 0 && !pl.missing) return;
      openConfirm('清空歌单', '清空歌单「' + pl.name + '」？将移除全部 ' + n + ' 首歌曲' + (pl.missing > 0 ? '（另有 ' + pl.missing + ' 首已失效一并清除）' : '') + '，歌曲文件不会被删除。', () => {
        fetch('/dsh-music-plus/playlist/clear', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) updatePlaylistInStore(r.playlist);
        }).catch(() => {});
      }, '确定', true);
    }
    function movePlaylistTrack(pl, path, dir) {
      const paths = (pl.tracks || []).map((t) => t.path);
      const i = paths.indexOf(path);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= paths.length) return;
      const next = paths.slice();
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
      apiPlaylistReorder(pl.id, next);
    }

    // restore persisted prefs (mode/volume/voice). Runs again after the Host
    // snapshot is fetched (loadTracks), where the Host value is authoritative.
    applyStoredPrefs();

    // 播客断点专用：即时 POST 到 /dsh-music-plus/podcast-play（独立持久化通道，
    // 不走 prefs flush），确保播客进度不被本地音乐/时序竞争覆盖。
    function persistPodcastPlayRemote(podId, epIdx, pos, dur) {
      fetch('/dsh-music-plus/podcast-play', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          podId, epIdx, name: store.currentName || '', position: pos, duration: dur,
          queueSource: store.podcastQueueSource || null,
          queue: (store.podcastQueue || []).map((e) => ({ title: e.title, url: e.url })),
        }),
      }).then(() => {}).catch(() => {});
    }

    // Persist the current playback position (PREF_PLAYBACK). Covers both local
    // music (library/playlist) and podcast episodes, so a refresh/resume at any
    // moment can restore the exact track + position. (stop() clears it; a null
    // currentId here means stopped.)
    function savePlayback() {
      if (store.currentId === null) return;
      const scope = store.scope || { kind: 'library' };
      const pos = (restoredMusicPos !== null && restoredMusicPos > 0) ? restoredMusicPos : (audio.currentTime || 0);
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const base = { position: pos, duration: dur, ts: Date.now() };
      try { console.info('[dsh-music-plus] savePlayback scope=', scope.kind, 'currentId=', store.currentId); } catch (e) {}
      if (scope.kind === 'podcast') {
        const m = String(store.currentId).match(/^pod:(\d+)$/);
        const epIdx = m ? Number(m[1]) : null;
        try { console.info('[dsh-music-plus] ✔ saved podcast playback', { podId: scope.id, epIdx, pos, dur }); } catch (e) {}
        // 走专用断点通道（即时 POST，不走 prefs flush），确保播客进度独立落盘、
        // 不被本地音乐覆盖。
        persistPodcastPlayRemote(scope.id, epIdx, pos, dur);
        // 兜底也写一份到 PREF_PLAYBACK（旧白名单允许），双保险。
        savePref(PREF_PLAYBACK, JSON.stringify({
          kind: 'podcast', scope: { kind: 'podcast', id: scope.id },
          podId: scope.id, epIdx, name: store.currentName || '', ...base,
          queueSource: store.podcastQueueSource || null,
          queue: (store.podcastQueue || []).map((e) => ({ title: e.title, url: e.url })),
        }));
      } else {
        savePref(PREF_PLAYBACK, JSON.stringify({ kind: 'local', scope, id: store.currentId, name: store.currentName, ...base }));
      }
    }
    function loadPlayback() {
      const raw = loadPref(PREF_PLAYBACK);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        // Accept both the legacy local shape ({id}) and the podcast shape ({kind:'podcast'}).
        if (p && (p.kind === 'podcast' || typeof p.id === 'string')) return p;
      } catch (e) {}
      return null;
    }


    // ---- bar color + canvas drawing ----
    let barCanvasNode = null;
    let rafId = null;
    const smoothCur = new Float32Array(VIZ_BARS);
    const smoothPeak = new Float32Array(VIZ_BARS);
    const targetBuf = new Float32Array(VIZ_BARS);
    // Accent color for the spectrum bars. DSH defines its --dsw-alias-* theme
    // tokens on <body> — never on :root — so --dsh-music-accent must be read
    // from body (reading documentElement would always return the fallback and
    // the bars would never follow the theme). The value is cached but the cache
    // is invalidated whenever the theme changes at runtime: the ThemePresenter
    // projects tokens + the dark attribute onto body, so a MutationObserver on
    // body's style/dark-attribute keeps the bars tracking live brand changes.
    let accentColor = null;
    let accentObserver = null;
    function readAccent() {
      const el = document.body || document.documentElement;
      return getComputedStyle(el).getPropertyValue('--dsh-music-accent').trim() || '#2f9e6e';
    }
    function currentAccent() {
      if (accentColor === null) accentColor = readAccent();
      return accentColor;
    }
    // A peak-cap color that ALWAYS contrasts with the bar, whatever the theme:
    // parse the accent (hex or rgb) and push it toward white if it's dark, toward
    // black if it's light — so the trailing "渐落" line stays visible on both dark
    // and light themes (a fixed white cap would vanish on light themes).
    function parseColor(color) {
      if (typeof color !== 'string') return null;
      let m = /^#([0-9a-f]{3})$/i.exec(color);
      if (m) { const n = parseInt(m[1], 16); return [((n >> 8) & 0xf) * 17, ((n >> 4) & 0xf) * 17, (n & 0xf) * 17]; }
      m = /^#([0-9a-f]{6})$/i.exec(color);
      if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
      m = /^rgba?\(([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(color);
      if (m) return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
      return null;
    }
    function capColorFor(color) {
      const rgb = parseColor(color);
      if (rgb === null) return color; // can't derive → keep the bar color (no worse than before)
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      const target = lum > 128 ? 0 : 255;
      const mix = (v) => Math.round(v + (target - v) * 0.75);
      return 'rgb(' + mix(rgb[0]) + ',' + mix(rgb[1]) + ',' + mix(rgb[2]) + ')';
    }
    function watchAccent() {
      if (accentObserver !== null) return accentObserver;
      if (typeof MutationObserver === 'undefined') return null;
      accentObserver = new MutationObserver(() => { accentColor = readAccent(); });
      accentObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] });
      return accentObserver;
    }

    // ---- live real-time analyser (BEST-EFFORT tap; NEVER reroutes audio) ----
    // captureStream() is a read-only TAP of the playing <audio>: it does NOT redirect
    // the element's output (unlike createMediaElementSource, which routes it into the
    // Web Audio graph and goes SILENT whenever that graph/context isn't running — which
    // is exactly what killed the audio after switching a few tracks). So this can never
    // mute the player: worst case the analyser reads silence and the visualization
    // simply shows nothing (no offline fallback — "失败即不显示").
    //
    // It's created only once the element has a real src (startPlay / the play event) so
    // the captured MediaStream carries an audio track. If this browser's media pipeline
    // still refuses a track (the getTopURL bug), vizLive stays false and we draw nothing.
    // Fixed per-band frequency-weighting gain (0..1, top band = 1) used by the live
    // analyser. A raw frequency read is an ABSOLUTE dB magnitude, and music's natural 1/f
    // (bass-heavy) tilt maps the low bands near the top while the high bands sit low. This
    // FIXED, level-independent weighting flattens the SHAPE while ABSOLUTE loudness still
    // drives each bar — a quiet passage stays low (no per-band auto-gain, which would inflate a
    // quiet band to full). gain[b] = (center_b / center_top) ^ ALPHA. With ALPHA=0.12 the low
    // band is attenuated to ~0.53 while the top band keeps 1.0 — enough to counter the typical
    // bass-heavy envelope without inverting the spectrum or pinning the highs.
    const VIZ_TILT_ALPHA = 0.12;
    function bandTiltGain(sampleRate) {
      const g = new Float32Array(VIZ_BARS);
      const maxF = Math.min((sampleRate || 48000) / 2, 18000);
      const ratio = maxF / 40;
      let cTop = 0;
      for (let b = 0; b < VIZ_BARS; b++) cTop = 40 * Math.pow(ratio, (b + 0.5) / VIZ_BARS);
      for (let b = 0; b < VIZ_BARS; b++) {
        const c = 40 * Math.pow(ratio, (b + 0.5) / VIZ_BARS);
        g[b] = cTop > 0 ? Math.pow(c / cTop, VIZ_TILT_ALPHA) : 1;
      }
      return g;
    }
    let vizCtx = null;
    let vizAnalyser = null;
    let vizFreq = null;
    let vizWave = null;         // time-domain samples (waveform mode), Uint8Array
    let vizLive = false;
    let vizLiveOK = false;      // live analyser has produced real signal for the CURRENT track
    let vizSetupState = 0;      // 0 = not tried; 1 = live active; 2 = permanently unavailable
    const vizBands = new Float32Array(VIZ_BARS);
    // Per-frame smoothed time-domain samples for the waveform curve. Each point is
    // normalized to 0..1 (0.5 = center line) and eased toward the live read each frame
    // so the trace stays stable instead of jittering frame to frame.
    let vizWaveSmooth = null;
    // 分频段多线：每段一条归一化(0..1)时域波形，长度 = VIZ_WAVE_BANDS.length * n（平滑副本），
    // 以及每帧复用的 FFT 工作缓冲。
    let vizBandSmooth = null;
    let vizBandFilter = null;    // 每频段时域带通（2×HP + 2×LP biquad 级联）状态
    let vizScratchA = null;      // 每帧复用的滤波工作缓冲（避免反复分配）
    let vizScratchB = null;
    let vizBandPeak = null;      // 每频段慢峰值（自适应增益的响度参考）
    let vizBandGain = null;      // 每频段自适应增益（默认 VIZ_WAVE_GAIN）
    let vizFilterTime = null;    // 上次消费音频缓冲的 vizCtx.currentTime（用于算新增样本数）
    // Cached per-band frequency-weighting gain for the live analyser; shared code is
    // bandTiltGain(sampleRate) in the spectrum section. Recomputing is needed only when the
    // AudioContext sample rate changes (a new tap), so it's reset in setupLiveViz.
    let vizTiltGain = null;
    function liveTiltGain() {
      if (vizTiltGain !== null) return vizTiltGain;
      const sr = (vizCtx && vizCtx.sampleRate) || 48000;
      vizTiltGain = bandTiltGain(sr);
      return vizTiltGain;
    }
    function resumeVizCtx() {
      try {
        if (vizCtx !== null && vizCtx.state === 'suspended') {
          const p = vizCtx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* best-effort */ }
    }
    function setupLiveViz() {
      if (vizLive) return true;
      if (vizSetupState === 2) return false;
      // Web Audio capability checks.
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const hasCapture = typeof audio.captureStream === 'function';
      if (!hasCapture) { vizSetupState = 2; return false; }
      if (Ctor === undefined) { vizSetupState = 2; return false; }
      // IMPORTANT: calling captureStream() before the element has any data returns a
      // MediaStream with NO audio track — and because a media element returns the SAME
      // cached stream on every captureStream() call, that 0-track stream sticks forever.
      // So only capture once the element is actually playing (readyState >= 3);
      // otherwise retry from the 'playing' event.
      if (audio.readyState < 3) return false;
      try {
        const stream = audio.captureStream();
        let tracks = [];
        if (stream && typeof stream.getAudioTracks === 'function') { try { tracks = stream.getAudioTracks(); } catch (e) { tracks = []; } }
        if (!stream || typeof stream.getAudioTracks !== 'function') { vizSetupState = 2; return false; }
        if (tracks.length === 0) return false; // no audio track -> visualization shows nothing
        vizCtx = new Ctor();
        const srcNode = vizCtx.createMediaStreamSource(stream);
        vizAnalyser = vizCtx.createAnalyser();
        vizAnalyser.fftSize = 2048;
        // Bar HEIGHT is governed by the dB range below. This matches the audioMotion-analyzer
        // default (min:-85, max:-25) so the display scale is consistent with that mature
        // implementation. The temporal smoothing keeps the bars crisp and "follow the hand":
        // low value => the analyser tracks the instantaneous FFT so the bars snap to the music
        // (with only our own rise/fall smoothing in drawViz on top).
        vizAnalyser.smoothingTimeConstant = 0.3;
        vizAnalyser.minDecibels = -85;
        vizAnalyser.maxDecibels = -25;
        vizFreq = new Uint8Array(vizAnalyser.frequencyBinCount);
        // Time-domain buffer for the waveform view (a fresh 0..255 sample per analyser tap).
        vizWave = new Uint8Array(vizAnalyser.fftSize);
        vizWaveSmooth = new Float32Array(vizWave.length);
        for (let i = 0; i < vizWaveSmooth.length; i++) vizWaveSmooth[i] = 0.5;
        srcNode.connect(vizAnalyser); // analysis tap only — do NOT route to destination
        vizLive = true;
        vizSetupState = 1;
        // A fresh tap = a fresh song: drop the live-confirmed flag so a silent new tap shows
        // nothing, and recompute the frequency weighting for the new context.
        vizLiveOK = false;
        vizTiltGain = null;
        resumeVizCtx();
        return true;
      } catch (e) {
        if (vizCtx !== null) { try { vizCtx.close(); } catch (e2) {} }
        vizCtx = null; vizAnalyser = null; vizFreq = null; vizWave = null; vizWaveSmooth = null; vizBandSmooth = null; vizBandFilter = null; vizScratchA = null; vizScratchB = null; vizBandPeak = null; vizBandGain = null; vizFilterTime = null; vizLive = false; vizSetupState = 2;
        return false;
      }
    }
    function closeLiveViz() {
      if (vizCtx !== null) { try { vizCtx.close(); } catch (e) {} }
      vizCtx = null; vizAnalyser = null; vizFreq = null; vizWave = null; vizWaveSmooth = null; vizBandSmooth = null; vizBandFilter = null; vizScratchA = null; vizScratchB = null; vizBandPeak = null; vizBandGain = null; vizFilterTime = null; vizLive = false; vizSetupState = 0;
    }
    // Map AnalyserNode's per-bin byte data (dB→0..255) into the VIZ_BARS
    // log-spaced bands. Marks vizLiveOK once the tap actually yields signal.
    function analyseLiveBands() {
      if (!vizLive || vizAnalyser === null) return false;
      vizAnalyser.getByteFrequencyData(vizFreq);
      const binHz = vizCtx.sampleRate / vizAnalyser.fftSize;
      const maxF = Math.min(binHz * vizFreq.length, 18000);
      const ratio = maxF / 40;
      const g = liveTiltGain();
      let any = false;
      for (let b = 0; b < VIZ_BARS; b++) {
        const e0 = 40 * Math.pow(ratio, b / VIZ_BARS);
        const e1 = 40 * Math.pow(ratio, (b + 1) / VIZ_BARS);
        const b0 = Math.max(0, Math.floor(e0 / binHz));
        const b1 = Math.min(vizFreq.length, Math.max(b0 + 1, Math.ceil(e1 / binHz)));
        let m = 0;
        for (let k = b0; k < b1; k++) { const v = vizFreq[k]; if (v > m) m = v; }
        const raw = m / 255; // byte ∈ dB range → 0..1 (the standard AnalyserNode normalization)
        // Absolute loudness drives this bar (so a quiet passage stays low), but a fixed
        // frequency weighting flattens the bass-heavy shape so the low bands aren't pinned at
        // the top during loud music. See liveTiltGain().
        vizBands[b] = Math.min(1, raw * g[b]);
        if (m > 4) any = true; // above the (minDecibels floor) silence => real signal
      }
      if (any && !vizLiveOK) vizLiveOK = true;
      return true;
    }
    // 时域 2 阶 Butterworth 高通/低通 biquad（RBJ cookbook，Q=1/√2）。
    // 每频段用 2×HP(lo) + 2×LP(hi) 级联（8 阶）做带通。相比逐帧 FFT 分频，
    // 时域滤波是连续流式处理、没有窗函数——波形曲线在整个画布宽度上都保持
    // 真实振幅，不会像 Hann 窗那样把左右两端淡出到中线。
    function biquadHP(f0, fs) {
      const w0 = (2 * Math.PI * f0) / fs;
      const alpha = Math.sin(w0) / Math.SQRT2;
      const c = Math.cos(w0);
      const a0 = 1 + alpha;
      return { b0: (1 + c) / (2 * a0), b1: -(1 + c) / a0, b2: (1 + c) / (2 * a0), a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    function biquadLP(f0, fs) {
      const w0 = (2 * Math.PI * f0) / fs;
      const alpha = Math.sin(w0) / Math.SQRT2;
      const c = Math.cos(w0);
      const a0 = 1 + alpha;
      return { b0: (1 - c) / (2 * a0), b1: (1 - c) / a0, b2: (1 - c) / (2 * a0), a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    // 单步 Direct Form I biquad（就地推进滤波器状态，返回滤波后的样本值）。
    function stepBiquad(sec, x) {
      const y = sec.b0 * x + sec.b1 * sec.x1 + sec.b2 * sec.x2 - sec.a1 * sec.y1 - sec.a2 * sec.y2;
      sec.x2 = sec.x1; sec.x1 = x; sec.y2 = sec.y1; sec.y1 = y;
      return y;
    }
    // Read the analyser's time-domain samples into vizBandSmooth (normalized 0..1,
    // 0.5 = silent center) with light per-frame easing so the trace is stable.
    function analyseLiveWave() {
      if (!vizLive || vizAnalyser === null || vizWave === null) return false;
      if (typeof vizAnalyser.getByteTimeDomainData !== 'function') return false;
      vizAnalyser.getByteTimeDomainData(vizWave);
      // 分频段多线：把当前时域窗经每频段的时域带通（2×HP + 2×LP biquad）滤波，
      // 得到该频段的连续波形，每条线反映一段频率的起伏，形成层次感。时域滤波
      // 无窗函数，曲线两端保持真实振幅（不会像逐帧 FFT 分频那样把左右淡出）。
      const n = vizWave.length;
      if (vizBandSmooth === null || vizBandSmooth.length !== VIZ_WAVE_BANDS.length * n) {
        vizBandSmooth = new Float32Array(VIZ_WAVE_BANDS.length * n);
        const sampleRate0 = (vizCtx && vizCtx.sampleRate) || 48000;
        vizBandFilter = VIZ_WAVE_BANDS.map((band) => [
          biquadHP(band.lo, sampleRate0), biquadHP(band.lo, sampleRate0),
          biquadLP(band.hi, sampleRate0), biquadLP(band.hi, sampleRate0),
        ]);
        // 复用工作缓冲，避免每帧分配（60fps 下会很卡）。
        vizScratchA = new Float32Array(n);
        vizScratchB = new Float32Array(n);
        vizBandPeak = new Float32Array(VIZ_WAVE_BANDS.length);
        vizBandGain = new Float32Array(VIZ_WAVE_BANDS.length);
        for (let i = 0; i < vizBandSmooth.length; i++) vizBandSmooth[i] = 0.5;
        vizFilterTime = null;
      }
      // 算出「自上次处理后新增的样本数」hop：只把缓冲末尾的新样本喂给滤波器。
      // 关键：若整窗都喂且滤波器状态跨帧保留，重叠区会被重复滤波、状态跑得比
      // 真实时间快 → 强低音会错误地在高频段激起（实测 100Hz → 中频 0.46）。
      // 只喂新增样本后每个样本恰好被滤波一次，得到真正连续的带通波形。
      const sr = (vizCtx && vizCtx.sampleRate) || 48000;
      const now = (vizCtx && vizCtx.currentTime) || 0;
      let hop;
      if (vizFilterTime === null) {
        hop = n; // 首帧：消费整个窗口
      } else {
        const dt = now - vizFilterTime;
        hop = (Number.isFinite(dt) && dt > 0) ? Math.max(1, Math.min(n, Math.round(dt * sr))) : n;
      }
      vizFilterTime = now;
      // 每段：把新增 hop 个样本逐级过该段带通（状态跨帧保留），滚动写入平滑缓冲。
      for (let bi = 0; bi < VIZ_WAVE_BANDS.length; bi++) {
        const sections = vizBandFilter[bi];
        const base = bi * n;
        // 滚动：旧数据左移 hop，为末尾的新样本腾出位置。
        if (hop < n) {
          for (let i = hop; i < n; i++) vizBandSmooth[base + i - hop] = vizBandSmooth[base + i];
        }
        // 逐级滤波新增样本（vizWave[n-hop, n)），滤波器状态跨帧保留。
        const bufA = vizScratchA; const bufB = vizScratchB;
        let cur = bufA; let nxt = bufB;
        for (let j = 0; j < hop; j++) cur[j] = stepBiquad(sections[0], vizWave[n - hop + j] - 128);
        for (let s = 1; s < sections.length; s++) {
          const sec = sections[s];
          for (let j = 0; j < hop; j++) nxt[j] = stepBiquad(sec, cur[j]);
          const tmp = cur; cur = nxt; nxt = tmp;
        }
        // cur[0..hop) 是该段的带通时域（通带增益 0dB，满幅 ≈ ±128）。直接写入：
        // 滚动缓冲本身提供帧间连续性，无需逐帧缓动——缓动会让最早写入的样本
        // 永远停在半幅、导致波形左端振幅被压低。
        for (let j = 0; j < hop; j++) {
          vizBandSmooth[base + n - hop + j] = 0.5 + cur[j] / 255;
        }
        // 自适应增益（安静感知）：取该段平滑波形的峰值偏差，经慢峰值（瞬时上升、
        // ~1s 缓落，vizBandPeak）得到响度参考，据此把大声段落归一为全幅（下限 1x，
        // 不压缩响度），安静段落放大到上限 VIZ_WAVE_GAIN 保持可见；缓落让响度
        // 变化（渐强/渐弱）仍能被看见。
        let bm = 0;
        for (let i = 0; i < n; i++) bm += vizBandSmooth[base + i];
        bm /= n;
        let bp = 0;
        for (let i = 0; i < n; i++) { const d = Math.abs(vizBandSmooth[base + i] - bm); if (d > bp) bp = d; }
        const sp = Math.max(bp, vizBandPeak[bi] * VIZ_WAVE_PEAK_DECAY);
        vizBandPeak[bi] = sp;
        vizBandGain[bi] = Math.min(VIZ_WAVE_GAIN, Math.max(VIZ_WAVE_GAIN_MIN, VIZ_WAVE_PEAK_TARGET / Math.max(sp, 1e-3)));
      }
      // 单条回落波形（vizWaveSmooth）同样以 0.5 为中线、对称平滑；仅作降级回退用。
      for (let i = 0; i < vizWave.length; i++) {
        // 用 256 作归一化基准：getByteTimeDomainData 的静音中心是 128，128/256 = 0.5
        // 正好是画布垂直中线，波形严格围绕中线上下对称（若用 /255 则中心落在 ~0.502，
        // 整条线会系统性偏上约 0.002*(h-1)）。
        const t = vizWave[i] / 256;
        const s = vizWaveSmooth[i];
        vizWaveSmooth[i] = s + (t - s) * 0.4;
      }
      return true;
    }
    function drawBars(canvas, useCaps) {
      const c = canvas.getContext('2d');
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      const gap = 2;
      const bw = 3; // fixed 3px bar width (12 bars fit the 60px bar without crowding)
      // Center the group of bars within the canvas.
      const x0 = Math.max(0, Math.round((w - (bw * VIZ_BARS + gap * (VIZ_BARS - 1))) / 2));
      const color = currentAccent();
      // 峰值帽用亮度自适应色（暗主题→提亮、浅主题→压暗），任何主题下都与柱体区分。
      const capColor = capColorFor(color);
      for (let i = 0; i < VIZ_BARS; i++) {
        const bh = Math.max(2, Math.round(smoothCur[i] * (h - 2)));
        const x = x0 + i * (bw + gap);
        c.fillStyle = color;
        c.fillRect(x, h - 1 - bh, Math.max(1, Math.floor(bw)), bh);
        if (useCaps && smoothPeak[i] > smoothCur[i] + 0.03) {
          const py = h - 1 - Math.round(smoothPeak[i] * (h - 2));
          c.fillStyle = capColor;
          c.fillRect(x, Math.max(0, py), Math.max(1, Math.floor(bw)), 3);
        }
      }
    }
    // Oscilloscope-style multi-line waveform: one continuous curve per frequency band
    // (see VIZ_WAVE_BANDS). Each band is drawn with its own opacity/width so the low band
    // reads as the main contour while mids/highs layer on top, vertically centered on the
    // canvas midline (0.5) to line up with the left-aligned track name.
    function drawWaveform(canvas) {
      if (vizWaveSmooth === null) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }
      const c = canvas.getContext('2d');
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      const n = vizWaveSmooth.length;
      const bands = (vizBandSmooth !== null && vizBandSmooth.length === VIZ_WAVE_BANDS.length * n)
        ? VIZ_WAVE_BANDS : null;
      if (bands === null) {
        // 分段缓冲未就绪：退化为单条完整波形（仍围绕 DC 中心放大）。
        drawOneWave(c, w, h, n, vizWaveSmooth, 1.0, 1.5);
        return;
      }
      const color = currentAccent();
      for (let b = 0; b < bands.length; b++) {
        const src = vizBandSmooth.subarray(b * n, (b + 1) * n);
        // 用该频段的自适应增益（安静感知）替换固定放大：大声归一全幅、安静提亮，
        // 见 analyseLiveWave 的 vizBandGain。
        const gain = (vizBandGain !== null && vizBandGain.length === bands.length) ? vizBandGain[b] : VIZ_WAVE_GAIN;
        drawOneWave(c, w, h, n, src, bands[b].alpha, bands[b].width, color, gain);
      }
    }
    // Draw a single waveform curve from a normalized(0..1) sample buffer. The curve is
    // centered on its OWN mean so its vertical centroid always lands on the canvas midline
    // (0.5), regardless of any DC bias or content asymmetry — otherwise a non-symmetric
    // waveform (real vocals/rock) would sit visibly toward the top or bottom.
    function drawOneWave(c, w, h, n, samples, alpha, width, color, gain) {
      const col = color || currentAccent();
      // gain：该频段的自适应增益（默认固定放大 VIZ_WAVE_GAIN）。
      const g = (typeof gain === 'number' && Number.isFinite(gain) && gain > 0) ? gain : VIZ_WAVE_GAIN;
      // 用 globalAlpha 分层，让低频主轮廓实、中高频半透明叠加。
      c.globalAlpha = alpha;
      c.strokeStyle = col;
      c.lineWidth = width;
      // 求本条波形自身的均值，作为竖直居中轴（强制质心落在画布中线 0.5）。
      let mean = 0;
      for (let i = 0; i < n; i++) mean += samples[i];
      mean /= n;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        // 以均值 mean 为对称轴放大偏差，再映射到画布高度。y 用 +0.5 把中心精确对齐到
        // 画布视觉正中 h/2（20px 画布的 y=10）：直接用 (1-norm)*(h-1) 会把中心落在
        // 9.5，整整偏上 0.5px，直线/波形都会看起来没垂直居中。
        const norm = 0.5 + (samples[i] - mean) * g;
        const y = (1 - norm) * (h - 1) + 0.5; // norm=0.5 → y = h/2 → 竖直居中
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.globalAlpha = 1;
    }
    function drawViz() {
      if (barCanvasNode === null) return;
      const canvas = barCanvasNode;
      const w = canvas.width; const h = canvas.height;
      // Always probe the live tap (so vizLiveOK gets set the moment it yields signal).
      if (vizLive && vizAnalyser !== null) {
        analyseLiveBands();
        analyseLiveWave();
      }
      // 失败/未确认信号 -> 直接不显示（无离线回退）。仅当实时路径确认在出信号
      // 且正在播放时才画，否则清空画布。
      const confirmed = vizLive && vizLiveOK && store.playing;
      if (!confirmed) { canvas.getContext('2d').clearRect(0, 0, w, h); return; }
      if (store.vizMode === 'wave') {
        drawWaveform(canvas);
        return;
      }
      // bars（柱状图）：只由实时频域能量驱动。
      for (let i = 0; i < VIZ_BARS; i++) targetBuf[i] = vizBands[i];
      for (let i = 0; i < VIZ_BARS; i++) {
        const t = targetBuf[i];
        // 柱体保持对音乐的快速响应（上升 0.6、回落 0.1）；「渐落」由峰值帽承担：
        // 峰值帽以 PEAK_DECAY 线性缓慢落下，形成经典频谱的拖尾渐落观感。
        if (t > smoothCur[i]) smoothCur[i] += (t - smoothCur[i]) * 0.6;
        else smoothCur[i] += (t - smoothCur[i]) * 0.1;
        if (t > smoothPeak[i]) smoothPeak[i] = t;
        else smoothPeak[i] -= PEAK_DECAY;
        if (smoothPeak[i] < 0) smoothPeak[i] = 0;
      }
      drawBars(canvas, true);
    }
    let rafRunning = false;
    function startRaf() {
      if (rafRunning) return;
      rafRunning = true;
      const tick = () => { if (!rafRunning) return; rafId = requestAnimationFrame(tick); drawViz(); };
      tick();
    }
    function stopRaf() {
      rafRunning = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    }

    // ---- player actions ----
    // Shuffle playback uses a pre-shuffled queue with a position pointer so
    // "next" plays an unplayed track and "prev" returns to the previously
    // played one, instead of random-without-repeat or list-order neighbors.
    let shuffleQueue = [];
    let shufflePos = -1;
    let shuffleScopeKey = null;
    // 在线 QQ 队列连续失败的跳过次数：某首歌因版权下架/拿不到地址而触发
    // <audio> error 时自动跳到下一首；连续跳过次数达到队列长度（整列都试过）
    // 即停止报错——且停止后不再 step，杜绝无限循环跳歌。成功播放(onPlay)清零。
    let qqErrorSkipCount = 0;
    function buildShuffleQueue(anchorId) {
      const ids = activeIds();
      // Fisher-Yates
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      }
      const a = anchorId !== undefined ? anchorId : store.currentId;
      if (a !== null && ids.includes(a)) {
        const ai = ids.indexOf(a);
        if (ai !== 0) { ids.splice(ai, 1); ids.unshift(a); }
      }
      shuffleQueue = ids;
      shuffleScopeKey = scopeKey();
      shufflePos = a !== null && ids[0] === a ? 0 : -1;
    }
    // 确保乱序队列与当前范围一致（范围切换后自动重建）。
    function ensureShuffleReady() {
      if (store.mode !== 'shuffle') return;
      const ids = activeIds();
      if (shuffleScopeKey !== scopeKey() || shuffleQueue.length !== ids.length
        || (store.currentId !== null && !shuffleQueue.includes(store.currentId))) {
        buildShuffleQueue(store.currentId);
      }
      if (store.currentId !== null) shufflePos = shuffleQueue.indexOf(store.currentId);
    }
    function syncShufflePos() {
      if (store.mode !== 'shuffle') return;
      ensureShuffleReady();
    }
    // play() 的失败原因五花八门：AbortError（被 pause()/load()/切歌中断）、
    // “interrupted by ...”等都不是自动播放被拦截。这里**反向判断**：只有错误
    // 明确是自动播放被拦截（NotAllowedError，或 Chromium 的 not-allowed 文案）才
    // 提示“浏览器拦截了自动播放”。这样双击/连点/快速切歌产生的中断一律不会误报
    // （本环境里中断错误未必是标准 AbortError，只过滤 AbortError 会漏网）。
    function isAutoplayBlocked(err) {
      try {
        if (!err) return false;
        const n = String(err.name || '');
        const m = String((err && err.message) || '');
        if (n === 'NotAllowedError') return true;
        return /not allowed|autoplay|user (gesture|interaction|activation)|didn'?t interact|play\(\) failed/i.test(m);
      } catch (e) { return false; }
    }
    // 播放被主动中断（pause/stop/切歌）：用于抑制“播放失败”这类误导提示。
    function isPlayAborted(err) {
      try {
        return !!err && (err.name === 'AbortError' || /abort|interrupted/i.test(String((err && err.message) || '')));
      } catch (e) { return false; }
    }
    // 最近一次点击启动曲目的时刻。双击的第二次点击会落在已激活的行上；部分
    // 浏览器/环境里那次点击的 detail 仍为 1，仅靠 detail>=2 判断不可靠，这里用
    // 时间窗兜底：刚（600ms 内）通过点击启动的曲目被再次点击，一律视为双击的
    // 第二次点击而忽略，避免把它当成“再点一次=暂停/重播”并触发上面的误报。
    let lastPlayStartTs = 0;
    function shouldIgnoreRowClick(e, isActive) {
      if (e && e.detail >= 2) return true;
      if (isActive && Date.now() - lastPlayStartTs < 600) return true;
      return false;
    }
    // Open/close the playback panel. The visible tab is decided purely by the
    // current playback mode: only 本地音乐 (music) and 系统配置 (config) remain.
    function togglePanel() {
      const opening = !store.panelOpen;
      if (opening) set({ tab: 'music' });
      set({ panelOpen: opening });
    }
    function startPlay(id) {
      const track = resolvePlayable(id);
      if (track === null) return;
      lastPlayStartTs = Date.now();
      restoredMusicPos = null;
      // A fresh track gets a fresh live tap: the captureStream tap is tied to the
      // media pipeline of the src it was created on, so switching songs must tear it
      // down and let the 'playing' event re-capture for the NEW src (otherwise the tap
      // reads the old song's silence and we'd wrongly fall back to offline).
      closeLiveViz();
      audio.src = track.url;
      audio.load();
      // (Re)attempt the live spectrum tap now that a real src is loaded — the captured
      // MediaStream only carries an audio track once the element has a source.
      setupLiveViz();
      // A fresh track always starts from 0 (audio.src/load resets currentTime) —
      // reset the readout so a stale restored position (from the previous song)
      // never lingers on the bar before the first timeupdate.
      set({ currentId: id, currentName: track.name, currentArtists: track.artists || [], pendingId: null, pendingName: null, error: null, currentQuality: (track && track.quality) || '', position: 0, duration: 0 });
      syncShufflePos();
      savePlayback();
      const promise = audio.play();
      if (promise !== undefined && typeof promise.catch === 'function') {
        promise.catch((err) => {
          if (!isAutoplayBlocked(err)) return;
          set({ error: '浏览器拦截了自动播放，请点击一次播放按钮', pendingId: id, pendingName: track.name });
        });
      }
    }
    let restoredMusicPos = null; // restored music position to display until the audio truly reaches it
    let lastPosSaveAt = 0;     // throttle for the periodic playback-state save
    function togglePlay() {
      if (store.pendingId !== null && store.currentId === null) { startPlay(store.pendingId); return; }
      if (store.currentId === null) { const ids = activeIds(); if (ids.length > 0) startPlay(ids[0]); return; }
      if (audio.paused) {
        // A restored track's <audio> was not pre-loaded (restore never touches
        // the element, to avoid the Chromium 'getTopURL' quirk), so load it now,
        // then apply the deferred seek so it resumes from the saved spot.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
          }
          if ((audio.currentTime || 0) < restoredMusicPos - 0.5) {
            try { audio.currentTime = restoredMusicPos; } catch (e) {}
          }
        }
        const promise = audio.play();
        if (promise !== undefined && typeof promise.then === 'function') {
          promise.then(() => {}).catch((err) => {
            if (isAutoplayBlocked(err)) set({ error: '浏览器拦截了自动播放，请点击播放按钮' });
          });
        }
      } else audio.pause();
    }
    function step(delta) {
      const ids = activeIds();
      if (ids.length === 0) return;
      if (store.mode === 'shuffle' && ids.length > 1) {        // Walk the shuffled queue: next plays the next unplayed track, prev
        // returns to the previously played one (not a list-order neighbor).
        ensureShuffleReady();
        const pos = shuffleQueue.indexOf(store.currentId);
        if (store.currentId === null) {
          // Nothing playing yet: start from the head of the shuffled queue.
          if (delta > 0) startPlay(shuffleQueue[0]);
          return;
        }
        if (delta > 0) {
          if (pos >= 0 && pos + 1 < shuffleQueue.length) {
            startPlay(shuffleQueue[pos + 1]);
          } else {
            // Round finished: reshuffle anchored on the current track so the
            // next play is a fresh unplayed one, not the track that just ended.
            buildShuffleQueue(store.currentId);
            startPlay(shuffleQueue.length > 1 ? shuffleQueue[1] : shuffleQueue[0]);
          }
        } else if (pos > 0) {
          startPlay(shuffleQueue[pos - 1]);
        } else {
          // Already at the head of the shuffled queue: replay the current track.
          startPlay(store.currentId);
        }
        return;
      }
      const idx = ids.indexOf(store.currentId);
      const nextIdx = idx < 0 ? 0 : (idx + delta + ids.length) % ids.length;
      startPlay(ids[nextIdx]);
    }
    function changeVolume(value) {
      const v = Math.min(1, Math.max(0, value));
      audio.volume = v;
      set({ volume: v });
    }
    function stop() {
      // 停止只清「当前来源」的持久化记录（本地音乐 PREF_PLAYBACK）。
      restoredMusicPos = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      set({ currentId: null, currentName: null, playing: false, position: 0, duration: 0, pendingId: null, pendingName: null });
      clearPref(PREF_PLAYBACK);
      releaseWakeLock();
    }

    // ---- Screen Wake Lock: keep the screen awake while music is playing ----
    // While audio plays we request a screen wake lock so the display (and, for
    // most power policies, the system) doesn't blank or sleep mid-song. Tabs
    // can't stop OS-level deep sleep, but holding a wake lock while visible
    // covers the common "screen blanked while I listened" case. Unsupported
    // browsers (e.g. Safari) silently skip it — never fatal.
    let wakeLock = null;
    const wakeLockSupported = (typeof navigator !== 'undefined') && ('wakeLock' in navigator);
    async function acquireWakeLock() {
      if (!wakeLockSupported || !store.playing) return;
      if (wakeLock !== null) return; // already held
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
        wakeLock = sentinel;
      } catch (e) {
        wakeLock = null; // denied or transient — non-fatal
      }
    }
    function releaseWakeLock() {
      if (wakeLock !== null) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
      }
    }

    function bindAudio() {
      const onTime = () => {
        // A restored music track keeps showing its restored position until real
        // playback has clearly advanced past it. The <audio> currentTime is
        // unreliable right after a restore — it can seek to the spot and then
        // transiently reset to 0 (some browsers do this), so releasing the pin
        // too early makes the readout follow that 0. Release only once
        // currentTime is clearly past the spot (proving genuine progress); while
        // not there yet, show the target — and if playing but stuck behind it
        // (e.g. autoplay started from 0), re-seek so playback resumes from the
        // right place instead of silently from the start.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const ct = audio.currentTime || 0;
          if (ct > restoredMusicPos + 1) {
            restoredMusicPos = null; // real playback advanced past the spot — live time
          } else {
            if (store.playing && ct < restoredMusicPos - 0.5) {
              try { audio.currentTime = restoredMusicPos; } catch (e) {}
            }
            set({ position: restoredMusicPos });
            return;
          }
        }
        set({ position: audio.currentTime || 0 });
        // Persist the playback spot periodically (≈every 5s), so a refresh at any
        // moment resumes here instead of jumping back to 0.
        if (store.playing && Date.now() - lastPosSaveAt > 5000) {
          lastPosSaveAt = Date.now();
          savePlayback();
        }
      };
      const onDur = () => {
        // Only overwrite when the media actually reports a real duration;
        // before metadata loads audio.duration is NaN and we'd clobber a
        // restored/stored value with 0 (leaving "0:00").
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          set({ duration: audio.duration });
        }
      };
      const onPlay = () => { set({ playing: true, error: null }); acquireWakeLock(); setupLiveViz(); resumeVizCtx(); };
      const onPause = () => { set({ playing: false }); savePlayback(); releaseWakeLock(); };
      const onEnded = () => {
        if (store.mode === 'single' && store.currentId !== null) {
          audio.currentTime = 0;
          const promise = audio.play();
          if (promise !== undefined && typeof promise.catch === 'function') promise.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败', playing: false }); });
          return;
        }
        step(1);
      };
      const onError = () => {
        set({ error: '音频加载或解码失败', playing: false });
      };
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('durationchange', onDur);
      audio.addEventListener('play', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      // captureStream() only carries an audio track once the element is actually
      // playing (readyState >= 3); 'play' can fire before there is data, so retry here.
      const onPlaying = () => { setupLiveViz(); resumeVizCtx(); };
      audio.addEventListener('playing', onPlaying);
      return () => {
        audio.pause();
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('durationchange', onDur);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('error', onError);
      };
    }

    // Restore the persisted playback scope (playlist/library); a stale playlist id falls back.
    function restoreScope(plists) {
      const raw = loadPref(PREF_SCOPE);
      try {
        const o = JSON.parse(raw);
        if (o && o.kind === 'playlist' && (plists || []).some((p) => p.id === o.id)) {
          set({ scope: { kind: 'playlist', id: o.id } });
          return;
        }
      } catch (e) {}
      set({ scope: { kind: 'library' } });
    }

    // Restore local-music playback (PREF_PLAYBACK). Covers library tracks and
    // playlist members. The track is set up lazily on play (togglePlay), and the
    // readout is pinned to the restored values.
    function restorePlayback(saved, list) {
      if (saved === null) return;
      // A saved current track may be a library track or a playlist member ('p:'+path).
      let track = list.find((t) => t.id === saved.id);
      let scope = { kind: 'library' };
      if (track === undefined && String(saved.id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === saved.id);
          if (m) { track = m; scope = { kind: 'playlist', id: p.id }; break; }
        }
      }
      if (track === undefined) return;
      const pos = Number.isFinite(saved.position) ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      set({
        currentId: track.id, currentName: track.name,
        currentArtists: track.artists || [],
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null, scope,
        currentQuality: (track && track.quality) || '',
      });
      restoredMusicPos = pos > 0 ? pos : null;
      // Persist the restored spot explicitly so it survives another refresh.
      savePref(PREF_PLAYBACK, JSON.stringify({ kind: 'local', scope, id: track.id, name: track.name, position: pos, duration: savedDur, ts: Date.now() }));
    }
    // Restore podcast playback (PREF_PLAYBACK with kind:'podcast'). The episode
    // queue/source were persisted, so the plugin can restore even before the
    // Host podcast list is fetched; the episode is set up lazily on play. If the
    // persisted queue is missing (e.g. an old save), fall back to fetching the
    // podcast list from the Host and rebuilding it.
    async function restorePodcastPlayback(saved) {
      const epIdx = Number(saved.epIdx);
      let queue = Array.isArray(saved.queue) ? saved.queue : [];
      const src = saved.queueSource || { podId: saved.podId || (saved.scope && saved.scope.id) || '', title: '' };
      if (typeof saved.epIdx !== 'number' || !Number.isFinite(epIdx) || !queue[epIdx]) {
        // 队列缺失：从 Host 重新拉取该订阅，重建队列后恢复。
        if (!src.podId) return;
        try {
          const r = await jsonGet('/dsh-music-plus/podcasts');
          const pod = (r && Array.isArray(r.podcasts) ? r.podcasts : []).find((p) => p.id === src.podId);
          if (!pod || !pod.episodes || !pod.episodes[epIdx]) return;
          queue = pod.episodes;
        } catch (e) { return; }
      }
      const pos = Number.isFinite(saved.position) ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      set({
        scope: { kind: 'podcast', id: src.podId },
        podcastQueue: queue,
        podcastQueueSource: { podId: src.podId, title: src.title || '' },
        currentId: 'pod:' + epIdx,
        currentName: saved.name || (queue[epIdx].title || '未命名单集'),
        currentArtists: src.title ? [src.title] : [],
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null,
      });
      restoredMusicPos = pos > 0 ? pos : null;
    }
    // Restore the last playback (local music or podcast) from the Host prefs.
    // Both live in PREF_PLAYBACK (single key, old-Host-allowlisted) and are
    // distinguished by `kind`. Whichever was played last overwrote the key, so
    // the value read here IS the most recent — restore branch on its kind.
    function restoreLatest(list) {
      const saved = loadPlayback();
      if (saved === null) return;
      try { console.info('[dsh-music-plus] restoreLatest kind=', saved.kind, 'id=', store && (saved.podId || saved.id)); } catch (e) {}
      if (saved.kind === 'podcast') void restorePodcastPlayback(saved);
      else restorePlayback(saved, list);
    }

    // ---- host data ----
    async function loadTracks() {
      set({ loading: true });
      try {
        // Load the Host prefs snapshot first so every restore below reads the
        // authoritative values (they survive dsh-desktop's random-port origin
        // changes). Re-apply mode/volume/voice on top of whatever the
        // synchronous startup restore already applied.
        await loadServerPrefs();
        applyStoredPrefs();
        set({ prefsReady: true });
        const result = await jsonGet('/dsh-music-plus/manifest');
        set({
          root: result.root || null,
          tracks: result.tracks || [],
          playlists: result.playlists || [],
          count: result.count || 0, loading: false, error: result.error || null,
        });
        const list = result.tracks || [];
        // Envelope (spectrum) decoding is deferred to actual playback — no need
        // to decode several full files eagerly at page load; the current track's
        // envelope decodes on play (startPlay / resume).
        restoreScope(result.playlists || []);
        // 先读「原始」本地播放 ts（restoreLatest 末尾会重新写 PREF_PLAYBACK 并把 ts 设为 now，
        // 若之后才比较会把播客误判为「不是最新」而不恢复）。播客专用断点优先：播客 ts 更新则恢复播客。
        const locRaw = loadPlayback();
        const locTs = (locRaw && Number.isFinite(locRaw.ts)) ? locRaw.ts : 0;
        let restorePod = false;
        try {
          const pr = await jsonGet('/dsh-music-plus/podcast-play');
          const play = pr && pr.play;
          if (play && typeof play.podId === 'string' && Number.isFinite(Number(play.epIdx))) {
            const playTs = Number.isFinite(play.ts) ? play.ts : 0;
            if (playTs >= locTs) {
              restorePod = true;
              try { console.info('[dsh-music-plus] restore podcast (dedicated) podId=', play.podId, 'epIdx=', play.epIdx, 'pos=', play.position); } catch (e) {}
              void restorePodcastPlayback(play);
            }
          }
        } catch (e) { /* non-fatal */ }
        // 没有播客可恢复（或本地更新）时才恢复本地音乐。
        if (!restorePod) restoreLatest(list);
      } catch (err) {
        set({ loading: false, error: '无法读取音乐库：' + String((err && err.message) || err) });
      }
    }
    function saveRoot(path, kind) {
      const target = '/dsh-music-plus/set-root';
      set({ loading: true });
      fetch(target, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          set({
            root: result.root || null,
            tracks: result.tracks || [],
            count: result.count || 0, loading: false, error: null,
          });
        } else {
          set({ loading: false, error: (result && result.error) || '设置目录失败' });
        }
      }).catch((err) => {
        set({ loading: false, error: '设置目录失败：' + String((err && err.message) || err) });
      });
    }
    // 手动刷新：重新扫描当前音乐目录并更新列表（面板「刷新」按钮）。
    // 与 saveRoot 一致只刷新列表、不调用 restoreLatest。返回 promise 供按钮等待
    // 扫描完成以复位「刷新中…」。
    function rescanLibrary() {
      return fetch('/dsh-music-plus/rescan', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          set({
            root: result.root || null,
            tracks: result.tracks || [],
            playlists: result.playlists || [],
            count: result.count || 0, error: null,
          });
        } else {
          set({ error: (result && result.error) || '刷新失败' });
        }
      }).catch((err) => {
        set({ error: '刷新失败：' + String((err && err.message) || err) });
      });
    }

    function fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
      // Books use a continuous book-wide clock that can pass an hour, so show
      // hours when present (e.g. "1:02:03"); music under an hour stays "m:ss".
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const mm = h > 0 && m < 10 ? '0' + m : String(m);
      return h > 0 ? h + ':' + mm + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
    }
    // Strip a trailing file extension from a display name ("song.mp3" -> "song",
    // "novel.txt" -> "novel"). Local music / AI 讲书 show the file name, so the
    // extension is noise; online QQ titles aren't file names and aren't stripped.
    function stripExt(name) {
      if (typeof name !== 'string' || name === '') return name;
      const m = /^(.*)\.([^.]+)$/.exec(name);
      return m ? m[1] : name;
    }
    // Adaptive file-size label for the playlist: MB when >= 1MiB, else KB.
    // Music and novels share this, so a large novel shows "1.6 MB" instead of
    // an unwieldy "1600 KB" and a tiny audio clip no longer reads "0 MB".
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes >= 1024 * 1024) {
        const mb = bytes / 1024 / 1024;
        return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
      }
      return Math.round(bytes / 1024) + ' KB';
    }
    // 目录面包屑：把绝对路径渲染成逐个可点击的目录名，点击任一段即可直接跳到
    // 该目录；最后一段（当前目录）高亮展示、不可点击。crumbs 为空时回退显示
    // 目录名/路径纯文本（例如驱动列表或家目录未配置）。
    function renderCrumbs(crumbs, path, name, onGo) {
      if (!crumbs || crumbs.length === 0) {
        return React.createElement('span', { className: 'dsh-music-crumb-plain' }, name || path || '家目录');
      }
      const els = [];
      crumbs.forEach((c, i) => {
        if (i > 0) els.push(React.createElement('span', { key: 'sep' + i, className: 'dsh-music-crumb-sep' }, '\u203A'));
        const isLast = i === crumbs.length - 1;
        if (isLast) {
          els.push(React.createElement('span', { key: 'c' + i, className: 'dsh-music-crumb cur', title: c.path }, c.name));
        } else {
          els.push(React.createElement('button', {
            key: 'c' + i,
            className: 'dsh-music-crumb',
            title: c.path,
            onClick: () => onGo(c.path),
          }, c.name));
        }
      });
      return els;
    }
    function MusicNote(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z' }));
    }
    // 歌单卡片封面：有图显示图，无图显示音符占位块。酷狗「默认收藏」等系统默认歌单
    // 在云歌单接口（v7/get_all_list）里不返回 pic 封面字段，直接 <img src=""> 只会渲染
    // 一个空白方框（onError 后甚至整块消失）；「我喜欢」的爱心封面由酷狗后端内嵌返回，
    // 这里用音符占位兜底其余无封面场景，保证卡片始终有 56x56 封面视觉。
    function plCoverEl(item, cls = 'dsh-music-playlist-cover') {
      const cover = String((item && item.cover) || '').trim();
      if (cover) return React.createElement('img', { className: cls, src: cover, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } });
      return React.createElement('span', { className: cls + ' empty' }, React.createElement(MusicNote, { className: 'dsh-music-note' }));
    }
    // 播放控制图标（上一首/播放/暂停/下一首/停止）：用 SVG 替代 ⏮▶⏸⏭⏹ 文本字形。
    // 这些 Unicode 符号（尤其 ⏸ 常以 emoji 呈现）宽高/基线不一致，点击切换会让按钮
    // 大小与位置偏移；统一用同尺寸 viewBox=24 的 SVG，保证按钮恒定尺寸、图标精确居中。
    const iconSvg = (path, w = 16) => (props) => React.createElement('svg', { className: props.className || '', width: w, height: w, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
      React.createElement('path', { d: path }));
    const PlayIcon = iconSvg('M8 5v14l11-7z');
    const PauseIcon = iconSvg('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    const PrevIcon = iconSvg('M6 6h2v12H6zm3.5 6l8.5 6V6z');
    const NextIcon = iconSvg('M6 18l8.5-6L6 6v12zM16 6h2v12h-2z');
    const StopIcon = iconSvg('M6 6h12v12H6z');

    // ---- components ----
    // Custom vertical volume slider. The native <input type=range> cannot be
    // fully restyled in current Chrome (track keeps gray border lines and the
    // thumb ignores width/height once appearance:none is set), so the slider is
    // drawn with plain divs and driven by pointer events: click to jump, drag
    // the thumb to scrub. Value runs bottom (0) to top (1).
    function VolumeSlider() {
      const s = useStore();
      const trackRef = useRef(null);
      const draggingRef = useRef(false);
      const valueFor = (clientY) => {
        const el = trackRef.current;
        if (el === null) return s.volume;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) return s.volume;
        const ratio = 1 - (clientY - r.top) / r.height;
        return Math.min(1, Math.max(0, ratio));
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        changeVolume(valueFor(e.clientY));
      };
      const onPointerMove = (e) => {
        if (!draggingRef.current) return;
        changeVolume(valueFor(e.clientY));
      };
      const onPointerUp = (e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      const pct = Math.round(s.volume * 100);
      return React.createElement('div',
        { className: 'dsh-music-vol-slider', ref: trackRef,
          onPointerDown, onPointerMove, onPointerUp,
          title: '音量 ' + pct + '%' },
        React.createElement('div', { className: 'dsh-music-vol-track' }),
        React.createElement('div', { className: 'dsh-music-vol-fill', style: { height: pct + '%' } }),
        React.createElement('div', { className: 'dsh-music-vol-thumb', style: { bottom: 'calc(' + pct + '% - 7px)' } }),
      );
    }

    function NowPlayingBar() {
      const s = useStore();
      const [volOpen, setVolOpen] = useState(false);
      const volRef = useRef(null);
      const volPopRef = useRef(null);
      const [barHover, setBarHover] = useState(false);
      // 滑出延迟：鼠标离开播放条后等 1s 再隐藏控制按钮，防止误移出导致按钮组收回。
      // 若在延迟内重新进入，取消定时器、保持展开。
      const hoverTimerRef = useRef(null);
      useEffect(() => () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }, []);
      useEffect(() => {
        if (!volOpen) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 ref 单独判断，否则点击弹窗内部也会误关闭）。
        const onClick = (e) => {
          if (volRef.current !== null && volRef.current.contains(e.target)) return;
          if (volPopRef.current !== null && volPopRef.current.contains(e.target)) return;
          setVolOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [volOpen]);
      const hasTrack = s.currentName !== null || s.pendingName !== null;
      const name = s.currentName || s.pendingName;
      const showHint = s.pendingName !== null && s.currentId === null;
      const panelCls = 'dsh-music-mode-trigger' + (s.panelOpen ? ' active' : '');
      // 本地音乐：播放条显示的文件名去掉扩展名（如 .mp3）。
      const displayName = stripExt(name);
      // 名称前的图标：本地音乐用音符图标（空闲态无曲目 = 音乐）。
      const note = React.createElement(MusicNote, { className: 'dsh-music-note' });
      // 音质徽章显示开关（系统配置「音质徽章显示」）：关闭时歌名后不再显示
      // 本地「格式 · 音质」标签。
      const showQuality = s.showQuality;
      // 本地音乐的「格式 · 音质」标签（如 FLAC · 无损 / MP3 · 高音质）；
      // 解析不出（未知格式/不可读）则不显示。
      let localQualityBadge = null;
      if (showQuality && s.currentId !== null && s.currentQuality) {
        localQualityBadge = React.createElement('span', { className: 'dsh-music-bar-src', title: s.currentQuality }, s.currentQuality);
      }
      // 歌手名（正常本地歌曲通常没有 artists，则不显示）。
      const artistText = hasTrack ? (s.currentArtists || []).join(' / ') : '';
      const artistEl = artistText ? React.createElement('span', { className: 'dsh-music-bar-artist' },
        '-',
        React.createElement('span', { className: 'dsh-music-bar-artist-name' }, artistText)) : null;
      // 自建歌单：收藏爱心按钮（收藏时用主题色）。
      const faved = hasTrack && isCurrentFaved();
      const favTitle = faved ? '取消收藏（从「我最喜欢」移除）' : '收藏到「我最喜欢」';
      const heartBtn = hasTrack ? React.createElement('button', {
        className: 'dsh-music-bar-btn fav' + (faved ? ' on' : ''),
        title: favTitle,
        onClick: toggleFav,
      }, React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16,
        fill: faved ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true,
      }, React.createElement('path', { d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' }))) : null;
      const showBarBtns = () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } setBarHover(true); };
      // 任一弹层打开时保持按钮展开（弹层 portal 到 body，鼠标可能在弹层上）。
      // 注意：barHover 只反映鼠标是否停留在播放条上；弹层打开期间由 anyPopOpen
      // 让 .on 保持 true，弹层关闭后 .on 随 anyPopOpen 立即收起，无需额外触发。
      const anyPopOpen = volOpen || s.modeMenuOpen;
      const hideBarBtns = () => {
        // 滑出延迟 1s：鼠标离开后暂不收起按钮组；若延迟内重新进入则取消。
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => { hoverTimerRef.current = null; setBarHover(false); }, 1000);
      };
      const onBarLeave = () => hideBarBtns();
      // 播放条整体透明度：鼠标在播放条上（或任一弹层打开）时完全不透明；离开 1s
      // 收起控件组的同时变半透明（50%），营造「后台静默播放」效果，不干扰用户其它工作。
      // 与控件组 .on 完全同源（barHover || anyPopOpen），保证两者同步变化。
      // 这些「闲置/工作态」交互（透明度、控件滑入滑出、时长显隐）只在有播放内容时生效；
      // 无内容（点击停止 / 插件刚安装）时恒定工作态：不透明度 100%、控件组展开，无任何特效。
      const active = barHover || anyPopOpen || !hasTrack;
      const barDimmed = !active;
      // 沉浸感由系统配置驱动：数值越大越「沉浸」（播放条越透明融入背景）。
      // 传给播放条的 opacity 是 1-immersee：沉浸 0% → 不透明(1)，沉浸 100% → 全透明(0)。
      const barStyle = { '--dsh-music-immerse': String(1 - s.immerse) };
      // 播放进度细线：音乐按 position/duration（单曲时长）。
      const progressPct = ((hasTrack && s.duration > 0) ? Math.min(100, Math.max(0, (s.position / s.duration) * 100)) : 0);
      // ---- 可拖动进度条（双击/拖动 seek 定点播放）----
      const seekRef = useRef(null);
      const seekingRef = useRef(false);
      const seekTo = (sec) => {
        if (!hasTrack || !(s.duration > 0)) return;
        const t = Math.min(Math.max(0, sec), s.duration);
        try { audio.currentTime = t; } catch (e) {}
        restoredMusicPos = null;
        set({ position: t });
        savePlayback();
      };
      const seekFraction = (e) => {
        const el = seekRef.current;
        if (el === null) return 0;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
      };
      const onSeekDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (!hasTrack || !(s.duration > 0)) return;
        e.preventDefault();
        seekingRef.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
        seekTo(seekFraction(e) * s.duration);
      };
      const onSeekMove = (e) => { if (seekingRef.current) seekTo(seekFraction(e) * s.duration); };
      const onSeekUp = (e) => {
        if (!seekingRef.current) return;
        seekingRef.current = false;
        if (e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function') {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        savePlayback();
      };
      return React.createElement('div', { className: 'dsh-music-bar-wrap' },
        React.createElement('div',
          { className: 'dsh-music-bar' + (barDimmed ? ' dimmed' : '') + (s.showBarBg ? '' : ' bare'), style: barStyle, onMouseEnter: showBarBtns, onMouseLeave: onBarLeave },
          hasTrack
            ? React.createElement('span', { className: 'dsh-music-bar-name', title: displayName + (artistText ? ' - ' + artistText : '') }, note, ' ', displayName, artistEl, localQualityBadge)
            : React.createElement('span', { className: 'dsh-music-bar-idle' }, note, ' DSH音乐播放器'),
          hasTrack && s.playing && s.showViz ? React.createElement('canvas', { className: 'dsh-music-viz', width: 60, height: 20, ref: (el) => { barCanvasNode = el; } }) : null,
          // 时长 + 右侧控制按钮是一个组合：右对齐（margin-left:auto）。鼠标进入播放条
          // 时按钮组从右向左滑入；离开（闲置）时按钮组折叠、时长也一并隐藏，只在操作
          // 时显示，避免后台静默态右侧仍残留时长数字。
          React.createElement('div', { className: 'dsh-music-bar-controls' + (active ? ' on' : '') },
            hasTrack
              ? (showHint
                  ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '⚠ 自动播放被拦截，点击▶解锁')
                  : (!barDimmed ? React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(s.position) + ' / ' + fmtTime(s.duration)) : null))
              : null,
            React.createElement('div', { className: 'dsh-music-bar-btns' },
              heartBtn,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '上一首', onClick: () => step(-1) }, React.createElement(PrevIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '播放/暂停', onClick: togglePlay }, React.createElement(s.playing ? PauseIcon : PlayIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '下一首', onClick: () => step(1) }, React.createElement(NextIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '停止', onClick: stop }, React.createElement(StopIcon, null)) : null,
              React.createElement(ModeDropdown, null),
              React.createElement('div', { className: 'dsh-music-bar-vol', ref: volRef },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
                  title: '音量',
                  onClick: () => setVolOpen((o) => !o),
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
                }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' }))),
              ),
              React.createElement('button', {
                className: panelCls,
                title: s.panelOpen ? '关闭播放列表' : '打开播放列表',
                onClick: togglePanel,
              }, React.createElement('svg', {
                viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
              }, React.createElement('path', {
                d: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
              }))),
            ),
          ),
          // 音量弹层：portal 到 body + fixed 定位，锚定在音量按钮正上方。放在
          // .dsh-music-bar-btns（overflow:hidden 折叠容器）之外，避免被折叠裁剪。
          volOpen ? portalToBody(React.createElement('div', {
            className: 'dsh-music-bar-vol-pop',
            style: anchorAbove(volRef.current, 36),
            ref: volPopRef,
          },
            React.createElement(VolumeSlider, null),
          )) : null,
          // 播放进度（可拖动 seek 定点播放）：绝对定位在播放条底部，2px 亮线 + 圆点拇指，
          // 鼠标进入显示拇指，点击/拖动即可跳到指定位置。
          hasTrack && s.duration > 0 && s.showProgress
            ? React.createElement('div', {
                className: 'dsh-music-bar-progress' + (active ? ' alive' : ''),
                ref: seekRef,
                onPointerDown: onSeekDown,
                onPointerMove: onSeekMove,
                onPointerUp: onSeekUp,
                onPointerCancel: onSeekUp,
                title: '点击/拖动到指定进度',
              },
                React.createElement('div', { className: 'dsh-music-bar-progress-track' }),
                React.createElement('div', { className: 'dsh-music-bar-progress-fill', style: { width: progressPct + '%' } }),
                React.createElement('div', { className: 'dsh-music-bar-progress-thumb', style: { left: progressPct + '%' } }))
            : null,
        ),
      );
    }
    // Playback-mode metadata + an icon-only dropdown. Icons are inline SVGs filled
    // with currentColor so they match the accent of the other round transport
    // buttons (green), which a native <select> cannot color.
    const MODES = [
      { id: 'single', label: '单曲循环', title: '单曲循环：播放结束重复当前曲目', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z' },
      { id: 'order', label: '顺序播放', title: '顺序播放：自动播放列表中的下一首', d: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z' },
      { id: 'shuffle', label: '乱序播放', title: '乱序播放：随机挑选下一首', d: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z' },
    ];
    function ModeIcon(props) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
      }, React.createElement('path', { d: props.d }));
    }
    function ModeDropdown() {
      const s = useStore();
      const open = s.modeMenuOpen;
      const ref = useRef(null);
      const popRef = useRef(null);
      useEffect(() => {
        if (!open) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 popRef 单独判断，否则点击弹窗内选项也会误关闭）。
        const onClick = (e) => {
          if (ref.current !== null && ref.current.contains(e.target)) return;
          if (popRef.current !== null && popRef.current.contains(e.target)) return;
          set({ modeMenuOpen: false });
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [open]);
      const cur = MODES.find((m) => m.id === s.mode) || MODES[1];
      // Right-align the mode+volume+panel cluster when there is no track: during
      // playback the time span already carries margin-left:auto to push these
      // right, so only apply the auto margin when a name/pending name is absent.
      const barRight = s.currentName === null && s.pendingName === null;
      return React.createElement('div',
        { className: 'dsh-music-mode-menu' + (barRight ? ' right' : ''), ref },
        React.createElement('button', {
          className: 'dsh-music-mode-trigger' + (open ? ' active' : ''),
          title: cur.label,
          onClick: () => set({ modeMenuOpen: !open }),
        }, React.createElement(ModeIcon, { d: cur.d })),
        // 模式弹层 portal 到 body（fixed 定位，锚定按钮正上方）：按钮组在折叠
        // （overflow:hidden）容器内，弹层需逃逸才能不被裁剪。
        open ? portalToBody(React.createElement('div', { className: 'dsh-music-mode-pop', style: anchorAbove(ref.current, 120), ref: popRef },
          MODES.map((m) => React.createElement('button', {
            key: m.id,
            className: 'dsh-music-mode-item' + (s.mode === m.id ? ' active' : ''),
            title: m.title,
            onClick: () => { set({ mode: m.id, modeMenuOpen: false }); },
          }, React.createElement(ModeIcon, { d: m.d }))),
        )) : null,
      );
    }
    // 播客页签：顶部横排「全部 + 各订阅源卡片」。不点源时下方是「所有源的最新单集」聚合列表
    // （按发布时间新→旧，每行带来源徽标）；点具体源则只显示该源的全部单集（同样新→旧）。
    function PodcastPanel({ panelRef }) {
      const s = useStore();
      const [feedUrl, setFeedUrl] = useState('');
      const [adding, setAdding] = useState(false);
      const [err, setErr] = useState(null);
      const [refreshing, setRefreshing] = useState({});
      const [activeId, setActiveId] = useState(null); // null = 「全部」聚合视图
      const pods = s.podcasts || [];
      const activePod = (activeId !== null && pods.find((p) => p.id === activeId)) || null;
      useEffect(() => { loadPodcastsFromHost(); }, []);
      useEffect(() => {
        // 选中的源被退订后，回退到「全部」视图。
        if (activeId !== null && !activePod) setActiveId(null);
      }, [activeId, activePod]);
      const submitAdd = () => {
        const u = feedUrl.trim();
        if (u === '' || adding) return;
        setAdding(true); setErr(null);
        apiPodcastAdd(u, (r) => {
          setAdding(false);
          if (!r || !r.ok) { setErr((r && r.error) || '订阅失败'); return; }
          setFeedUrl('');
          if (r.podcast) setActiveId(r.podcast.id);
        });
      };
      const refresh = (id) => {
        setRefreshing((m) => ({ ...m, [id]: true }));
        apiPodcastRefresh(id, () => setRefreshing((m) => ({ ...m, [id]: false })));
      };
      const remove = (id) => apiPodcastRemove(id);
      const epTs = (ep) => { const t = Date.parse(ep && ep.pubDate); return Number.isFinite(t) ? t : 0; };
      // 「全部」聚合：所有源的单集打平，带来源信息 + 原始下标，按发布时间新→旧。
      const allRows = pods.flatMap((pod) => (pod.episodes || []).map((ep, epIdx) => ({ ep, epIdx, podId: pod.id, podTitle: pod.title, podImage: pod.image })));
      allRows.sort((a, b) => epTs(b.ep) - epTs(a.ep));
      // 具体源视图：该源的单集，按发布时间新→旧。
      const activeRows = activePod ? (activePod.episodes || []).map((ep, epIdx) => ({ ep, epIdx })).sort((a, b) => epTs(b.ep) - epTs(a.ep)) : [];
      const srcCard = (pod) => {
        const playing = s.podcastQueueSource && s.podcastQueueSource.podId === pod.id;
        return React.createElement('button', {
          key: pod.id,
          className: 'dsh-music-podcast-src' + (activePod && activePod.id === pod.id ? ' active' : '') + (playing ? ' playing' : ''),
          title: pod.title || '未命名播客',
          onClick: () => setActiveId(pod.id),
        },
          pod.image ? React.createElement('img', { className: 'dsh-music-podcast-srcimg', src: pod.image, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } }) : React.createElement('span', { className: 'dsh-music-podcast-srcimg empty' }, '🎧'),
          React.createElement('span', { className: 'dsh-music-podcast-srcname' }, pod.title || '未命名'),
          playing ? React.createElement('span', { className: 'dsh-music-podcast-srcplay', 'aria-hidden': true }, '▶') : null);
      };
      // 单集行：showSrc=true 时（聚合视图）在行首显示来源徽标。
      const renderRow = (row, showSrc) => {
        const podId = row.podId || activePod.id;
        const isActive = s.podcastQueueSource && s.podcastQueueSource.podId === podId && String(s.currentId) === 'pod:' + row.epIdx;
        const srcBadge = showSrc ? (row.podImage
          ? React.createElement('img', { className: 'dsh-music-podcast-ep-src', src: row.podImage, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } })
          : React.createElement('span', { className: 'dsh-music-podcast-ep-src empty' }, '🎧')) : null;
        const srcLabel = showSrc ? React.createElement('span', { className: 'dsh-music-podcast-ep-srcname' }, row.podTitle) : null;
        return React.createElement('button', {
          key: (row.podId || activePod.id) + ':' + row.epIdx,
          className: 'dsh-music-track' + (isActive ? ' active' : ''),
          title: row.ep.url,
          onClick: () => playPodcastEp(podId, row.epIdx),
        },
          srcBadge,
          React.createElement('span', { className: 'dsh-music-track-name' }, srcLabel, (isActive && s.playing ? '▶ ' : '') + (row.ep.title || '未命名单集')),
          React.createElement('span', { className: 'dsh-music-track-size' }, fmtTime(row.ep.duration || 0)));
      };
      return React.createElement('div', { className: 'dsh-music-podcast' },
        React.createElement('div', { className: 'dsh-music-podcast-add' },
          React.createElement('input', {
            className: 'dsh-music-podcast-input', placeholder: '粘贴 RSS / Atom 订阅链接，回车订阅',
            value: feedUrl, onChange: (e) => setFeedUrl(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submitAdd(); }, 'aria-label': '播客订阅链接',
          }),
          React.createElement('button', { className: 'dsh-music-settings-btn', disabled: adding, onClick: submitAdd }, adding ? '订阅中…' : '订阅')),
        err ? React.createElement('div', { className: 'dsh-music-error' }, err) : null,
        pods.length === 0
          ? React.createElement('div', { className: 'dsh-music-empty' }, '尚未订阅播客。粘贴一个 RSS / Atom 链接即可开始。')
          : React.createElement('div', { className: 'dsh-music-podcast-body' },
            React.createElement('div', { className: 'dsh-music-podcast-sources' },
              pods.map((p) => srcCard(p)),
              React.createElement('button', {
                key: '__all', className: 'dsh-music-podcast-src' + (activeId === null ? ' active' : ''),
                title: '全部', onClick: () => setActiveId(null),
              },
                React.createElement('span', { className: 'dsh-music-podcast-srcimg empty' }, '≣'),
                React.createElement('span', { className: 'dsh-music-podcast-srcname' }, '全部'))),
            activeId === null
              ? React.createElement('div', { className: 'dsh-music-podcast-card' },
                React.createElement('div', { className: 'dsh-music-podcast-head' },
                  React.createElement('div', { className: 'dsh-music-podcast-meta' },
                    React.createElement('span', { className: 'dsh-music-podcast-title' }, '全部更新'),
                    React.createElement('span', { className: 'dsh-music-podcast-count' }, allRows.length + ' 条最新，来自 ' + pods.length + ' 个订阅'))),
                React.createElement('div', { className: 'dsh-music-podcast-episodes' },
                  allRows.length === 0
                    ? React.createElement('div', { className: 'dsh-music-empty' }, '暂无单集（点「刷新」更新）')
                    : allRows.map((row) => renderRow(row, true))))
              : React.createElement('div', { key: activePod.id, className: 'dsh-music-podcast-card' },
                React.createElement('div', { className: 'dsh-music-podcast-head' },
                  activePod.image ? React.createElement('img', { className: 'dsh-music-podcast-cover', src: activePod.image, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } }) : React.createElement('span', { className: 'dsh-music-podcast-cover empty' }, '🎧'),
                  React.createElement('div', { className: 'dsh-music-podcast-meta' },
                    React.createElement('span', { className: 'dsh-music-podcast-title' }, activePod.title || '未命名播客'),
                    activePod.description ? React.createElement('span', { className: 'dsh-music-podcast-desc' }, activePod.description) : null,
                    React.createElement('span', { className: 'dsh-music-podcast-count' }, activeRows.length + ' 集')),
                  React.createElement('div', { className: 'dsh-music-podcast-actions' },
                    React.createElement('button', { className: 'dsh-music-settings-btn ghost', disabled: refreshing[activePod.id], onClick: () => refresh(activePod.id) }, refreshing[activePod.id] ? '刷新中…' : '刷新'),
                    React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => remove(activePod.id) }, '退订'))),
                React.createElement('div', { className: 'dsh-music-podcast-episodes' },
                  activeRows.length === 0
                    ? React.createElement('div', { className: 'dsh-music-empty' }, '暂无单集（点「刷新」更新）')
                    : activeRows.map((row) => renderRow(row, false))))));
    }

    function PlayerPanel() {
      const s = useStore();
      const listRef = useRef(null);
      const panelRef = useRef(null);
      // Draggable panel position + size ({x, y, w, h} left/top/width/height once
      // dragged or resized; null = CSS default: centered, 380px, auto height).
      const [pos, setPos] = useState(loadPanelPos);
      // The Host prefs snapshot arrives async (loadTracks -> loadServerPrefs).
      // Once it is ready, re-apply the persisted panel geometry — all prefs are
      // Host-backed now, so the mount-time value above comes from the snapshot.
      useEffect(() => {
        if (!s.prefsReady) return;
        const next = loadPanelPos();
        if (next !== null) setPos(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady]);
      const dragRef = useRef(null);   // head-drag state
      const resizeRef = useRef(null); // corner-resize state
      // 曲库每行「＋」打开的「加入歌单」菜单：{track, x, y}（锚点=按钮右上角视口坐标）。
      const [addMenu, setAddMenu] = useState(null);
      const openAddMenu = (track, e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ track, x: r.right, y: r.top });
      };

      // Once the panel is dragged/resized we switch from CSS centering
      // (left:50%; top:50%; translate(-50%,-50%)) to explicit left/top/width/height.
      // Locking height, clearing max-height and nulling the CSS translate matters:
      // with only top+left and the CSS max-height:72vh still applying, a fixed
      // element whose CSS also sets the translate would collapse/clamp and shift
      // by half its own size while dragging.
      // 面板常驻不卸载：关闭时仅用 display:none 隐藏（子树、QQ 面板状态全保留），
      // 重新打开时按播放类别重设 tab（见 togglePanel）并恢复显示。因此组件不会
      // 在关闭时 unmount，切 tab / 关面板重开都不会丢内部 useState 状态。
      const rootStyle = { ...(pos === null ? { minHeight: PANEL_AUTO_MIN_H } : { left: pos.x, top: pos.y, width: pos.w, height: pos.h, maxHeight: 'none', transform: 'none' }), display: s.panelOpen ? '' : 'none' };

      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        // don't start a drag from the close button
        if (e.target.closest && e.target.closest('.dsh-music-icon-btn')) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const w = pos !== null ? pos.w : PANEL_W;
        const h = pos !== null ? pos.h : rect.height;
        const next = { x: pos !== null ? pos.x : rect.left, y: pos !== null ? pos.y : rect.top, w, h };
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          originX: next.x, originY: next.y, w, h,
        };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (d === null) return;
        let x = d.originX + (e.clientX - d.startX);
        let y = d.originY + (e.clientY - d.startY);
        const el = panelRef.current;
        if (el !== null) {
          x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
          y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        }
        const next = { x, y, w: d.w, h: d.h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      // Corner drag-to-resize: grow/shrink width & height from the bottom-right
      // handle, clamped to [min, max] and kept inside the viewport. The panel's
      // top-left (x/y) is untouched by a resize.
      const onResizeDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const cur = {
          x: pos !== null ? pos.x : rect.left,
          y: pos !== null ? pos.y : rect.top,
          w: pos !== null ? pos.w : PANEL_W,
          h: pos !== null ? pos.h : rect.height,
        };
        resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: cur.w, originH: cur.h };
        setPos(cur);
        savePref(PREF_PANEL_POS, JSON.stringify(cur));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (d === null) return;
        const el = panelRef.current;
        const x = pos !== null ? pos.x : (el !== null ? el.getBoundingClientRect().left : 0);
        const y = pos !== null ? pos.y : (el !== null ? el.getBoundingClientRect().top : 0);
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, vw - x));
        const maxH = Math.min(Math.floor(vh * PANEL_MAX_H_VH), Math.max(PANEL_MIN_H, vh - y));
        const w = Math.max(PANEL_MIN_W, Math.min(d.originW + (e.clientX - d.startX), maxW));
        const h = Math.max(PANEL_MIN_H, Math.min(d.originH + (e.clientY - d.startY), maxH));
        const next = { x, y, w, h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onResizeUp = (e) => {
        resizeRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      useEffect(() => {
        if (!s.panelOpen) return;
        // Close the playlist panel when the user clicks outside it
        // (mousedown precedes the toggle's click, so both stay consistent).
        // Several popups are PORTALED to <body> (to escape the panel's
        // overflow:hidden clipping): directory/file pickers, the「加入歌单」menu,
        // the QQ search-history dropdown, the chapter TOC, and the bar's
        // mode/volume popups. A click inside any of them is technically outside
        // the panel's DOM, but they are part of the panel/bar UI — treat them as
        // "inside" so interacting never closes the panel underneath.
        const onDown = (e) => {
          if (panelRef.current !== null && !panelRef.current.contains(e.target)
            && !(e.target.closest && (
              e.target.closest('.dsh-music-picker-overlay')
              || e.target.closest('.dsh-music-add-pop')
              || e.target.closest('.dsh-music-qq-hist')
              || e.target.closest('.dsh-music-toc')
              || e.target.closest('.dsh-music-mode-pop')
              || e.target.closest('.dsh-music-bar-vol-pop')
            ))) {
            set({ panelOpen: false });
          }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.panelOpen]);
      useEffect(() => {
        if (!s.panelOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track.active');
        if (active !== null && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      }, [s.panelOpen, s.currentId]);
      // 面板关闭时清掉「加入歌单」弹层状态，避免重开面板时残留。
      useEffect(() => { if (!s.panelOpen) setAddMenu(null); }, [s.panelOpen]);
      // 面板常驻不卸载：关闭时用根 div 的 display:none 隐藏，而非 return null。
      const rows = s.tracks.map((t) => {
        const active = t.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''),
            title: t.path,
            // A browser's double-click fires the row's click twice: the first
            // click starts the track, the second lands on the now-active row and
            // would togglePlay() it (pausing it and aborting its pending play
            // promise — historically misreported as an autoplay block). Ignore
            // the repeat click (detail >= 2, plus a time-window fallback) so a
            // double-click keeps playing.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'library'); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', {
            className: 'dsh-music-playlist-mini add',
            title: '加入歌单',
            onClick: (e) => { e.stopPropagation(); openAddMenu(t, e); },
          }, '＋'),
        );
      });
      const tabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-tab' + (s.tab === key ? ' active' : ''),
        onClick: () => set({ tab: key }),
      }, label);
      // 音乐页子标签：曲库 / 我最喜欢 / ＋ / 自建歌单
      const subTabBtn = (key, label, extraCls, rkey) => React.createElement('button', {
        key: rkey,
        className: 'dsh-music-subtab' + (s.subTab === key ? ' active' : '') + (extraCls ? ' ' + extraCls : ''),
        title: label,
        onClick: () => set({ subTab: key }),
      }, label);
      const musicSubTabs = React.createElement('div', { className: 'dsh-music-subtabs' },
        subTabBtn('library', '曲库'),
        subTabBtn(FAV_PLAYLIST_ID, '♥ 我最喜欢'),
        // 自建歌单排在 ＋ 号之前；＋ 固定在末尾用于新建。
        (s.playlists || []).filter((p) => p.id !== FAV_PLAYLIST_ID).map((p) => subTabBtn(p.id, p.name, null, p.id)),
        React.createElement('button', { className: 'dsh-music-subtab add', title: '新建歌单', onClick: onCreatePlaylist }, '＋'),
      );
      const isPlaylistView = s.subTab !== 'library';
      const plView = isPlaylistView ? playlistById(s.subTab) : null;
      const musicBody = plView
        ? React.createElement(PlaylistDetail, { pl: plView, panelRef })
        : (rows.length > 0
          ? rows
          : React.createElement('div', { className: 'dsh-music-empty' }, '暂无音乐。点击上方“选择音乐目录”并选择目录后自动扫描。'));
      // 各 tab 的内容常驻渲染、非活动 tab 用 display:none 隐藏：这样切 tab 时
      // 不会卸载任何面板（本地音乐 / 系统配置），各自内部状态全部保留。
      const paneStyle = (key) => ({ display: s.tab === key ? '' : 'none' });
      // 两个 pane 直接在 .dsh-music-list（flex column）里；本地音乐 pane 保持
      // 普通块级，超高时由 .dsh-music-list 滚动。
      const listBody = React.createElement('div', { className: 'dsh-music-list-body' },
        React.createElement('div', { style: paneStyle('music') }, musicBody),
        React.createElement('div', { style: paneStyle('podcast'), className: 'dsh-music-podcast-pane' }, React.createElement(PodcastPanel, { panelRef })),
        React.createElement('div', { style: paneStyle('config') }, React.createElement(SystemSetting, null)));
      return React.createElement('div', { className: 'dsh-music-panel', ref: panelRef, style: rootStyle },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '⠿'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, 'DeepSeek Harness 音乐播放器'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => set({ panelOpen: false }) }, '✕')),
        React.createElement('div', { className: 'dsh-music-panel-body' },
          // Tab 标签竖排在窗口左侧（侧边栏），内容区在其右侧。
          React.createElement('div', { className: 'dsh-music-tabs' },
            tabBtn('music', '本地音乐'), tabBtn('podcast', '播客'), tabBtn('config', '系统配置')),
          React.createElement('div', { className: 'dsh-music-panel-content' },
            (s.tab === 'config' || s.tab === 'podcast') ? null : React.createElement(DirectorySetting, { panelRef }),
            s.tab === 'music' ? musicSubTabs : null,
            // 音乐错误/扫描提示统一在主列表区上方显示；系统配置页不显示曲库扫描相关的
            // 错误/加载提示。
            s.error && s.tab !== 'config' ? React.createElement('div', { className: 'dsh-music-error' }, s.error) : null,
            s.tab !== 'config' && s.loading ? React.createElement('div', { className: 'dsh-music-loading' }, '扫描中…') : null,
            React.createElement('div', { className: 'dsh-music-list', style: pos === null ? null : { maxHeight: 'none' }, ref: (el) => { listRef.current = el; } }, listBody),
          ),
        ),
        React.createElement('div', { className: 'dsh-music-resize', title: '拖动调整面板大小', onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp }),
        addMenu ? React.createElement(AddToPlaylistMenu, {
          track: addMenu.track, anchor: { x: addMenu.x, y: addMenu.y },
          onClose: () => setAddMenu(null),
        }) : null,
        s.prompt ? React.createElement(PromptModal, { key: s.prompt.id, panelRef }) : null,
        s.confirm ? React.createElement(ConfirmModal, { key: s.confirm.title, panelRef }) : null,
        s.toast ? React.createElement('div', { className: 'dsh-music-panel-toast' + (s.toast.ok ? ' ok' : ' err') }, s.toast.text) : null,
      );
    }
    // 自定义输入弹窗（替代浏览器 prompt）：新建/重命名歌单等需要名称输入的场景。
    // 以面板中心为基准居中；回车=确定、Esc/点遮罩/关闭=取消。key 由父级传 id，
    // 保证每次 openPrompt 打开时重新挂载、初始输入值正确。
    function PromptModal({ panelRef }) {
      const s = useStore();
      const p = s.prompt;
      if (p === null) return null;
      const [value, setValue] = useState(p.initial || '');
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);
      const submit = () => {
        const v = value.trim();
        if (v === '') return;
        closePrompt();
        if (typeof p.onOk === 'function') p.onOk(v);
      };
      const cancel = () => closePrompt();
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker prompt', style: panelCenterStyle(panelRef, true, 150, 160) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, p.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: cancel }, '✕')),
          React.createElement('input', {
            className: 'dsh-music-prompt-input', ref: inputRef, value,
            placeholder: '请输入名称', onChange: (e) => setValue(e.target.value), onKeyDown,
            'aria-label': p.title,
          }),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: submit }, '确定'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: cancel }, '取消')),
        )));
    }
    // 自定义确认弹窗（替代浏览器 confirm）：删除/清空歌单等破坏性操作前的确认。
    // 无输入框，仅标题 + 提示消息 + 确定/取消；以面板中心为基准居中。
    function ConfirmModal({ panelRef }) {
      const s = useStore();
      const c = s.confirm;
      if (c === null) return null;
      const ok = () => { closeConfirm(); if (typeof c.onOk === 'function') c.onOk(); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker confirm', style: panelCenterStyle(panelRef, true, 150, 280), onKeyDown },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, c.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeConfirm }, '✕')),
          c.message ? React.createElement('p', { className: 'dsh-music-hint' }, c.message) : null,
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn' + (c.danger ? ' danger' : ''), onClick: ok }, c.okText),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: closeConfirm }, '取消')),
        )));
    }
    // Directory setting block, embedded in the player panel (the former
    // 设置 → 音乐播放器 page moved in-panel so all library config lives in one place).
    function DirectorySetting({ panelRef }) {
      const s = useStore();
      const [pickerOpen, setPickerOpen] = useState(false);
      const [dirs, setDirs] = useState([]);
      const [files, setFiles] = useState([]);
      const [curPath, setCurPath] = useState('');
      const [curName, setCurName] = useState('');
      const [curCrumbs, setCurCrumbs] = useState([]);
      const [up, setUp] = useState(null); // 上级目录（Windows 盘符根时为 __drives__）
      const [dirError, setDirError] = useState(null);
      // 手动刷新按钮：扫描进行中禁用并显示「刷新中…」。
      const [refreshing, setRefreshing] = useState(false);
      const activeRoot = s.root;
      const pickerTitle = '选择音乐目录';
      const refreshTitle = '重新扫描音乐目录';
      const hint = '支持 mp3 / m4a / flac / wav / ogg / opus / aac / webm 等格式，自动递归扫描子目录。';
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-settings-row' },
          React.createElement('span', { className: 'dsh-music-settings-cur', title: activeRoot || '' },
            '📁 ' + (activeRoot || '未配置')),
          React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => openPicker() }, pickerTitle),
          // 手动刷新：重新扫描当前目录（新增文件后无需重选目录即可看到）。
          React.createElement('button', {
            className: 'dsh-music-settings-btn ghost',
            title: refreshTitle,
            disabled: refreshing,
            onClick: async () => {
              if (refreshing) return;
              setRefreshing(true);
              await rescanLibrary();
              setRefreshing(false);
            },
          }, refreshing ? '刷新中…' : '刷新')),
        React.createElement('p', { className: 'dsh-music-hint' }, hint),
        pickerOpen ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
          React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, pickerOpen, 320, Math.round(window.innerHeight * 0.72)) },
            React.createElement('div', { className: 'dsh-music-picker-head' },
              React.createElement('span', { className: 'dsh-music-picker-title' }, pickerTitle),
              React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => setPickerOpen(false) }, '✕')),
            React.createElement('div', { className: 'dsh-music-picker-cur', title: curPath },
              renderCrumbs(curCrumbs, curPath, curName, browse)),
            React.createElement('div', { className: 'dsh-music-picker-list' },
              // 上级目录（尤其 Windows 盘符根 → 回到「本机磁盘」列表以便切换 E/F 等盘）。
              up ? React.createElement('button', {
                key: '__up',
                className: 'dsh-music-picker-item up',
                title: '上级目录：' + up,
                onClick: () => browse(up),
              }, up === '__drives__' ? '⬆ 本机磁盘（切换盘符）' : '⬆ 上级目录') : null,
              // 目录排在前（可点击进入），文件排在后（仅作展示，不响应点击）。
              dirs.map((d) => React.createElement('button', {
                key: d.path,
                className: 'dsh-music-picker-item',
                title: d.path,
                onClick: () => browse(d.path),
              }, '📁 ' + d.name)),
              files.map((f) => React.createElement('span', {
                key: f.path,
                className: 'dsh-music-picker-item file',
                title: f.path,
              }, '📄 ' + f.name)),
              dirError ? React.createElement('div', { className: 'dsh-music-error' }, dirError) : null,
            ),
            React.createElement('div', { className: 'dsh-music-picker-foot' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => pickCurrent() }, '选择此目录'),
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setPickerOpen(false) }, '取消'),
            ),
          ),
        )) : null,
      );
      function openPicker() {
        setPickerOpen(true);
        setDirError(null);
        // Open directly at the currently configured root (for this tab) so the
        // user sees the existing choice first; fall back to the home when unset.
        browse(activeRoot || '');
      }
      async function browse(path) {
        setDirError(null);
        try {
          const data = await jsonGet('/dsh-music-plus/dir?path=' + encodeURIComponent(path || ''));
          if (data && data.error) { setDirError(data.error); return; }
          setCurPath(data.path || '');
          setCurName(data.name || '');
          setCurCrumbs(data.crumbs || []);
          setUp(data.up || null);
          setDirs(data.dirs || []);
          setFiles(data.files || []);
        } catch (err) {
          setDirError('读取目录失败：' + String((err && err.message) || err));
        }
      }
      function pickCurrent() {
        const p = curPath;
        // The drive-list view ("__drives__") is not a real directory.
        if (p === '' || p === '__drives__') return;
        setPickerOpen(false);
        saveRoot(p, 'music');
      }
    }
    // 系统配置面板（「系统配置」tab）：播放条歌词 / 频谱显示开关，持久化到 Host prefs。
    function SystemSetting() {
      const s = useStore();
      // 通用开关行：右侧一个开关按钮，点击切换并保存。
      const toggleRow = (label, desc, value, onChange) => React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, label),
          desc ? React.createElement('span', { className: 'dsh-music-config-desc' }, desc) : null),
        React.createElement('button', {
          className: 'dsh-music-toggle' + (value ? ' on' : ''),
          role: 'switch',
          'aria-checked': value,
          onClick: () => onChange(!value),
        }, React.createElement('span', { className: 'dsh-music-toggle-knob' })));
      // 沉浸感：鼠标移出后播放条变半透明。拖动滑块调节透明度。
      const immersePct = Math.round(s.immerse * 100);
      const immerseRow = React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, '沉浸感'),
          React.createElement('span', { className: 'dsh-music-config-desc' }, '鼠标移出后播放条的透明度')),
        React.createElement('div', { className: 'dsh-music-config-slider' },
          React.createElement('input', {
            className: 'dsh-music-config-range', type: 'range', min: 0, max: 100, step: 5,
            value: immersePct,
            onChange: (e) => set({ immerse: Number(e.target.value) / 100 }),
          }),
          React.createElement('span', { className: 'dsh-music-config-val' }, immersePct + '%')));
      // 频谱样式：柱状图（经典 12 段）或波形图（示波器式连续曲线）。两者都只由
      // 实时 captureStream 捕获驱动，失败即不显示（无离线回退）。
      const vizModeOptions = [
        ['bars', '柱状图'],
        ['wave', '波形图'],
      ];
      const vizModeRow = React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, '频谱样式'),
          React.createElement('span', { className: 'dsh-music-config-desc' }, '柱状图（频段能量）或波形图（示波器曲线）')),
        React.createElement('div', { className: 'dsh-music-config-seg' },
          vizModeOptions.map(([val, label]) => React.createElement('button', {
            key: val,
            className: 'dsh-music-config-seg-btn' + (s.vizMode === val ? ' on' : ''),
            onClick: () => set({ vizMode: val }),
            'aria-pressed': s.vizMode === val,
            title: label,
          }, label))));
      // 分组卡片：把相关的配置行放进同一个带标题的卡片里（歌词一组、频谱一组），
      // 卡片内行之间用细分隔线，视觉上归为一类。
      // 分组卡片：把相关的配置行放进同一个外框里（歌词一组、频谱一组），卡片内行之间
      // 用细分隔线，视觉上归为一类（无标题文字）。
      const configCard = (...children) => React.createElement('div', { className: 'dsh-music-config-card' }, children);
      return React.createElement('div', { className: 'dsh-music-config' },
        configCard(
          toggleRow('频谱显示', '播放条上显示实时音频频谱', s.showViz, (v) => set({ showViz: v })),
          s.showViz ? vizModeRow : null,
        ),
        toggleRow('音质徽章显示', '在歌名后显示音质徽章', s.showQuality, (v) => set({ showQuality: v })),
        toggleRow('进度条显示', '播放条底部显示播放进度条', s.showProgress, (v) => set({ showProgress: v })),
        toggleRow('播放条背景显示', '显示播放条边框与背景色', s.showBarBg, (v) => set({ showBarBg: v })),
        immerseRow,
      );
    }
    // 「加入歌单」弹层：曲库每行「＋」点击后出现，列出所有歌单（含我最喜欢）并可新建。
    // 用 fixed 定位（锚点为按钮视口坐标），避免被面板滚动列表裁剪。
    function AddToPlaylistMenu({ track, anchor, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        const onDown = (e) => { if (ref.current !== null && !ref.current.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [onClose]);
      const openUp = (anchor.y || 0) > ((window.innerHeight || 0) - 240);
      const style = {
        left: Math.max(8, (anchor.x || 0) - 150),
        top: openUp ? (anchor.y || 0) - 6 : (anchor.y || 0) + 8,
        transform: openUp ? 'translateY(-100%)' : 'none',
      };
      const list = store.playlists || [];
      // 加入已有歌单：成功关弹窗并居中提示，失败保留弹窗（可换歌单重试）居中提示。
      const addTo = (id) => {
        const pl = list.find((p) => p.id === id);
        const name = (pl && pl.name) || '歌单';
        apiPlaylistAdd(id, [track.path], (r) => {
          if (r && r.ok && r.playlist) { onClose(); showToast('添加到' + name + '成功', true); }
          else showToast('添加到' + name + '失败', false);
        });
      };
      const addNew = () => {
        openPrompt('新建歌单名称', '', (trimmed) => {
          if (!trimmed) return;
          fetch('/dsh-music-plus/playlist', {
            method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          }).then((r) => r.json()).then((r) => {
            if (r && r.playlist) {
              set({ playlists: [...(store.playlists || []), r.playlist] });
              apiPlaylistAdd(r.playlist.id, [track.path], (add) => {
                if (add && add.ok && add.playlist) { onClose(); showToast('添加到' + r.playlist.name + '成功', true); }
                else showToast('添加到' + r.playlist.name + '失败', false);
              });
            } else {
              showToast('添加到' + trimmed + '失败', false);
            }
          }).catch(() => showToast('添加到' + trimmed + '失败', false));
        });
      };
      return React.createElement('div', { className: 'dsh-music-add-pop', ref, style },
        list.length > 0 ? list.map((p) => React.createElement('button', {
          key: p.id,
          className: 'dsh-music-add-pop-item',
          title: '加入「' + p.name + '」',
          onClick: () => addTo(p.id),
        }, (p.id === FAV_PLAYLIST_ID ? '♥ ' : '') + p.name + '（' + p.count + '）')) : null,
        React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: addNew }, '＋ 新建歌单'),
      );
    }
    // 歌单详情：添加歌曲 + 重命名/删除 + 歌曲列表（移除/上移/下移）。
    function PlaylistDetail({ pl, panelRef }) {
      const [pickerOpen, setPickerOpen] = useState(false);
      const rows = (pl.tracks || []).map((t, idx) => {
        const active = t.id === store.currentId;
        const playing = active && store.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-playlist-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track',
            title: t.path,
            // Same double-click guard as the library rows: the second click of a
            // dblclick must not togglePlay() (pause) the just-started track.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'playlist', pl.id); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + (idx + 1) + '. ' + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '上移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, -1); } }, '↑'),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '下移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, 1); } }, '↓'),
          React.createElement('button', { className: 'dsh-music-playlist-mini del', title: '从歌单移除', onClick: (e) => { e.stopPropagation(); apiPlaylistRemove(pl.id, [t.path]); } }, '×'),
        );
      });
      return React.createElement('div', { className: 'dsh-music-playlist' },
        React.createElement('div', { className: 'dsh-music-playlist-head' },
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => setPickerOpen(true) }, '＋ 添加歌曲'),
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onClearPlaylist(pl) }, '清空'),
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onRenamePlaylist(pl) }, '重命名') : null,
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onDeletePlaylist(pl) }, '删除') : null,
          pl.missing > 0 ? React.createElement('span', { className: 'dsh-music-playlist-missing', title: '部分歌曲文件已被移动或删除' }, pl.missing + ' 首已失效') : null,
        ),
        rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-music-empty dsh-music-playlist-empty' }, '歌单为空，点击「添加歌曲」从本地文件选择音乐。'),
        pickerOpen ? React.createElement(FilePicker, { pl, panelRef, onClose: () => setPickerOpen(false) }) : null,
      );
    }
    // 文件系统多选器：浏览目录 + 勾选音频文件，用于歌单「添加歌曲」。
    function FilePicker({ pl, panelRef, onClose }) {
      const [cur, setCur] = useState({ path: '', name: '', dirs: [], files: [], crumbs: [], up: null });
      const [sel, setSel] = useState(new Set());
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const browse = async (p) => {
        setErr(null);
        try {
          const data = await jsonGet('/dsh-music-plus/files?path=' + encodeURIComponent(p || ''));
          if (data && data.error) { setErr(data.error); return; }
          setCur({ path: data.path || '', name: data.name || '', dirs: data.dirs || [], files: data.files || [], crumbs: data.crumbs || [], up: data.up || null });
        } catch (e) { setErr('读取目录失败：' + String((e && e.message) || e)); }
      };
      // 默认定位到音乐目录（store.root），未配置时回退家目录。
      useEffect(() => { browse(store.root || ''); }, []);
      const toggle = (p) => {
        const next = new Set(sel);
        if (next.has(p)) next.delete(p); else next.add(p);
        setSel(next);
      };
      const confirmAdd = async () => {
        const paths = [...sel];
        if (paths.length === 0 || busy) { onClose(); return; }
        setBusy(true);
        apiPlaylistAdd(pl.id, paths, () => onClose());
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, true, 320, Math.round(window.innerHeight * 0.72)) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, '添加歌曲到「' + pl.name + '」'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: onClose }, '✕')),
          React.createElement('div', { className: 'dsh-music-picker-cur', title: cur.path },
            renderCrumbs(cur.crumbs, cur.path, cur.name, browse)),
          React.createElement('div', { className: 'dsh-music-picker-list' },
            cur.up ? React.createElement('button', {
              key: '__up', className: 'dsh-music-picker-item up', title: '上级目录：' + cur.up,
              onClick: () => browse(cur.up),
            }, cur.up === '__drives__' ? '⬆ 本机磁盘（切换盘符）' : '⬆ 上级目录') : null,
            (cur.dirs || []).map((d) => React.createElement('button', {
              key: d.path, className: 'dsh-music-picker-item', title: d.path,
              onClick: () => browse(d.path),
            }, '📁 ' + d.name)),
            (cur.files || []).map((f) => {
              const checked = sel.has(f.path);
              return React.createElement('button', {
                key: f.path,
                className: 'dsh-music-file-item' + (checked ? ' checked' : ''),
                title: f.path,
                onClick: () => toggle(f.path),
              },
                React.createElement('span', { className: 'dsh-music-file-check' }, checked ? '✓' : ''),
                React.createElement('span', { className: 'dsh-music-file-name' }, f.name),
                React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(f.size)),
              );
            }),
            err ? React.createElement('div', { className: 'dsh-music-error' }, err) : null,
          ),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: confirmAdd, disabled: busy }, '确定添加（' + sel.size + '）'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: onClose }, '取消'),
          ),
        ),
      ));
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-music-plus');
        styleEl.textContent = PLAYER_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      ctx.effect(() => {
        attachAudioElements();
        const unbind = bindAudio();
        startRaf();
        // The live analyser is a captureStream() TAP — created only once a real src is
        // loaded (startPlay/onPlay), NOT up front, because a stream captured before any
        // src exists can carry no audio track. We deliberately avoid createMediaElementSource
        // here: it re-routes the element's output into the Web Audio graph and goes
        // SILENT whenever that graph/context isn't running (which is what broke audio
        // after switching tracks). The tap can never mute the player; if the tap can't
        // provide audio (the getTopURL bug) we fall back to the offline FFT envelope.
        const accentWatch = watchAccent();
        // Browsers auto-release a wake lock when the page is hidden; re-acquire
        // on return if playback is still running, and drop it on hide so we
        // don't hold it while the tab is backgrounded.
        const onVis = () => {
          if (document.hidden) releaseWakeLock();
          else { acquireWakeLock(); resumeVizCtx(); }
        };
        // On refresh/unload, stop the media element cleanly BEFORE the document
        // is torn down — otherwise Chromium's media pipeline can race the
        // teardown and throw an internal "getTopURL" error in the console.
        const onPageHide = () => {
          try { audio.pause(); } catch (e) {}
          try { preAudio.pause(); } catch (e) {}
          // Best-effort flush of pending prefs to the Host before teardown
          // (fetch uses keepalive; if the request is cut off, the periodic and
          // debounced flushes have normally already persisted the state).
          void flushServerPrefs();
        };
        document.addEventListener('visibilitychange', onVis);
        // Resume the analyser's AudioContext on any user gesture so it's already
        // running when a track starts. setupLiveViz() creates the tap once a real src
        // is loaded (startPlay/onPlay); the context just needs to be running for the
        // bars to move.
        const onFirstGesture = () => { resumeVizCtx(); };
        window.addEventListener('pointerdown', onFirstGesture);
        window.addEventListener('keydown', onFirstGesture, true);
        window.addEventListener('pagehide', onPageHide);
        // This Chromium's media pipeline throws a benign internal "getTopURL" TypeError
        // as an UNHANDLED promise rejection while a media element is routed through
        // Web Audio (needed for the live spectrum) with our proxied stream. It does NOT
        // affect playback or the analyser — but it spams the console. Suppress exactly
        // that benign case; leave every other rejection untouched.
        const onUnhandled = (ev) => {
          const r = ev && ev.reason;
          if (r && /getTopURL/.test(String((r && r.message) || r))) ev.preventDefault();
        };
        window.addEventListener('unhandledrejection', onUnhandled);
        return () => {
          window.removeEventListener('unhandledrejection', onUnhandled);
          window.removeEventListener('pagehide', onPageHide);
          window.removeEventListener('pointerdown', onFirstGesture);
          window.removeEventListener('keydown', onFirstGesture, true);
          document.removeEventListener('visibilitychange', onVis); stopRaf(); unbind(); closeLiveViz(); releaseWakeLock();
          if (accentWatch !== null) accentWatch.disconnect();
          accentObserver = null;
        };
      }, 'music-player-plus: audio + viz engine');

      loadTracks();

      const intentTimer = setInterval(() => {
        jsonGet('/dsh-music-plus/intent').then((intent) => {
          if (intent === null || typeof intent !== 'object') return;
          const action = intent.action || 'play';
          // Transport commands operate on the current playback state (no track id).
          if (action === 'pause') { audio.pause(); set({ playing: false }); return; }
          if (action === 'resume') {
            const p = audio.play();
            if (p !== undefined && typeof p.catch === 'function') p.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败' }); });
            return;
          }
          if (action === 'stop') { stop(); return; }
          if (action === 'next') { step(1); return; }
          if (action === 'prev') { step(-1); return; }
          // play with a playlist: switch scope to that playlist and start it.
          if (intent.playlistId) {
            const pl = playlistById(intent.playlistId);
            if (pl && pl.tracks && pl.tracks.length > 0) {
              startPlayFrom(pl.tracks[0].id, 'playlist', pl.id);
            }
            return;
          }
          // play (default): needs an id.
          if (intent.id === undefined) return;
          const track = resolvePlayable(intent.id);
          if (track !== null) {
            // 换到一首「新」的曲目：清除刷新恢复的定位钉，避免 onTime 把新曲目 seek
            // 回上一首的保存进度（换歌从旧进度开始）。play 意图=从头开始（续播走
            // togglePlay / resume 意图），因此这里无条件清除。
            restoredMusicPos = null;
            audio.src = track.url;
            audio.load();
            set({ currentId: intent.id, currentName: track.name, currentArtists: track.artists || [], error: null, scope: { kind: 'library' }, position: 0, duration: 0 });
            savePlayback();
            const promise = audio.play();
            if (promise !== undefined && typeof promise.catch === 'function') {
              promise.catch((err) => {
                if (!isAutoplayBlocked(err)) return;
                set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: intent.id, pendingName: track.name });
              });
            }
          }
        }).catch(() => {});
      }, 2000);

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'music-player-plus-bar', order: 40 },
        () => React.createElement(NowPlayingBar),
      )), 'music-player-plus: now playing bar');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-player-plus-panel', order: 20 },
        () => React.createElement(PlayerPanel),
      )), 'music-player-plus: overlay panel');

      ctx.effect(() => () => clearInterval(intentTimer), 'music-player-plus: intent poll stop');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS ----
    const PLAYER_CSS = '\n' +
      // Accent follows the host app's theme brand color (stable from the start —
      // no green-default-to-sampled-blue flash); green is only the fallback when
      // the app exposes no brand color. The alias must be declared on BODY, not
      // :root: DSH defines its --dsw-alias-* theme tokens on <body> only, and a
      // var() reference resolves against the element that declares it — on
      // :root (html) it cannot see body's tokens and would always fall back to
      // green. Declared on body, the reference resolves and children inherit
      // the theme's actual brand color.
      'body { --dsh-music-accent: var(--dsw-alias-brand-primary, #2f9e6e); --dsh-music-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      '.dsh-music-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
      '.dsh-music-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; cursor: default; user-select: none; position: relative; overflow: hidden; transition: opacity 0.3s ease; }\n' +
      // 系统配置「播放条背景显示」关闭时：去掉播放条外壳的边框与背景色，只保留内容
      // （歌名/歌词/频谱/按钮等子元素自身样式独立，不受影响；内边距/圆角/布局保持不变）。
      '.dsh-music-bar.bare { background: transparent; border: none; }\n' +
      '.dsh-music-bar.dimmed { opacity: var(--dsh-music-immerse, 0.5); }\n' +
      // 播放进度细线：绝对定位在播放条底部（占满其宽度），高 1px、视觉上是一条细线；
      // 轨道用低透明度衬底色，填充部分用主题色，随 position/duration 实时前进
      // （宽度 0.12s 平滑过渡）。播放条容器已 overflow:hidden，细线两端会被裁剪到
      // 圆角形状内，不会「戳出」圆角之外；pointer-events:none 避免挡住下方交互。
      // 轨道色用「次级文字色 + 低透明度」而非 bg-layer-2：后者在深色主题是亮层级、
      // 浅色主题也是亮层级，浅色背景下几乎不可见；文字色在深色主题偏亮、浅色主题
      // 偏暗，无论深浅背景都能衬出一条可见的细线轨道。
      '.dsh-music-bar-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-bar-progress-track { position: absolute; left: 0; right: 0; bottom: 3px; height: 1px; background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 28%, transparent); }\n' +
      '.dsh-music-bar-progress-fill { position: absolute; left: 0; bottom: 3px; height: 1px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 60%, var(--dsw-alias-bg-base)); transition: width 0.05s linear; }\n' +
      '.dsh-music-bar-progress:hover .dsh-music-bar-progress-fill { height: 2px; }\n' +
      '.dsh-music-bar-progress-thumb { position: absolute; bottom: 1px; left: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); transform: translateX(-50%); opacity: 0; transition: opacity 0.12s; pointer-events: none; box-shadow: 0 1px 2px rgba(0,0,0,0.35); }\n' +
      '.dsh-music-bar-progress.alive .dsh-music-bar-progress-thumb { opacity: 1; }\n' +
      '.dsh-music-bar-idle { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; display: inline-flex; align-items: center; }\n' +
      '.dsh-music-bar-name { max-width: 36%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; min-width: 0; }\n' +
      '.dsh-music-note { color: var(--dsh-music-accent, #2f9e6e); flex: none; margin-right: 4px; }\n' +
      // canvas 默认是 inline 级元素，会有基线留白导致在 flex 行里整体偏上；
      // display:block + margin:auto 0 + align-self:center 显式保证画布在播放条垂直居中。
      '.dsh-music-viz { flex: none; display: block; width: 60px; height: 20px; margin: auto 0; align-self: center; }\n' +
      // 歌词/字幕：夹在频谱与时长之间，吃掉剩余宽度，文本在可用空间内水平居中。
      // 三层结构：outer(定宽裁剪/遮罩/溢出标记) → run(跑马灯平移层) → fx(入场动画层)。
      // 无退场动画：上一句随 fx 重挂即时消失（data-prev 仅作「首次挂载」延迟判定）。
      // 首次出现仍延迟 0.28s（与控件组滑出 0.3s 对齐，:not([data-prev]) 只命中
      // 「无上一行」的首次挂载），行间切换立即播放过渡不额外等待。
      // 边缘渐隐（内置恒开）：两端各留 ~1em 渐变。未溢出时遮罩落在空白上，无视觉副作用。
      '.dsh-music-bar-lyric { flex: 1 1 auto; min-width: 0; overflow: hidden; text-align: center; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 14px; position: relative; -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); }\n' +
      // 中层：跑马灯平移；暂停时跟随音频停住（paused 由 playing prop 下发）。
      '.dsh-music-bar-lyric-run { display: inline-block; white-space: nowrap; max-width: none; }\n' +
      // 未溢出（无 .mq）时显式复位 transform，杜绝上一句动画值残留导致的短句被平移。
      '.dsh-music-bar-lyric-run:not(.mq) { transform: none; }\n' +
      '.dsh-music-bar-lyric-run.mq { animation: dsh-lyric-mq var(--mq-dur, 8s) ease-in-out infinite alternate; }\n' +
      '.dsh-music-bar-lyric-run.paused, .dsh-music-bar-lyric-fx.fxfrozen { animation-play-state: paused; }\n' +
      '@keyframes dsh-lyric-mq { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--mq-over, 0px))); } }\n' +
      // fx 层：内联块收缩到文本宽度，退场伪元素 inset:0 精确叠在字形上。
      '.dsh-music-bar-lyric-fx { display: inline-block; position: relative; white-space: nowrap; }\n' +
      // — 入场动画（none 无 → 选择器不命中）：
      ".dsh-music-bar-lyric-fx[data-fx='slide'] { animation: dsh-lyric-slide-in 0.32s cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }\n" +
      ".dsh-music-bar-lyric-fx[data-fx='blur'] { animation: dsh-lyric-blur-in 0.42s ease-out backwards; }\n" +
      // 首次挂载（没有上一行）：推迟出现，避开按钮组收起过程（见上方注释）。
      ".dsh-music-bar-lyric-fx:not([data-prev])[data-fx='slide'], .dsh-music-bar-lyric-fx:not([data-prev])[data-fx='blur'] { animation-delay: 0.28s; }\n" +
      // （退场动画已移除：上一句随 fx 重挂即时消失，不叠映过渡；data-prev 仍保留，
      // 仅用于上方「首次挂载」的入场延迟判定。）
      // karaoke 扫色：background-clip:text 上色，--kar-dur/--kar-delay(-elapsed) 让扫描
      // 定位到行内当前进度；暂停时整体停帧。配色走「明度+色相双重反差」才够醒目：
      // 已唱 = accent 实色绿；扫描头 = 41%→42% 一窄条混白高光（发亮的边界，一眼可见）；
      // 未唱 = 主文字色降到 40% 不透明度的「暗场」（比原来的中灰对比强得多）。羽化带
      // 收窄到 3%（原 10%），扫过的是清晰边界而不是一大片渐糊。背景 250% 宽 + 位置
      // 100%→0% 平移：起末两端分别正好露出纯暗场/纯绿色段（几何上已按窗口覆盖率校准）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-image: linear-gradient(90deg, var(--dsh-music-accent, #2f9e6e) 0%, var(--dsh-music-accent, #2f9e6e) 41%, color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, #fff) 42%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 44%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 100%); background-size: 250% 100%; background-repeat: no-repeat; -webkit-background-clip: text; background-clip: text; color: transparent; animation: dsh-kar-sweep var(--kar-dur, 6s) linear var(--kar-delay, 0s) backwards, dsh-kar-in 0.22s ease backwards; }\n" +
      // 音频时钟驱动模式（QRC 行窗口）：停用墙钟关键帧动画与过渡——位置由
      // karaokeFrame 逐帧按精确逆映射直写（帧间增量本身很小，无需过渡平滑；
      // 过渡反而会让渲染值持续落后目标）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'][data-audioclock] { animation: dsh-kar-in 0.22s ease backwards; transition: none; }\n" +
      '@keyframes dsh-kar-sweep { from { background-position-x: 100%; } to { background-position-x: 0%; } }\n' +
      '@keyframes dsh-kar-in { from { opacity: 0; } to { opacity: 1; } }\n' +
      // 未唱「暗场」由 250% 渐变铺满实现；若浏览器不支持 color-mix，整个 gradient 失效
      // 会退化为无背景 → 文字全透明不可见！因此无 @supports 时先给一个实色兜底：
      // 先声明 background-color 后再被支持的浏览器以 background-image 覆盖观感。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-color: transparent; }\n" +
      "@supports not (background: color-mix(in srgb, red 50%, blue)) {\n" +
      "  .dsh-music-bar-lyric-fx[data-fx='karaoke'] { color: var(--dsw-alias-label-primary, #e6e6e6); }\n" +
      "}\n" +
      // karaoke 已移除退场伪元素（上一句即时消失）。
      '@keyframes dsh-lyric-slide-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }\n' +
      '@keyframes dsh-lyric-blur-in { from { opacity: 0; filter: blur(5px); transform: translateY(3px); } to { opacity: 1; filter: blur(0); transform: translateY(0); } }\n' +
      // 减动效：全部歌词动画停用；溢出行左对齐起步（跑马灯不滚动时至少能读到行首）。
      '@media (prefers-reduced-motion: reduce) { .dsh-music-bar-lyric-run.mq, .dsh-music-bar-lyric-fx { animation: none !important; } .dsh-music-bar-lyric-fx[data-audioclock] { transition: none !important; } .dsh-music-bar-lyric-run.mq { text-align: left; } }\n' +
      '.dsh-music-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; cursor: pointer; padding: 0; white-space: nowrap; }\n' +
      '.dsh-music-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }\n' +
      '.dsh-music-bar-btn:hover { color: var(--dsh-music-accent-fg, #fff); background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.active { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-vol { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      '.dsh-music-bar-vol-pop { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; width: 36px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); z-index: 60; }\n' +
      // 讲书时音量弹层加宽，容纳 AI 声音选择 + 音量条。
      '.dsh-music-bar-vol-pop.book { width: 136px; height: auto; padding: 10px; flex-direction: column; gap: 10px; align-items: stretch; }\n' +
      '.dsh-music-voice { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-voice-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-voice-select { width: 100%; padding: 4px 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.3)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; cursor: pointer; }\n' +
      '.dsh-music-voice-switching { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-vol-pop.book .dsh-music-vol-slider { align-self: center; }\n' +
      '.dsh-music-vol-slider { position: relative; width: 24px; height: 84px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-vol-track { position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); }\n' +
      '.dsh-music-vol-fill { position: absolute; left: 50%; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-vol-thumb { position: absolute; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }\n' +
      // 时长：与按钮组同源的「从右滑入」动画——悬停时按钮组展开、时长挂载进场，
      // 二者同步从右侧滑入（translateX 16px→0 + 淡入），避免时长突兀地「直接显示」。
      '.dsh-music-bar-time { line-height: 1; font-variant-numeric: tabular-nums; animation: dsh-music-time-in 0.3s ease; }\n' +
      '@keyframes dsh-music-time-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }\n' +
      '.dsh-music-bar-hint { color: var(--dsw-alias-state-warn-primary, #d9a441); white-space: nowrap; }\n' +
      // 时长 + 控制按钮的组合：右对齐（margin-left:auto 把整个组合推到最右）。
      '.dsh-music-bar-controls { display: inline-flex; align-items: center; gap: 8px; flex: none; margin-left: auto; min-width: 0; }\n' +
      // 控制按钮组：默认折叠（max-width:0 + overflow:hidden 裁剪），鼠标进入播放条时
      // 从右向左滑入展开（translateX + opacity）。折叠时时长与按钮一并隐藏（闲置态）。
      // overflow:hidden 只用于裁剪左右滑动的按钮；三个向上弹出的弹层（音量/模式/
      // 章节目录）已改为 portal 渲染到 body，不受此裁剪影响。
      '.dsh-music-bar-btns { display: inline-flex; align-items: center; gap: 8px; overflow: hidden; max-width: 0; opacity: 0; transform: translateX(16px); transition: max-width 0.3s ease, opacity 0.2s ease, transform 0.3s ease; white-space: nowrap; }\n' +
      '.dsh-music-bar-controls.on .dsh-music-bar-btns { max-width: 340px; opacity: 1; transform: translateX(0); }\n' +
      '.dsh-music-bar-buffering { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.dsh-music-spinner { width: 12px; height: 12px; border: 2px solid var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.2)); border-top-color: var(--dsh-music-accent, #2f9e6e); border-radius: 50%; animation: dsh-music-spin 0.8s linear infinite; flex: none; }\n' +
      '@keyframes dsh-music-spin { to { transform: rotate(360deg); } }\n' +
      '.dsh-music-bar-berr { margin-left: 8px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; display: inline-flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-bar-berr-text { overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-bar-btn.retry { width: auto; color: var(--dsw-alias-state-error-primary, #e5534b); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; padding: 0 6px; height: 18px; flex: none; }\n' +
      '.dsh-music-bar-btn.retry:hover { background: var(--dsw-alias-state-error-primary, #e5534b); color: #fff; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger { width: 24px; height: 24px; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger svg { flex: none; }\n' +
      '.dsh-music-bar .dsh-music-mode-menu { align-self: center; }\n' +
      '.dsh-music-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 600px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      '.dsh-music-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; z-index: 5; }\n' +
      '.dsh-music-resize::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 5px; height: 5px; border-right: 2px solid var(--dsw-alias-label-secondary, #8a8f98); border-bottom: 2px solid var(--dsw-alias-label-secondary, #8a8f98); opacity: 0.7; }\n' +
      '.dsh-music-resize:hover::after { opacity: 1; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      // 面板主体：左右布局——左侧 Tab 侧边栏，右侧内容区。两侧紧贴（gap:0），
      // 选中 tab 就能与内容区无缝连成整体。
      '.dsh-music-panel-body { display: flex; flex-direction: row; gap: 0; flex: 1; min-height: 0; }\n' +
      // 内容区：不设背景，透出面板自然底色；与左侧深色侧边栏靠明暗对比区分。
      '.dsh-music-panel-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; min-height: 0; padding-left: 12px; }\n' +
      // Tab 标签竖排在窗口左侧（侧边栏）：背景比右侧略深。左右无内边距保证
      // 选中项撑满整列并与内容区无缝连接；上下内边距加大，让标签组与上方标题、
      // 下方边缘留出呼吸空间。
      '.dsh-music-tabs { display: flex; flex-direction: column; gap: 4px; flex: none; width: 88px; padding: 48px 0; background: rgba(0,0,0,0.28); }\n' +
      '.dsh-music-tab { flex: none; width: 100%; padding: 16px 8px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; }\n' +
      // 选中的 tab：用面板底色填充，与右侧透明内容区同色、右缘直通（无缝隙）连成整体；
      // 左缘一条强调色竖条 + 加粗，指示当前所在项。
      '.dsh-music-tab.active { background: var(--dsw-alias-bg-overlay, #1e1f22); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; box-shadow: inset 3px 0 0 var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-drag { cursor: move; touch-action: none; user-select: none; }\n' +
      '.dsh-music-panel-grip { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; letter-spacing: -1px; opacity: 0.7; }\n' +
      '.dsh-music-panel-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-icon-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }\n' +
      '.dsh-music-icon-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-panel-root { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-mode-menu { position: relative; flex: none; }\n' +
      '.dsh-music-mode-menu.right { margin-left: auto; }\n' +
      '.dsh-music-mode-trigger { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; }\n' +
      '.dsh-music-mode-trigger:hover, .dsh-music-mode-trigger.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-mode-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-mode-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }\n' +
      '.dsh-music-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-mode-item.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 60px; max-height: 42vh; }\n' +
      // pane 层的包裹 div：改成 flex 列容器（否则它是块级元素，QQ pane 的 flex:1
      // 不生效、没有确定高度，导致 .dsh-music-qq-body 不滚动、整棵被 .dsh-music-list
      // 滚走 → 滚动条会盖住固定的 head）。设为 flex:1+min-height:0 撑满列表区高度：
      // QQ pane 内的 .dsh-music-qq-body 成为唯一滚动容器，滚动条只出现在 head 下方。
      // 本地音乐/讲书 pane 因 min-height:auto 不会被压缩、仍超高溢出、由列表滚动，行为不变。
      '.dsh-music-list-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }\n' +
      '.dsh-music-track { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-track:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 正在播放/选中的条目：填充强调色底 + 强调色文字，让当前条目一眼可见（选中态）。
      '.dsh-music-track.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 在线 QQ 歌曲行：歌名 + 内嵌 VIP 徽标并排，歌名省略、VIP 徽标不省略。
      '.dsh-music-track-name.qq { display: inline-flex; align-items: center; gap: 5px; overflow: hidden; }\n' +
      '.dsh-music-track-name.qq .dsh-music-track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-track-name.qq .dsh-music-online-tag { flex: 0 0 auto; margin-left: 0; }\n' +
      // 歌单卡片：封面图 + 名称 + 元信息，网格排布。
      '.dsh-music-playlist-card { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.06)); border-radius: 10px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-playlist-card:hover { border-color: var(--dsh-music-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); }\n' +
      // 「我的歌单」卡片：外层相对定位，右上角删除按钮悬浮。
      '.dsh-music-qq-mine-card { position: relative; }\n' +
      '.dsh-music-qq-mine-del { position: absolute; top: 6px; right: 6px; z-index: 2; width: 20px; height: 20px; line-height: 18px; padding: 0; text-align: center; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,0.55)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-mine-card:hover .dsh-music-qq-mine-del { opacity: 1; }\n' +
      '.dsh-music-qq-mine-del:hover { color: #fff; background: #c9352c; border-color: #c9352c; }\n' +
      // 「取消收藏」用星标图标，悬停金色以区分于删除。
      '.dsh-music-qq-mine-del.uncollect:hover { color: #fff; background: #d9a441; border-color: #d9a441; }\n' +
      '.dsh-music-playlist-cover { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 无封面（酷狗「默认收藏」等系统歌单接口不返回 pic）时的音符占位块。
      '.dsh-music-playlist-cover.empty { display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); }\n' +
      '.dsh-music-playlist-cover.empty .dsh-music-note { width: 24px; height: 24px; }\n' +
      '.dsh-music-playlist-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n' +
      '.dsh-music-playlist-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.dsh-music-playlist-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }\n' +
      '.dsh-music-playlist-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-topdetail-head { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }\n' +
      // 「加载更多」：水平居中 + 圆角胶囊按钮。
      '.dsh-music-qq-loadmore { display: flex; justify-content: center; margin: 14px 0 6px; }\n' +
      '.dsh-music-qq-loadmore-btn { padding: 7px 22px; border-radius: 20px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-loadmore-btn:hover { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 公开歌单详情页「收藏」按钮：头部标题行下方一条胶囊按钮；已收藏置灰不可点。
      '.dsh-music-qq-collect-pl { align-self: flex-start; margin: 2px 0 6px; padding: 5px 14px; border-radius: 14px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-collect-pl:hover:not(:disabled) { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-qq-collect-pl:disabled { cursor: default; border-color: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-track-size { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-empty { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }\n' +
      '.dsh-music-loading { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      // 系统配置面板：开关行（标签 + 描述 + 右侧开关）。
      // ---- 播客页签 ----
      '.dsh-music-podcast { display: flex; flex-direction: column; gap: 12px; }\n' +
      '.dsh-music-podcast-add { display: flex; gap: 8px; }\n' +
      '.dsh-music-podcast-input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }\n' +
      // 订阅源横排（可横向滚动）：封面 + 名称的小卡片。
      '.dsh-music-podcast-sources { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 6px; flex: none; }\n' +
      '.dsh-music-podcast-src { flex: 0 0 auto; position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; width: 64px; padding: 6px 4px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; }\n' +
      '.dsh-music-podcast-src:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); box-shadow: 0 2px 6px rgba(0,0,0,0.18); }\n' +
      // 选中态：不用深色底/描边，改用「被点击」的柔和阴影 + 一圈细绿描边（更轻盈）。
      '.dsh-music-podcast-src.active { background: transparent; border-color: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 0 0 1px var(--dsh-music-accent, #2f9e6e), 0 4px 12px rgba(0,0,0,0.32); }\n' +
      // 正在播放的源：封面右上角一个小「▶」徽标，代替原来的下划线描边。
      '.dsh-music-podcast-srcplay { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); font-size: 11px; line-height: 18px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4); pointer-events: none; }\n' +
      '.dsh-music-podcast-srcimg { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-podcast-srcimg.empty { display: flex; align-items: center; justify-content: center; font-size: 22px; }\n' +
      '.dsh-music-podcast-srcname { width: 100%; text-align: center; font-size: 11px; line-height: 1.2; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 聚合视图单集行的来源徽标（小封面 + 源名）。
      '.dsh-music-podcast-ep-src { width: 26px; height: 26px; border-radius: 6px; object-fit: cover; flex: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-podcast-ep-src.empty { display: flex; align-items: center; justify-content: center; font-size: 15px; }\n' +
      '.dsh-music-podcast-ep-srcname { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); margin-right: 6px; white-space: nowrap; }\n' +
      '.dsh-music-podcast-card { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); overflow: hidden; }\n' +
      '.dsh-music-podcast-head { display: flex; align-items: flex-start; gap: 10px; padding: 10px; }\n' +
      '.dsh-music-podcast-cover { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-podcast-cover.empty { display: flex; align-items: center; justify-content: center; font-size: 22px; }\n' +
      '.dsh-music-podcast-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-podcast-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-podcast-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\n' +
      '.dsh-music-podcast-count { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); }\n' +
      '.dsh-music-podcast-actions { flex: none; display: flex; gap: 6px; }\n' +
      '.dsh-music-podcast-episodes { display: flex; flex-direction: column; max-height: 45vh; overflow-y: auto; }\n' +
      '.dsh-music-podcast-body { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }\n' +
      '.dsh-music-podcast-pane { flex: 1; min-height: 0; overflow-y: auto; }\n' +
      '.dsh-music-config { display: flex; flex-direction: column; gap: 12px; }\n' +
      // 分组卡片：整体一个外框（无标题），卡片内行之间用细分隔线（不各自带边框）。
      '.dsh-music-config-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); overflow: hidden; }\n' +
      // 卡片内行：去掉独立边框/背景/圆角，只留上下内边距；相邻行之间画一条细分隔线。
      '.dsh-music-config-card .dsh-music-config-row { border: none; border-radius: 0; background: transparent; padding-top: 10px; padding-bottom: 10px; }\n' +
      '.dsh-music-config-card .dsh-music-config-row + .dsh-music-config-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }\n' +
      '.dsh-music-config-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); }\n' +
      '.dsh-music-config-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-config-label { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 600; }\n' +
      '.dsh-music-config-desc { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      // 开关：右侧胶囊。用固定强调色而非随主题反转的 brand-primary，
      // 让深/浅主题下都读作「绿色=开、灰=关」；旋钮恒白保证两种主题下对比清晰。
      '.dsh-music-toggle { position: relative; flex: none; width: 40px; height: 22px; padding: 0; border: none; border-radius: 22px; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); cursor: pointer; transition: background 0.15s; }\n' +
      '.dsh-music-toggle .dsh-music-toggle-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.35); transition: left 0.15s; }\n' +
      // 开启：固定绿色强调色（不随主题反转），旋钮右移。
      '.dsh-music-toggle.on { background: #2f9e6e; }\n' +
      '.dsh-music-toggle.on .dsh-music-toggle-knob { left: 20px; }\n' +
      // 沉浸感滑块行：右侧 range + 百分比数值。
      '.dsh-music-config-slider { flex: none; display: flex; align-items: center; gap: 8px; }\n' +
      '.dsh-music-config-range { width: 140px; accent-color: #2f9e6e; cursor: pointer; }\n' +
      // 歌词动效分段选择器：一组互斥小按钮，选中项用主题色描边+填充。
      '.dsh-music-config-seg { flex: none; display: flex; gap: 4px; }\n' +
      '.dsh-music-config-seg-btn { padding: 3px 9px; font-size: 11px; line-height: 1.5; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s; }\n' +
      '.dsh-music-config-seg-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      // 选中态与配置面板其它控件（开关/滑块）同款实心主色绿，保证同一面板内视觉统一。
      '.dsh-music-config-seg-btn.on { background: #2f9e6e; border-color: #2f9e6e; color: #fff; font-weight: 600; }\n' +
      '.dsh-music-config-val { min-width: 34px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-settings { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row { display: flex; gap: 8px; align-items: center; }\n' +
      '.dsh-music-settings-cur { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn { padding: 6px 12px; border-radius: 8px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 13px; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-settings-btn.danger { background: #c9352c; color: #fff; }\n' +
      '.dsh-music-picker-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; overflow: auto; padding: 16px; background: rgba(0,0,0,0.45); }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-width: 640px; max-height: 100%; margin: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; flex: none; }\n' +
      '.dsh-music-picker-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-picker-cur { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }\n' +
      '.dsh-music-picker-cur::-webkit-scrollbar { height: 4px; }\n' +
      '.dsh-music-picker-cur::-webkit-scrollbar-thumb { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); border-radius: 4px; }\n' +
      '.dsh-music-crumb { display: inline-block; padding: 1px 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; border-radius: 4px; }\n' +
      '.dsh-music-crumb:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-crumb.cur { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; cursor: default; }\n' +
      '.dsh-music-crumb-sep { margin: 0 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-crumb-plain { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 文件条目：仅作展示，不可点击（无 hover 高亮，光标为默认）。
      '.dsh-music-picker-item.file { color: var(--dsw-alias-label-secondary, #8a8f98); cursor: default; }\n' +
      // 上级目录项：加一条底部分隔线，视觉上跟下级目录区分开。
      '.dsh-music-picker-item.up { border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); font-weight: 600; }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; flex: none; }\n' +
      // 自定义输入弹窗（新建/重命名歌单）的输入框。
      '.dsh-music-prompt-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-prompt-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新建/重命名/删除/清空弹窗较窄，不用居中列表那种 640px 宽。
      '.dsh-music-picker.prompt, .dsh-music-picker.confirm { width: 300px; max-width: 90vw; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // ---- 在线 QQ 音乐 ----
      '.dsh-music-qq { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row.qq-account { gap: 6px; }\n' +
      '.dsh-music-qq-search { display: flex; gap: 8px; position: relative; }\n' +
      // 搜索输入框内部的「一键清除」×：包裹层相对定位，清除钮绝对定位在输入框右内侧，
      // 且始终渲染（空时 .hidden 仅隐藏、不改变布局），输入框宽度与 UI 位置恒定不抖。
      '.dsh-music-qq-inputwrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }\n' +
      '.dsh-music-qq-inputwrap .dsh-music-qq-input { flex: 1; padding-right: 26px; }\n' +
      '.dsh-music-qq-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; line-height: 16px; padding: 0; text-align: center; border-radius: 50%; border: none; background: transparent; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); cursor: pointer; font-size: 12px; visibility: visible; }\n' +
      '.dsh-music-qq-clear.hidden { visibility: hidden; }\n' +
      '.dsh-music-qq-clear:hover { color: #fff; background: rgba(128,128,128,0.3); }\n' +
      '.dsh-music-qq-hist { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; padding: 4px; max-height: 240px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-qq-hist-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; }\n' +
      '.dsh-music-qq-hist-clear { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }\n' +
      '.dsh-music-qq-hist-clear:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-hist-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-hist-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }\n' +
      '.dsh-music-online-tag { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; margin-left: 6px; }\n' +
      '.dsh-music-online-tag.vip { color: #e6a23c; border-color: #e6a23c; }\n' +
      '.dsh-music-online-tag.collect { color: #d9a441; border-color: #d9a441; }\n' +
      // QQ「我喜欢」等系统默认歌单的标签（主题色，区别于自建的灰色）。
      '.dsh-music-online-tag.default { color: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-picker.qq-login { max-width: 340px; }\n' +
      '.dsh-music-qq-login-body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 4px; }\n' +
      '.dsh-music-qq-qr { width: 280px; height: 280px; max-width: 70vw; image-rendering: pixelated; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; object-fit: contain; }\n' +
      '.dsh-music-qq-login-status { font-size: 14px; color: var(--dsw-alias-label-primary, #e6e6e6); text-align: center; }\n' +
      '.dsh-music-qq-login-actions { display: flex; gap: 8px; }\n' +
      '.dsh-music-qq-viewtabs { display: flex; gap: 6px; }\n' +
      '.dsh-music-qq-viewtab { flex: none; white-space: nowrap; padding: 5px 12px; border-radius: 8px; border: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-qq-viewtab.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab：与上方「我的歌单/推荐/分类/…」的
      // 填充式胶囊（viewtab）刻意区分——采用经典下划线式次级 tab（透明底 + 底部
      // 强调色指示条），一眼可辨这是「结果内二级切换」，而不是上层浏览入口。
      '.dsh-music-qq-resulttabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 4px 0 8px; }\n' +
      // 搜索框行与「歌曲/相关歌单」子tab行固定在滚动容器(.dsh-music-qq-body)之外，
      // 滚动条只作用于其下方的结果内容，搜索结果出现竖向滚动条时输入框所在行不再左右偏移。
      '.dsh-music-qq-searchrow { flex: none; }\n' +
      '.dsh-music-qq-resulttabs.fixed { margin: 0; }\n' +
      '.dsh-music-qq-resulttab { flex: none; white-space: nowrap; padding: 6px 14px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }\n' +
      '.dsh-music-qq-resulttab:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-resulttab.active { color: var(--dsh-music-accent, #2f9e6e); border-bottom-color: var(--dsh-music-accent, #2f9e6e); font-weight: 600; }\n' +
      '.dsh-music-qq-cats { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
      // 酷狗分类：一级与二级分类之间的分隔线（负 margin 会导致横向溢出出现滚动条，故用 0 边距）。
      '.dsh-music-cat-divider { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 10px 0 0; }\n' +
      '.dsh-music-qq-cat { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat.active { border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 分类折叠/展开切换按钮：小号、次要色、无边框。
      '.dsh-music-qq-cat-toggle { display: block; margin: 8px auto 0; padding: 3px 12px; border: none; background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat-toggle:hover { text-decoration: underline; }\n' +
      '.dsh-music-qq-topgroup { margin-bottom: 8px; }\n' +
      '.dsh-music-qq-topitem { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 7px 10px; margin: 3px 0; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; text-align: left; }\n' +
      '.dsh-music-qq-topitem:hover { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-topname { font-weight: 600; }\n' +
      '.dsh-music-qq-topmeta { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-qq-detail-head { display: flex; gap: 8px; align-items: center; margin: 6px 0; }\n' +
      '.dsh-music-qq { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }\n' +
      // QQ 面板所在 pane 不设 overflow:hidden（否则它自身会成为一个滚动容器，把
      // sticky 的 head 困在内部、无法吸附到真正滚动的 .dsh-music-list）。pane 保持
      // 普通流式布局，滚动交给 head 下方的 .dsh-music-list / .dsh-music-qq-body。
      '.dsh-music-qq-pane { flex: 1; min-height: 0; overflow: visible; display: flex; flex-direction: column; }\n' +
      // head 用 sticky 固定在滚动区顶部：无论实际滚动容器是 .dsh-music-list
      // 还是 .dsh-music-qq-body，返回按钮行 / 子tab 行都不会被列表滚走（内容在其下方滑动）。
      '.dsh-music-qq-head { flex: none; position: sticky; top: 0; z-index: 3; background: var(--dsw-alias-bg-overlay, #1e1f22); padding-bottom: 4px; }\n' +
      '.dsh-music-qq-body { flex: 1; overflow-y: auto; min-height: 0; }\n' +
      '.dsh-music-qq-section { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); margin: 10px 0 4px; font-weight: 600; }\n' +
      '.dsh-music-qq-now { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-now-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-now-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: 4px; }\n' +
      '.dsh-music-qq-now-src { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: auto; }\n' +
      '.dsh-music-qq-toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 12px; }\n' +
      '.dsh-music-qq-login { flex: 1; min-height: 200px; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-qq-login-center { display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 320px; }\n' +
      '.dsh-music-qq-login-dead { width: 100%; max-width: 300px; padding: 8px 10px; box-sizing: border-box; border: 1px solid var(--dsw-alias-state-error-border, rgba(216, 82, 80, 0.5)); border-radius: 6px; background: var(--dsw-alias-state-error-bg, rgba(216, 82, 80, 0.08)); color: var(--dsw-alias-state-error-primary, #d85250); font-size: 13px; line-height: 1.5; text-align: center; }\n' +
      '.dsh-music-qq-login-btn { width: 200px; padding: 10px 16px; font-size: 15px; }\n' +
      // 免责声明：居中块内的左对齐编号列表，阅读更清晰。
      '.dsh-music-qq-login-warn { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 300px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #d9a441); line-height: 1.5; text-align: left; box-sizing: border-box; max-height: 30vh; overflow-y: auto; }\n' +
      '.dsh-music-qq-login-warn-title { font-weight: 600; margin-bottom: 2px; }\n' +
      '.dsh-music-qq-login-warn-p { margin: 0; }\n' +
      '.dsh-music-qq-login-warn-item { display: flex; gap: 6px; align-items: flex-start; }\n' +
      '.dsh-music-qq-login-warn-num { flex: none; }\n' +
      // 讲书时章节名拼接在小说名后（复用 .dsh-music-bar-artist 样式），名称容器用默认
      // max-width:36%（与音乐「歌名 - 歌手」一致），不再单独给书名 24% 让空间。
      '.dsh-music-bar-src { margin-left: 6px; flex: 0 0 auto; white-space: nowrap; color: var(--dsh-music-accent, #2f9e6e); font-size: 11px; border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      '.dsh-music-bar-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; margin-left: 6px; }\n' +
      '.dsh-music-bar-artist-name { margin-left: 6px; }\n' +
      '.dsh-music-toc-trigger { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      // 章节目录弹层：与音量/播放模式弹窗同款定位观感——portal 到 body 后由
      // tocAnchorAbove 以内联 fixed + bottom 锚定（底边贴按钮上方 6px、高度限制在
      // 视口可用空间内）。这里仅保留结构样式与 CSS 兜底定位。
      '.dsh-music-toc { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); width: 380px; max-height: 60vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 60; box-sizing: border-box; }\n' +
      '.dsh-music-toc-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-toc-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-toc-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-toc-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-toc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-toc-item.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-heading { font-weight: 600; }\n' +
      '.dsh-music-toc-type { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-type { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-toc-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 自建歌单：音乐页子标签 / 歌单详情 / 文件多选 / 播放条收藏
      '.dsh-music-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }\n' +
      '.dsh-music-subtab { flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; border-radius: 16px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-subtab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-subtab.active { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-subtab.add { width: 30px; padding: 4px 0; text-align: center; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist { display: flex; flex-direction: column; flex: 1; }\n' +
      '.dsh-music-playlist-empty { flex: 1; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-playlist-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; }\n' +
      '.dsh-music-playlist-btn { flex: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 8px; }\n' +
      '.dsh-music-playlist-btn:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-missing { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-playlist-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-playlist-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-playlist-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini { flex: none; width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; }\n' +
      '.dsh-music-playlist-mini:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.del:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-file-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-file-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-file-item.checked { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-file-check { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }\n' +
      '.dsh-music-file-item.checked .dsh-music-file-check { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 曲库每行：track 按钮 + 行尾「＋」（加入歌单）
      '.dsh-music-track-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-track-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-track-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-track-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini.add { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-add-pop { position: fixed; z-index: 1200; min-width: 150px; max-width: 210px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-add-pop-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-add-pop-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop-item.new { color: var(--dsh-music-accent, #2f9e6e); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); margin-top: 2px; padding-top: 6px; }\n' +
      // 「加入歌单」成功/失败提示：面板窗口内绝对居中，颜色跟随 DSH 主题
      // （成功 = 主题强调色 --dsh-music-accent；失败 = 主题错误色），2s 自动消失。
      '.dsh-music-panel-toast { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 20; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--dsh-music-accent-fg, #fff); background: rgba(30,31,34,0.92); box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none; white-space: nowrap; max-width: 90%; text-align: center; animation: dsh-music-toast-in 0.18s ease; }\n' +
      '.dsh-music-panel-toast.ok { background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-toast.err { background: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '@keyframes dsh-music-toast-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }\n' +
      '.dsh-music-bar-btn.fav { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-btn.fav:hover { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-bar-btn.fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.fav.on:hover { color: var(--dsh-music-accent-fg, #fff); }\n';

    return module.exports;
  },
});
