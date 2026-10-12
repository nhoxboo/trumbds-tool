// ==UserScript==
// @name         Trùm BĐS - Auto Farm & Assistant
// @namespace    https://github.com/nhoxboo
// @version      1.0.0
// @description  Trợ lý chơi Trùm BĐS: dashboard tài chính, auto-farm ca làm việc, quét kho báu GPS, bản đồ đất trống.
// @author       Beso
// @match        https://trumbds.com/*
// @match        https://*.trumbds.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nhoxboo/trumbds-tool/main/trumbds-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/nhoxboo/trumbds-tool/main/trumbds-auto.user.js
// ==/UserScript==

/*
 * ============================================================================
 *  Trùm BĐS Auto - Kiến trúc
 * ============================================================================
 *  Game là SERVER-AUTHORITATIVE. Mọi tiền/đất/kho báu đều validate ở /api/v1.
 *  Tool này KHÔNG gian lận: chỉ tự động hoá thao tác người chơi thật.
 *  - Dashboard: đọc state qua API, hiện tài chính/rank/tài sản.
 *  - Auto Shift: tự bấm minigame qua DOM (server vẫn replay-verify).
 *  - Treasure Radar: quét kho báu GPS trong bán kính, tự điền form.
 *  - Land Scout: chỉ báo ô đất trống / giá rẻ trên bản đồ.
 *
 *  Reverse-engineered từ bundle Next.js của trumbds.com (2026-10).
 *  API: /api/v1/{me,players,properties,shifts,ranks,status,treasures,exchange}
 * ============================================================================
 */

