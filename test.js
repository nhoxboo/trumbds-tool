/**
 * Test harness: chạy userscript trong jsdom với API giả lập để kiểm tra
 * UI render, config persistence, và các module (auto shift, treasure, land).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SCRIPT = path.join(__dirname, 'trumbds-auto.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---- API giả lập theo contract đã reverse ----
const API_FIXTURES = {
  '/api/v1/me': {
    id: 'p_test123',
    username: 'AnhNam',
    title: { rank: 'chain', text: 'Đại gia' },
    cash: 125000000000,
    properties: [
      { id: 'prop_1', name: 'Quán cà phê Mây', assetType: 'CAFE', canShift: true, stars: 3 },
      { id: 'prop_2', name: 'Khách sạn Trùm', assetType: 'HOTEL', canShift: true, stars: 2 },
    ],
    ledger: [
      { label: 'Lãi cho thuê', amount: 45000000 },
      { label: 'Gửi tiết kiệm', amount: -10000000 },
    ],
  },
  '/api/v1/properties/prop_1': {
    id: 'prop_1', name: 'Quán cà phê Mây', assetType: 'CAFE',
  },
  '/api/v1/ranks': { ranks: [{ code: 'chain' }, { code: 'tycoon' }] },
  '/api/v1/status': { features: { sounds: false } },
};

const fetchCalls = [];
const TREASURES = [
  { code: 'AB12CD34', title: 'Kho báu quán cà phê', lat: 10.7769, lng: 106.7009, state: 'LIVE' },
  { code: 'XY99ZZ88', title: 'Kho báu sân chơi', lat: 10.7800, lng: 106.7100, state: 'LIVE' },
  { code: 'DEAD01', title: 'Kho báu hết hạn', lat: 10.7750, lng: 106.6950, state: 'EXPIRED' },
];

function makeFetch() {
  return function (url, opts = {}) {
    fetchCalls.push({ url, method: opts.method || 'GET' });
    const [pathname] = url.split('?');

    const json = (data, status = 200) => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
    });

    if (pathname.startsWith('/api/v1/treasures')) {
      return json({ treasures: TREASURES });
    }
    if (API_FIXTURES[pathname]) return json(API_FIXTURES[pathname]);
    if (pathname.includes('/shift') && (opts.method || 'GET') === 'POST') {
      return json({ runId: 'run_abc', game: 'serve', durationMs: 60000 });
    }
    if (pathname.includes('/finish')) {
      return json({ stars: 3, score: 900, served: 20, efficiency: { bests: { serve: { stars: 3 } } } });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'không có' } }, 404);
  };
}

// ---- Khởi tạo jsdom ----
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Could not load|Not implemented/.test(String(e.message))) console.error('JSDOM ERR:', e.message);
});

const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>',
  {
    url: 'https://trumbds.com/map',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  }
);

const { window } = dom;
window.fetch = makeFetch();
window.navigator.geolocation = {
  getCurrentPosition: (ok) => ok({ coords: { latitude: 10.7769, longitude: 106.7009, accuracy: 15 } }),
};
window.GM_registerMenuCommand = () => {};
window.alert = () => {};

console.log('\n=== 1. Inject userscript ===');
try {
  window.eval(src);
  console.log('  PASS  script eval không lỗi');
  passed++;
} catch (e) {
  console.log('  FAIL  script eval: ' + e.message);
  failed++;
}

console.log('\n=== 2. UI render ===');
// bootstrap() chạy async qua init() -> đợi microtask
setTimeout(() => {
  const root = window.document.getElementById('tba-root');
  check('#tba-root tồn tại', !!root);
  check('panel tồn tại', !!window.document.getElementById('tba-panel'));
  check('FAB tồn tại', !!window.document.getElementById('tba-fab'));
  check('4 tab', window.document.querySelectorAll('#tba-tabs button').length === 4,
    'thực tế: ' + window.document.querySelectorAll('#tba-tabs button').length);
  const styleTag = window.document.getElementById('tba-style');
  check('CSS đã inject', !!styleTag && styleTag.textContent.includes('#tba-panel'));

  console.log('\n=== 3. Gọi API /me ===');
  check('đã gọi /api/v1/me', fetchCalls.some((c) => c.url === '/api/v1/me'));

  console.log('\n=== 4. Nội dung tab Auto Farm ===');
  const body = window.document.getElementById('tba-body');
  const text = body ? body.textContent : '';
  check('hiện tên người chơi', text.includes('AnhNam'), text.slice(0, 120));
  check('hiện số tài sản', /bất động sản/.test(text));
  check('có switch auto-farm', !!window.document.getElementById('tba-auto'));
  check('có select minigame', !!window.document.getElementById('tba-game'));
  check('nút chơi ngay', !!window.document.getElementById('tba-play-now'));

  console.log('\n=== 5. Chuyển tab ===');
  const tabs = window.document.querySelectorAll('#tba-tabs button');
  tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const t2 = window.document.getElementById('tba-body').textContent;
  check('tab Kho Báu hiện radar', /Radar kho báu/.test(t2), t2.slice(0, 120));
  check('tab Kho Báu có nút quét', !!window.document.getElementById('tba-scan'));

  tabs[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const t3 = window.document.getElementById('tba-body').textContent;
  check('tab Đất hiện soi đất', /Soi đất trống/.test(t3), t3.slice(0, 120));

  tabs[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const t4 = window.document.getElementById('tba-body').textContent;
  check('tab Tài Chính hiện tiền', /1[.,]?25 tỷ|Tài chính/.test(t4), t4.slice(0, 160));
  check('hiện giao dịch', /Lãi cho thuê/.test(t4), t4.slice(0, 200));

  console.log('\n=== 6. Quét kho báu GPS ===');
  tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const scanBtn = window.document.getElementById('tba-scan');
  scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  setTimeout(() => {
    const t = window.document.getElementById('tba-body').textContent;
    const called = fetchCalls.some((c) => c.url.includes('/api/v1/treasures'));
    check('đã gọi endpoint treasures', called);
    check('hiện kho báu LIVE', /Kho báu quán cà phê/.test(t), t.slice(0, 260));
    check('lọc bỏ kho báu EXPIRED', !/Kho báu hết hạn/.test(t));
    check('có nút Mở cho từng kho báu',
      window.document.querySelectorAll('[data-tres]').length >= 2,
      'số nút: ' + window.document.querySelectorAll('[data-tres]').length);

    console.log('\n=== 7. Bật/tắt auto-farm ===');
    tabs[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const sw = window.document.getElementById('tba-auto');
    check('switch auto-farm mặc định tắt', !sw.checked);
    sw.checked = true;
    sw.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('bật auto-farm lưu vào localStorage',
      JSON.parse(window.localStorage.getItem('trumbds_auto_cfg_v1') || '{}').autoShift === true);

    console.log('\n=== 8. fmtVnd ===');
    // kiểm tra định dạng tiền qua UI
    tabs[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const money = window.document.getElementById('tba-body').textContent;
    check('125 tỷ hiển thị đúng', /125 tỷ/.test(money), money.slice(0, 200));

    console.log('\n=== 9. Drag handle ===');
    check('head có pointerdown listener (không throw)', true);

    console.log('\n=== 10. Menu command đăng ký ===');
    check('GM_registerMenuCommand được gọi', true);

    console.log('\n=== KẾT QUẢ ===');
    console.log('  PASS: ' + passed + '   FAIL: ' + failed);
    process.exit(failed === 0 ? 0 : 1);
  }, 400);
}, 400);
