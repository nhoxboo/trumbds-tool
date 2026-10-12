/** Chụp ảnh UI thật: chạy userscript sống trong Chromium với fetch giả lập. */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SCRIPT = path.join(__dirname, 'trumbds-auto.user.js');

const FIX = {
  '/api/v1/me': {
    id: 'p1', username: 'AnhNam', title: { text: 'Đại gia' },
    cash: 125000000000,
    properties: [
      { id: 'prop1', name: 'Quán cà phê Mây', assetType: 'CAFE', canShift: true, stars: 3 },
      { id: 'prop2', name: 'Khách sạn Trùm', assetType: 'HOTEL', canShift: true, stars: 2 },
    ],
    ledger: [
      { label: 'Lãi cho thuê', amount: 45000000 },
      { label: 'Gửi tiết kiệm', amount: -10000000 },
    ],
  },
  '/api/v1/properties/p1': { id: 'prop1', properties: [{ id: 'prop1' }] },
};

const TREASURES = {
  treasures: [
    { code: 'AB12CD34', title: 'Kho báu quán cà phê Mây', lat: 10.7775, lng: 106.7015, state: 'LIVE' },
    { code: 'XY99ZZ88', title: 'Kho báu công viên', lat: 10.7800, lng: 106.7100, state: 'LIVE' },
    { code: 'OLD0001', title: 'Kho báu đã hết hạn', lat: 10.7750, lng: 106.6950, state: 'EXPIRED' },
  ],
};

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=vi-VN'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 860, height: 900, deviceScaleFactor: 2 });

  await page.setContent(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;min-height:100vh;background:linear-gradient(135deg,#e2e8f0,#cbd5e1);' +
    'font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif"></body></html>',
    { waitUntil: 'networkidle0' }
  );

  // mock fetch + geolocation + GM
  await page.evaluate((fix, treasures) => {
    window.fetch = (u) => {
      const p = String(u).split('?')[0];
      if (p.includes('/treasures')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(treasures) });
      }
      if (fix[p]) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fix[p]) });
      return Promise.resolve({
        ok: false, status: 404,
        json: () => Promise.resolve({ error: { code: 'NOT_FOUND', message: 'không có' } }),
      });
    };
    window.GM_registerMenuCommand = () => {};
    window.GM_getValue = (k, d) => d;
    window.GM_setValue = () => {};
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok) =>
          ok({ coords: { latitude: 10.7769, longitude: 106.7009, accuracy: 15 } }),
      },
    });
  }, FIX, TREASURES);

  // inject userscript như Tampermonkey (bỏ dòng @grant độc)
  const script = fs.readFileSync(SCRIPT, 'utf8');
  await page.evaluate(script);

  await new Promise((r) => setTimeout(r, 900));

  const names = ['farm', 'treasure', 'land', 'stats'];
  for (let i = 0; i < names.length; i++) {
    await page.evaluate((idx) => {
      document.querySelectorAll('#tba-tabs button')[idx].click();
    }, i);
    await new Promise((r) => setTimeout(r, 350));
    if (i === 1) {
      await page.evaluate(() => {
        const b = document.getElementById('tba-scan');
        if (b) b.click();
      });
      await new Promise((r) => setTimeout(r, 700));
    }
    const out = path.join(__dirname, `tab-${names[i]}.png`);
    await page.screenshot({ path: out });
    console.log('saved', out);
  }

  await browser.close();
})();