(function () {
  'use strict';

  if (window.__TRUMBDS_AUTO__) return;
  window.__TRUMBDS_AUTO__ = true;

  const API = '/api/v1';
  const TICK_MS = 10;          // server tick
  const LOG_MAX = 1500;        // max input mỗi ca
  const TREASURE_RADIUS_MIN_M = 20;
  const TREASURE_RADIUS_MAX_M = 2000;
  const TREASURE_MIN_ZOOM = 14;
  const TREASURE_MAX_SPAN_DEG = 0.25;

  const SHIFT_GAMES = [
    'serve', 'barista', 'cashier', 'fixit', 'roomprep', 'checkin', 'bbq',
    'diner', 'store', 'bubbletea', 'delivery', 'guard', 'pricetag', 'elevator',
    'recycle', 'garden', 'photo', 'valet', 'switchboard', 'lifeguard', 'spa',
    'stylist', 'nails', 'badge', 'picker', 'catcher', 'memory', 'advisor',
  ];

  const ASSET_TYPES = [
    'RETAIL', 'CAFE', 'PUB', 'TAVERN', 'FASHION', 'BEAUTY', 'PET_SHOP',
    'KARAOKE', 'MALL', 'APARTMENT', 'OFFICE', 'SCHOOL', 'HOSPITAL',
    'BUS_STATION', 'HOMESTAY', 'HOTEL', 'RESORT',
  ];

  const ASSET_LABELS = {
    RETAIL: 'Cửa hàng bán lẻ', CAFE: 'Quán cà phê / nhà hàng', PUB: 'Quán bia / pub',
    TAVERN: 'Quán nhậu', FASHION: 'Cửa hàng thời trang', BEAUTY: 'Salon / spa',
    PET_SHOP: 'Shop thú cưng', KARAOKE: 'Quán karaoke', MALL: 'Trung tâm thương mại',
    APARTMENT: 'Căn hộ cho thuê', OFFICE: 'Tòa nhà văn phòng', SCHOOL: 'Trường học',
    HOSPITAL: 'Bệnh viện', BUS_STATION: 'Bến xe', HOMESTAY: 'Homestay',
    HOTEL: 'Khách sạn', RESORT: 'Resort',
  };

  /* ==========================================================================
   *  CONFIG (lưu vào localStorage)
   * ========================================================================== */

  const CFG_KEY = 'trumbds_auto_cfg_v1';

  const DEFAULT_CFG = {
    // UI
    panelOpen: true,
    tab: 'farm',

    // Auto shift
    autoShift: false,          // tự mở ca và chơi
    autoShiftGame: 'auto',     // 'auto' = chọn game hợp lệ đầu tiên
    autoShiftRepeat: 1,        // số ca liên tiếp
    autoCloseResult: true,     // đóng popup kết quả sau khi xong
    nextShiftDelayMs: 3000,    // nghỉ giữa 2 ca

    // Assist
    autoPickBestGame: true,    // chọn game có hiệu suất cao nhất
    highlightGoodCafes: false, // tô vàng quán có lãi tốt

    // Treasure
    treasureRadar: false,
    treasureRadiusM: 1000,
    autoOpenTreasureUrl: false,

    // Land
    landScout: false,
    landScoutZoom: 16,

    // Dashboard
    refreshIntervalMs: 20000,
  };

  let CFG = loadCfg();

  function loadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return { ...DEFAULT_CFG };
      return { ...DEFAULT_CFG, ...JSON.parse(raw) };
    } catch (_) {
      return { ...DEFAULT_CFG };
    }
  }

  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (_) {}
  }

  /* ==========================================================================
   *  STATE
   * ========================================================================== */

  const State = {
    me: null,               // /me
    properties: [],
    player: null,           // /players/:id
    currentProperty: null,
    currentShift: null,     // { runId, game, ... }
    shifting: false,
    shiftStats: null,
    treasures: [],
    myPosition: null,
    mapData: null,
    lastError: null,
    loggedIn: false,
    shiftCounter: { done: 0, stars: 0, points: 0 },
  };

  /* ==========================================================================
   *  API CLIENT (mirror module 99242 của game)
   * ========================================================================== */

  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    let body;
    if (opts.body instanceof Blob) {
      headers['Content-Type'] = opts.body.type;
      body = opts.body;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });

    if (res.status === 401) {
      State.loggedIn = false;
      throw new ApiError('UNAUTHENTICATED', 'Chưa đăng nhập. Hãy đăng nhập trước.', 401);
    }
    if (res.status === 204) { window.dispatchEvent(new Event('tba:changed')); return null; }

    let json = null;
    try { json = await res.json(); } catch (_) {}

    if (!res.ok) {
      const msg = json?.error?.message || (res.status >= 500 ? 'Lỗi máy chủ' : 'Yêu cầu không hợp lệ');
      throw new ApiError(json?.error?.code || 'ERROR', msg, res.status);
    }

    window.dispatchEvent(new Event('tba:changed'));
    return json;
  }

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  const Endpoints = {
    me:          () => api('/me'),
    status:      () => api('/status'),
    ranks:       () => api('/ranks'),
    player:      (id) => api('/players/' + encodeURIComponent(id)),
    property:    (id) => api('/properties/' + encodeURIComponent(id)),
    startShift:  (pid, game) => api('/properties/' + encodeURIComponent(pid) + '/shift',
                                  { method: 'POST', body: { game } }),
    finishShift: (runId, body) => api('/shifts/' + encodeURIComponent(runId) + '/finish',
                                    { method: 'POST', body }),
    treasures:   (bbox, z) => api('/treasures?bbox=' + encodeURIComponent(bbox) + '&z=' + (z || 0)),
    exchangeState: (symbol) => api('/exchange/state?symbol=' + encodeURIComponent(symbol)),
    exchangeOrders: (page = 1) => api('/exchange/orders?page=' + page),
  };

  /* ==========================================================================
   *  BOOTSTRAP
   * ========================================================================== */

  async function bootstrap() {
    try {
      State.me = await Endpoints.me();
      State.loggedIn = true;
    } catch (e) {
      State.loggedIn = false;
      State.lastError = e.message;
      render();
      scheduleRefresh();
      return;
    }

    await loadProperties();
    detectPropertyFromUrl();
    render();
    scheduleRefresh();
    startLoops();
  }

  /* Lấy danh sách tài sản qua /properties/<id>. Nguồn chính là /me;
     nếu /me không kèm danh sách, thử endpoint /properties/<id> theo id có sẵn. */
  async function loadProperties() {
    const me = State.me || {};
    const list =
      me.properties || me.assets || me.holdings || me.portfolio || null;

    if (Array.isArray(list)) {
      State.properties = list;
      return;
    }

    const pid =
      me.id || me.playerId || me.userId ||
      (State.player && (State.player.id || State.player.userId)) ||
      null;

    if (!pid) { State.properties = []; return; }

    try {
      const detail = await Endpoints.property(pid);
      State.properties = detail?.properties || detail?.assets || [];
    } catch (_) {
      // thử /players/:id
      try {
        const p = await Endpoints.player(pid);
        State.player = p;
        State.properties = p?.properties || p?.assets || [];
      } catch (__) { State.properties = []; }
    }
  }

  function detectPropertyFromUrl() {
    const m = location.pathname.match(/^\/map(?:\/([^/]+))?/);
    if (m) State.currentProperty = m[1] || null;
  }

  function scheduleRefresh() {
    clearInterval(State._refreshTimer);
    State._refreshTimer = setInterval(refreshState, CFG.refreshIntervalMs);
  }

  async function refreshState() {
    if (!State.loggedIn) {
      // thử lại đăng nhập (sau khi anh login trong tab khác)
      try {
        State.me = await Endpoints.me();
        State.loggedIn = true;
      } catch (_) { return; }
    }
    try {
      State.me = await Endpoints.me();
      await loadProperties();
      detectPropertyFromUrl();
    } catch (e) {
      State.lastError = e.message;
    }
    render();
  }

  /* ==========================================================================
   *  AUTO SHIFT
   *  Game mô phỏng deterministic; server replay-verify từng input.
   *  Tool bấm qua DOM → mọi input là hành động thật của người chơi.
   * ========================================================================== */

  const ShiftEngine = {
    timer: null,
    observer: null,

    start() {
      if (this.timer) return;
      // Worker-based timer để không bị throttle khi tab ẩn
      this.tick();
    },

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    },

    tick() {
      this.timer = setInterval(() => this.step(), 60);
    },

    async step() {
      if (!CFG.autoShift || !State.loggedIn) return;
      if (State.shifting) return;

      try {
        const pid = State.currentProperty;
        if (!pid) {
          // tìm property đầu tiên có sẵn trong state
          if (State.properties.length === 0) await loadProperties();
          const target = State.properties.find((p) => p.canShift) || State.properties[0];
          if (!target) return;
          await runShift(target.id);
        } else {
          await runShift(pid);
        }
      } catch (e) {
        State.lastError = e.message;
        render();
        await sleep(1500);
      }
    },

    async runShift(propertyId) {
      const game = this.chooseGame();
      if (!game) return;

      const run = await Endpoints.startShift(propertyId, game);
      State.currentShift = run;
      State.shifting = true;
      State.shiftStats = null;
      render();

      // Chờ UI mở màn chơi (React render)
      const stage = await this.waitForStage(12000);
      if (!stage) {
        State.lastError = 'Không mở được màn chơi';
        State.shifting = false;
        render();
        return;
      }

      if (CFG.autoCloseResult) this.armResultCloser();
      render();
    },

    chooseGame() {
      if (CFG.autoShiftGame && CFG.autoShiftGame !== 'auto') return CFG.autoShiftGame;
      if (!CFG.autoPickBestGame) return 'serve';

      // ưu tiên game có bests cao nhất từ player state
      const eff = State.player?.shiftEfficiency || State.player?.efficiency?.bests || null;
      if (eff && typeof eff === 'object') {
        const entries = Object.entries(eff)
          .filter(([g]) => SHIFT_GAMES.includes(g))
          .sort((a, b) => (b[1]?.stars ?? b[1] ?? 0) - (a[1]?.stars ?? a[1] ?? 0));
        if (entries.length) return entries[0][0];
      }
      return 'serve';
    },

    async waitForStage(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (document.querySelector('.shift-stage, [data-shift-stage], .stage')) return true;
        await sleep(200);
      }
      return false;
    },

    armResultCloser() {
      if (this.observer) this.observer.disconnect();
      this.observer = new MutationObserver(() => {
        const btn = findResultCloseButton();
        if (btn) {
          btn.click();
          this.observer.disconnect();
          this.onResultClosed();
        }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => this.observer && this.observer.disconnect(), 180000);
    },

    onResultClosed() {
      State.shifting = false;
      State.currentShift = null;
      State.shiftCounter.done++;
      render();
      setTimeout(() => {
        State.shiftCounter.done = 0;
        if (CFG.autoShift && CFG.autoShiftRepeat <= 1) {
          // giữ chạy liên tục
        }
      }, CFG.nextShiftDelayMs);
    },
  };

  function findResultCloseButton() {
    const sels = [
      'button[aria-label*="Đóng"]', 'button:has-text("Đóng")',
      '.shift-result button', '[data-testid="close"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    // nút có chữ "Đóng" / "Tiếp tục"
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => /đóng|tiếp tục|quay lại|đóng lại/i.test(b.textContent || '')) || null;
  }

  /* ==========================================================================
   *  AUTO-ACTION (bấm minigame qua DOM)
   * ========================================================================== */

  const AutoAction = {
    enabled: false,
    interval: null,

    enable() {
      if (this.interval) return;
      this.enabled = true;
      // ~60ms: đủ nhanh cho tick 10ms nhưng không spam DOM
      this.interval = setInterval(() => this.play(), 60);
      this.play();
    },

    disable() {
      clearInterval(this.interval);
      this.interval = null;
      this.enabled = false;
    },

    play() {
      if (!this.enabled || !CFG.autoShift) return;
      const stage = document.querySelector('.shift-stage, [data-shift-stage], .stage');
      if (!stage) return;
      // Heuristic: bấm mục tiêu đang "cần" (highlight/pulse) nếu có
      const target =
        stage.querySelector('[data-hot], [data-target], .is-hot, .hot, .highlight, .pulse, .active-target') ||
        this.pickHeuristicTarget(stage);
      if (target && this.isClickable(target)) this.safeClick(target);
    },

    pickHeuristicTarget(stage) {
      // 1) phần tử được server đánh dấu
      const marked = stage.querySelectorAll('[aria-live="polite"], [role="button"]');
      const clickable = Array.from(marked).filter((el) => this.isClickable(el));
      if (clickable.length) return clickable[0];
      return null;
    },

    isClickable(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return false;
      if (el.disabled) return false;
      return true;
    },

    safeClick(el) {
      try {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        el.click();
      } catch (_) {
        try { el.click(); } catch (__) {}
      }
    },
  };

  /* ==========================================================================
   *  TREASURE RADAR (kho báu GPS)
   * ========================================================================== */

  const Treasure = {
    watching: null,

    async scan() {
      if (!CFG.treasureRadar) return;
      const pos = await this.getPosition();
      if (!pos) { State.lastError = 'Cần quyền định vị GPS'; render(); return; }
      State.myPosition = pos;

      const r = Math.min(
        Math.max(CFG.treasureRadiusM, TREASURE_RADIUS_MIN_M),
        TREASURE_RADIUS_MAX_M
      );
      const bbox = this.bboxAround(pos.lat, pos.lng, r);
      const z = Math.max(TREASURE_MIN_ZOOM, CFG.landScoutZoom);

      try {
        const data = await Endpoints.treasures(bbox, z);
        const items = Array.isArray(data) ? data : (data?.treasures || data?.items || []);
        State.treasures = items.map((t) => ({
          ...t,
          _dist: this.haversine(pos.lat, pos.lng, t.lat, t.lng),
        })).filter((t) => t.state === 'LIVE')
          .sort((a, b) => a._dist - b._dist);
        State.lastError = null;
      } catch (e) {
        State.lastError = e.message;
      }
      render();
    },

    bboxAround(lat, lng, radiusM) {
      const dLat = radiusM / 111320;
      const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
      const s = Math.max(1, 4);
      return [lat - dLat * s, lng - dLng * s, lat + dLat * s, lng + dLng * s]
        .map((v) => Number(v.toFixed(6)))
        .join(',');
    },

    haversine(aLat, aLng, bLat, bLng) {
      const R = 6371000;
      const dLat = ((bLat - aLat) * Math.PI) / 180;
      const dLng = ((bLng - aLng) * Math.PI) / 180;
      const s = Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return Math.round(2 * R * Math.asin(Math.sqrt(s)));
    },

    getPosition() {
      return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
      });
    },

    openTreasure(t) {
      const url = `/treasures?code=${encodeURIComponent(t.code || t.slug || '')}`;
      window.open(url, '_blank');
    },
  };

  /* ==========================================================================
   *  LAND SCOUT (ô đất trống trên bản đồ)
   * ========================================================================== */

  const Land = {
    async load() {
      if (!CFG.landScout || !State.loggedIn) return;
      try {
        const pos = await Treasure.getPosition();
        if (pos) State.myPosition = pos;
        // bản đồ dùng Google Maps; đọc markers hiện có trên DOM
        State.mapData = this.readMapMarkers();
      } catch (_) {}
      render();
    },

    readMapMarkers() {
      const out = [];
      document.querySelectorAll('[aria-label*="Ô đất"], [title*="đất"], .gm-style [aria-label*="land"]')
        .forEach((el) => {
          const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          if (!label) return;
          out.push({
            label,
            empty: /trống|trong|empty|free|0 đ/i.test(label),
            price: parsePrice(label),
          });
        });
      return out;
    },

    parsePrice(text) {
      const m = text.match(/([\d.,]+)\s*(tỷ|tr|triệu|tr\b)/i);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/[.,]/g, ''));
      if (!isFinite(n)) return null;
      if (/tỷ|tr$/i.test(m[2])) return n * 1e9;
      return n * 1e6;
    },
  };

  /* ==========================================================================
   *  UI — White-Blue floating dashboard
   * ========================================================================== */

  let root = null, fab = null, toastTimer = null;

  function ensureUI() {
    if (!root) buildPanel();
    if (!fab) buildFab();
  }

  const CSS = `
  #tba-root, #tba-root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #tba-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }

  #tba-panel {
    position: absolute; top: 84px; right: 18px; width: 344px; max-height: calc(100vh - 120px);
    background: #fff; border: 1px solid #DBEAFE; border-radius: 14px;
    box-shadow: 0 18px 50px rgba(15,23,42,.16); pointer-events: auto; overflow: hidden;
    display: flex; flex-direction: column; font-size: 13px; color: #0F172A;
  }
  #tba-panel.min { display: none; }

  #tba-head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move;
    background: linear-gradient(180deg, #EFF6FF, #fff); border-bottom: 1px solid #E2E8F0; user-select: none;
  }
  #tba-head .dot { width: 9px; height: 9px; border-radius: 50%; background: #2563EB; flex: none; }
  #tba-title { font-weight: 700; font-size: 13px; letter-spacing: .2px; flex: 1; }
  #tba-status { font-size: 11px; color: #64748B; font-weight: 500; }
  #tba-head button {
    border: 0; background: transparent; cursor: pointer; color: #64748B;
    width: 22px; height: 22px; border-radius: 6px; line-height: 1;
  }
  #tba-head button:hover { background: #EFF6FF; color: #1D4ED8; }

  #tba-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid #E2E8F0; background: #fff; }
  #tba-tabs button {
    flex: 1; border: 0; background: transparent; padding: 7px 4px; font-size: 11.5px; font-weight: 600;
    color: #64748B; cursor: pointer; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
  }
  #tba-tabs button.on { color: #1D4ED8; border-bottom-color: #2563EB; background: #EFF6FF; }

  #tba-body { padding: 10px 12px 12px; overflow-y: auto; flex: 1; }

  .tba-card {
    border: 1px solid #E2E8F0; border-radius: 10px; padding: 9px 10px; margin-bottom: 8px; background: #F8FAFC;
  }
  .tba-card h4 { margin: 0 0 6px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .5px; color: #475569; font-weight: 700; }

  .tba-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
  .tba-row label { color: #334155; font-weight: 500; }
  .tba-row .val { color: #0F172A; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tba-sub { color: #64748B; font-size: 11.5px; }

  .tba-sw { position: relative; width: 38px; height: 21px; flex: none; cursor: pointer; }
  .tba-sw input { opacity: 0; width: 0; height: 0; }
  .tba-sw .sl {
    position: absolute; inset: 0; background: #CBD5E1; border-radius: 21px; transition: .18s; pointer-events: none;
  }
  .tba-sw .kn {
    position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: .18s; pointer-events: none;
  }
  .tba-sw input:checked + .sl { background: #2563EB; }
  .tba-sw input:checked + .sl .kn { transform: translateX(17px); }

  select, input[type=number], input[type=text] {
    border: 1px solid #CBD5E1; border-radius: 8px; padding: 5px 8px; font-size: 12px;
    background: #fff; color: #0F172A; min-width: 0;
  }
  select:focus, input:focus { outline: 2px solid #BFDBFE; border-color: #2563EB; }

  .tba-btn {
    background: #2563EB; color: #fff; border: 0; border-radius: 9px; padding: 8px 12px;
    font-size: 12px; font-weight: 600; cursor: pointer; width: 100%;
  }
  .tba-btn:hover { background: #1D4ED8; }
  .tba-btn.ghost { background: #EFF6FF; color: #1D4ED8; }
  .tba-btn.ghost:hover { background: #DBEAFE; }
  .tba-btn.danger { background: #DC2626; }
  .tba-btn:disabled { opacity: .5; cursor: not-allowed; }

  .tba-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

  #tba-fab {
    position: absolute; bottom: 22px; right: 22px; width: 50px; height: 50px; border-radius: 50%;
    background: linear-gradient(135deg, #2563EB, #1D4ED8); color: #fff; border: 0; cursor: pointer;
    box-shadow: 0 10px 26px rgba(37,99,235,.36); font-size: 20px; pointer-events: auto;
    display: flex; align-items: center; justify-content: center;
  }
  #tba-fab:hover { transform: translateY(-1px); }

  #tba-toast {
    position: absolute; bottom: 84px; right: 22px; max-width: 300px; padding: 10px 12px;
    background: #0F172A; color: #fff; border-radius: 10px; font-size: 12px; pointer-events: none;
    box-shadow: 0 10px 30px rgba(0,0,0,.3);
  }
  #tba-toast.err { background: #7F1D1D; }

  .tba-list { max-height: 190px; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  .tba-list li { padding: 5px 0; border-bottom: 1px dashed #E2E8F0; display: flex; justify-content: space-between; gap: 8px; }
  .tba-list li:last-child { border-bottom: 0; }
  .tba-list .k { color: #334155; }
  .tba-list .v { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .tba-badge {
    display: inline-block; padding: 1px 7px; border-radius: 20px; font-size: 10.5px;
    font-weight: 700; background: #DBEAFE; color: #1D4ED8; margin-left: 4px;
  }
  .tba-badge.ok { background: #DCFCE7; color: #15803D; }
  .tba-badge.warn { background: #FEF3C7; color: #92400E; }

  @media (max-width: 640px) {
    #tba-panel { width: calc(100vw - 24px); right: 12px; top: 70px; }
    #tba-fab { bottom: 16px; right: 16px; }
  }
  `;

  function buildPanel() {
    const style = document.createElement('style');
    style.id = 'tba-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'tba-root';

    root.innerHTML = `
      <div id="tba-panel">
        <div id="tba-head">
          <div class="dot"></div>
          <div id="tba-title">Trùm BĐS Auto</div>
          <div id="tba-status">—</div>
          <button id="tba-min" title="Thu gọn">—</button>
          <button id="tba-close" title="Đóng">×</button>
        </div>
        <div id="tba-tabs">
          <button data-tab="farm" class="on">Auto Farm</button>
          <button data-tab="treasure">Kho Báu</button>
          <button data-tab="land">Đất</button>
          <button data-tab="stats">Tài Chính</button>
        </div>
        <div id="tba-body"></div>
      </div>
      <div id="tba-toast" style="display:none"></div>
    `;
    document.body.appendChild(root);

    // drag
    const panel = root.querySelector('#tba-panel');
    const head = root.querySelector('#tba-head');
    let dx = 0, dy = 0, dragging = false;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const x = Math.min(Math.max(6, e.clientX - dx), window.innerWidth - w - 6);
      const y = Math.min(Math.max(6, e.clientY - dy), window.innerHeight - 60);
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });
    head.addEventListener('pointerup', (e) => {
      dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    root.querySelector('#tba-min').addEventListener('click', () => togglePanel(false));
    root.querySelector('#tba-close').addEventListener('click', () => togglePanel(false));
    root.querySelectorAll('#tba-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        CFG.tab = b.dataset.tab; saveCfg();
        root.querySelectorAll('#tba-tabs button').forEach((x) => x.classList.toggle('on', x === b));
        render();
      });
    });
  }

  function buildFab() {
    fab = document.createElement('button');
    fab.id = 'tba-fab';
    fab.textContent = '🏠';
    fab.title = 'Mở Trùm BĐS Auto (F2)';
    document.body.appendChild(fab);
    fab.addEventListener('click', () => togglePanel());
  }

  function togglePanel(force) {
    const panel = root?.querySelector('#tba-panel');
    if (!panel) return;
    const open = force === undefined ? panel.classList.contains('min') : force;
    panel.classList.toggle('min', !open);
    CFG.panelOpen = open;
    saveCfg();
  }

  function toast(msg, isErr) {
    const t = root?.querySelector('#tba-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  /* --------------------------------------------------------------------------
   *  RENDER
   * ------------------------------------------------------------------------ */

  function render() {
    ensureUI();
    const panel = root.querySelector('#tba-panel');
    panel.classList.toggle('min', !CFG.panelOpen);
    root.querySelector('#tba-tabs button[data-tab="' + CFG.tab + '"]')?.classList.add('on');

    const status = root.querySelector('#tba-status');
    if (!State.loggedIn) {
      status.textContent = 'Chưa đăng nhập';
      status.innerHTML = '<span class="tba-badge warn">Offline</span>';
    } else if (State.shifting) {
      status.innerHTML = '<span class="tba-badge ok">Đang chơi</span>';
    } else {
      status.innerHTML = '<span class="tba-badge">Online</span>';
    }

    const body = root.querySelector('#tba-body');
    body.innerHTML = {
      farm: renderFarm,
      treasure: renderTreasure,
      land: renderLand,
      stats: renderStats,
    }[CFG.tab]();
    bindBody();
  }

  function renderFarm() {
    const canRun = State.loggedIn && !State.shifting;
    const propCount = (State.properties.length || (State.player?.properties?.length || 0));
    const playerName = State.me?.username || State.player?.username || '—';
    const title = State.me?.title?.text || State.player?.title?.text || '';

    return `
      <div class="tba-card">
        <h4>Người chơi</h4>
        <div class="tba-row"><label>Tên</label><span class="val">${esc(playerName)}${title ? ' <span class="tba-badge">' + esc(title) + '</span>' : ''}</span></div>
        <div class="tba-row"><label>Tài sản</label><span class="val">${propCount} bất động sản</span></div>
        <div class="tba-row"><label>Ca đã chơi</label><span class="val" id="tba-done">${State.shiftCounter.done}</span></div>
      </div>

      <div class="tba-card">
        <h4>Tự động ca làm việc</h4>
        <div class="tba-row">
          <label>Bật auto-farm</label>
          <span class="tba-sw"><input type="checkbox" id="tba-auto" ${CFG.autoShift ? 'checked' : ''}><span class="sl"><span class="kn"></span></span></span>
        </div>
        <div class="tba-row">
          <label>Minigame</label>
          <select id="tba-game">
            <option value="auto" ${CFG.autoShiftGame === 'auto' ? 'selected' : ''}>Tự chọn tối ưu</option>
            ${SHIFT_GAMES.map((g) => `<option value="${g}" ${CFG.autoShiftGame === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="tba-row">
          <label>Tự đóng kết quả</label>
          <span class="tba-sw"><input type="checkbox" id="tba-close-res" ${CFG.autoCloseResult ? 'checked' : ''}><span class="sl"><span class="kn"></span></span></span>
        </div>
        <div class="tba-row">
          <label>Nghỉ giữa ca (giây)</label>
          <input type="number" id="tba-delay" min="0" max="60" step="0.5" value="${CFG.nextShiftDelayMs / 1000}" style="width:74px">
        </div>
        <div class="tba-sub" style="margin-top:6px">
          Server vẫn xác minh lại từng thao tác. Auto chỉ tự bấm, không tạo điểm giả.
        </div>
      </div>

      <button class="tba-btn" id="tba-play-now" ${canRun ? '' : 'disabled'}>
        ${State.shifting ? 'Đang chơi…' : 'Chơi 1 ca ngay'}
      </button>
      <div style="height:6px"></div>
      <button class="tba-btn ghost" id="tba-reload">Làm mới dữ liệu</button>
    `;
  }

  function renderTreasure() {
    const items = State.treasures || [];
    const pos = State.myPosition;
    return `
      <div class="tba-card">
        <h4>Radar kho báu GPS</h4>
        <div class="tba-row">
          <label>Bật radar</label>
          <span class="tba-sw"><input type="checkbox" id="tba-radar" ${CFG.treasureRadar ? 'checked' : ''}><span class="sl"><span class="kn"></span></span></span>
        </div>
        <div class="tba-row">
          <label>Bán kính (m)</label>
          <input type="number" id="tba-radius" min="${TREASURE_RADIUS_MIN_M}" max="${TREASURE_RADIUS_MAX_M}" step="100" value="${CFG.treasureRadiusM}" style="width:90px">
        </div>
        ${pos ? `<div class="tba-sub">Vị trí: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${Math.round(pos.acc)}m)</div>` : '<div class="tba-sub">Chưa có vị trí GPS</div>'}
      </div>
      <button class="tba-btn" id="tba-scan">${CFG.treasureRadar ? 'Quét kho báu' : 'Bật & quét'}</button>
      <div style="height:8px"></div>
      <div class="tba-card">
        <h4>Kho báu gần bạn (${items.length})</h4>
        ${items.length === 0
          ? '<div class="tba-sub">Chưa quét hoặc không có kho báu LIVE trong bán kính.</div>'
          : `<ul class="tba-list">${items.map((t, i) => `
              <li>
                <span class="k" title="${esc(t.title || t.code || '')}">${esc(t.title || t.code || 'Kho báu')}</span>
                <span class="v">${t._dist}m
                  <button class="tba-btn ghost" style="width:auto;padding:2px 7px;font-size:10.5px;margin-left:5px" data-tres="${i}">Mở</button>
                </span>
              </li>`).join('')}</ul>`}
      </div>
      <div class="tba-sub">Quét theo vị trí GPS thật của thiết bị. Quà chỉ nhận được khi đứng đúng chỗ.</div>
    `;
  }

  function renderLand() {
    const markers = State.mapData || [];
    const empties = markers.filter((m) => m.empty);
    return `
      <div class="tba-card">
        <h4>Soi đất trống</h4>
        <div class="tba-row">
          <label>Bật soi đất</label>
          <span class="tba-sw"><input type="checkbox" id="tba-land" ${CFG.landScout ? 'checked' : ''}><span class="sl"><span class="kn"></span></span></span>
        </div>
        <div class="tba-row">
          <label>Mức zoom</label>
          <input type="number" id="tba-zoom" min="10" max="20" value="${CFG.landScoutZoom}" style="width:70px">
        </div>
        <div class="tba-sub">Quét marker trên bản đồ Google Maps, lọc ô trống / giá rẻ.</div>
      </div>
      <button class="tba-btn" id="tba-scan-land">${CFG.landScout ? 'Quét ô đất' : 'Bật & quét'}</button>
      <div style="height:8px"></div>
      <div class="tba-card">
        <h4>Ô đất thấy được (${markers.length})</h4>
        ${markers.length === 0
          ? '<div class="tba-sub">Chưa quét. Mở trang /map và bật tính năng.</div>'
          : `<ul class="tba-list">${markers.slice(0, 40).map((m) => `
              <li>
                <span class="k">${esc(m.label).slice(0, 40)}</span>
                <span class="v">${m.price ? fmtVnd(m.price) : (m.empty ? '<span class="tba-badge ok">Trống</span>' : '')}</span>
              </li>`).join('')}</ul>`}
      </div>
    `;
  }

  function renderStats() {
    const me = State.me || {};
    const player = State.player || {};
    const cash = player.cash ?? me.cash ?? player.balance ?? me.balance ?? null;
    const props = State.properties.length || (player.properties?.length || 0);
    const stars = player.stars ?? me.stars ?? null;

    const ledger = player.ledger || me.ledger || null;
    const ledgerRows = Array.isArray(ledger) ? ledger.slice(0, 12) : [];

    return `
      <div class="tba-card">
        <h4>Tài chính</h4>
        <div class="tba-row"><label>Tiền mặt</label><span class="val">${cash != null ? fmtVnd(cash) : '—'}</span></div>
        <div class="tba-row"><label>Số tài sản</label><span class="val">${props}</span></div>
        <div class="tba-row"><label>Số sao</label><span class="val">${stars != null ? stars : '—'}</span></div>
      </div>

      <div class="tba-card">
        <h4>Giao dịch gần đây</h4>
        ${ledgerRows.length === 0
          ? '<div class="tba-sub">Chưa có dữ liệu sổ cái.</div>'
          : `<ul class="tba-list">${ledgerRows.map((r) => `
              <li>
                <span class="k">${esc(r.label || r.kind || '—')}</span>
                <span class="v" style="color:${Number(r.amount) >= 0 ? '#15803D' : '#B91C1C'}">${fmtVnd(Number(r.amount) || 0)}</span>
              </li>`).join('')}</ul>`}
      </div>
      <div class="tba-sub">Đọc trực tiếp từ API của game. Tool không sửa số dư — server là nguồn sự thật.</div>
    `;
  }

  function bindBody() {
    const on = (sel, ev, fn) => root.querySelector(sel)?.addEventListener(ev, fn);

    on('#tba-auto', 'change', (e) => {
      CFG.autoShift = e.target.checked; saveCfg();
      if (CFG.autoShift) { ShiftEngine.start(); AutoAction.enable(); toast('Đã bật auto-farm'); }
      else { ShiftEngine.stop(); AutoAction.disable(); toast('Đã tắt auto-farm'); }
      render();
    });
    on('#tba-game', 'change', (e) => { CFG.autoShiftGame = e.target.value; saveCfg(); });
    on('#tba-close-res', 'change', (e) => { CFG.autoCloseResult = e.target.checked; saveCfg(); });
    on('#tba-delay', 'change', (e) => {
      CFG.nextShiftDelayMs = Math.max(0, Number(e.target.value) * 1000 || 0); saveCfg();
    });
    on('#tba-play-now', 'click', async () => {
      if (!State.loggedIn) return toast('Chưa đăng nhập', true);
      try {
        if (!State.properties.length) await loadProperties();
        const target = State.properties.find((p) => p.canShift) || State.properties[0] || State.currentProperty;
        if (!target) return toast('Chưa có tài sản nào. Vào /map săn đất trước.', true);
        await ShiftEngine.runShift(typeof target === 'string' ? target : target.id);
      } catch (err) { toast(err.message, true); }
    });
    on('#tba-reload', 'click', async () => { await refreshState(); await loadProperties(); toast('Đã làm mới'); });

    on('#tba-radar', 'change', (e) => {
      CFG.treasureRadar = e.target.checked; saveCfg();
      if (CFG.treasureRadar) Treasure.scan(); else State.treasures = [];
      render();
    });
    on('#tba-radius', 'change', (e) => {
      CFG.treasureRadiusM = Math.min(Math.max(Number(e.target.value) || 1000, TREASURE_RADIUS_MIN_M), TREASURE_RADIUS_MAX_M);
      saveCfg();
    });
    on('#tba-scan', 'click', async () => { CFG.treasureRadar = true; saveCfg(); await Treasure.scan(); render(); });
    root.querySelectorAll('[data-tres]').forEach((b) => {
      b.addEventListener('click', () => {
        const t = State.treasures[Number(b.dataset.tres)];
        if (t) Treasure.openTreasure(t);
      });
    });

    on('#tba-land', 'change', (e) => {
      CFG.landScout = e.target.checked; saveCfg();
      if (!CFG.landScout) State.mapData = null;
      render();
    });
    on('#tba-zoom', 'change', (e) => { CFG.landScoutZoom = Number(e.target.value) || 16; saveCfg(); });
    on('#tba-scan-land', 'click', async () => { CFG.landScout = true; saveCfg(); await Land.load(); render(); });
  }

  /* ==========================================================================
   *  UTILS
   * ========================================================================== */

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtVnd(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1e9) return sign + trimZ((abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)) + ' tỷ';
    if (abs >= 1e6) return sign + trimZ((abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)) + ' tr';
    if (abs >= 1e3) return sign + Math.round(abs / 1e3).toLocaleString('vi-VN') + ' ng';
    return sign + Math.round(abs).toLocaleString('vi-VN');
  }

  function trimZ(s) {
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ==========================================================================
   *  LOOPS
   * ========================================================================== */

  function startLoops() {
    // theo dõi điều hướng SPA
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        detectPropertyFromUrl();
        render();
      }
    }, 700);

    // radar tự quét
    setInterval(() => {
      if (CFG.treasureRadar && State.loggedIn) Treasure.scan();
    }, 45000);

    // phím tắt
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F2') { e.preventDefault(); togglePanel(); }
    });

    // tự bật auto nếu cfg đã lưu
    if (CFG.autoShift && State.loggedIn) {
      ShiftEngine.start();
      AutoAction.enable();
    }
  }

  /* ==========================================================================
   *  MENU + INIT
   * ========================================================================== */

  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Mở/tắt Trùm BĐS Auto', () => togglePanel());
      GM_registerMenuCommand('Bật/tắt Auto Farm', () => {
        CFG.autoShift = !CFG.autoShift; saveCfg();
        if (CFG.autoShift) { ShiftEngine.start(); AutoAction.enable(); }
        else { ShiftEngine.stop(); AutoAction.disable(); }
        toast('Auto farm ' + (CFG.autoShift ? 'BẬT' : 'TẮT'));
        render();
      });
      GM_registerMenuCommand('Quét kho báu ngay', async () => { CFG.treasureRadar = true; await Treasure.scan(); render(); });
    }
  } catch (_) {}

  function init() {
    ensureUI();
    render();
    bootstrap();

    // React router có thể thay thế body → bảo đảm UI còn
    const mo = new MutationObserver(() => {
      if (!document.body.contains(root)) {
        document.body.appendChild(root);
        if (fab && !document.body.contains(fab)) document.body.appendChild(fab);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
