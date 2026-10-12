# Trùm BĐS Tool — 12/10/2026

## Deliverable
- Repo: https://github.com/nhoxboo/trumbds-tool (nhánh `main`)
- Script: `trumbds-auto.user.js` (v1.0.0)
- Raw: https://raw.githubusercontent.com/nhoxboo/trumbds-tool/main/trumbds-auto.user.js
- Test: `test.js` (jsdom, 26/26 pass) · Ảnh UI: `tab-*.png`

## Kiến trúc game (đã reverse từ bundle Next.js)
- Stack: Next.js App Router + API `/api/v1` (server-authoritative).
- Bản đồ: **Google Maps thật** — săn đất theo tọa độ địa thật, không phải game 3D.
- API client: module `99242` (`FH(path, opts)` → `fetch("/api/v1"+path)`).
- Endpoint: `/me`, `/ranks`, `/status`, `/players/:id`, `/properties/:id/shift` (POST),
  `/shifts/:runId/finish` (POST), `/treasures?bbox=&z=`, `/exchange/{state,ticks,orders}`,
  `/auth/{login,register,signup-check}`, `/referrals/:code`, `/topup/charity-transfers/`.

## Shift minigame (27 game)
- `POST /properties/{id}/shift {game}` → `{ runId, durationMs, ... }`
- Client điều khiển bằng DOM; `POST /shifts/{runId}/finish` gửi
  `{ score, served, missed, maxCombo, log: { v: 1, actions: [[tick, actionId, arg]] } }`.
- **Anti-cheat**: server `replayShift(spec, seed, durationMs, actions)` chạy lại
  từng tick từ seed, so sánh score/served/missed/maxCombo. Lệch → reject
  (`bad_log`, `mismatch`, `timing`, `impossible`, `too_early`).
- Hằng số: `SHIFT_TICK_MS=10`, `SHIFT_LOG_MAX=1500`, `SHIFT_LOG_VERSION=1`,
  `SHIFT_EARLY_MS=5000`, `SHIFT_EXPIRE_MS=900000`.

## Kết luận quan trọng
"Vip/mua tiền/giảm giá" **không làm được** — server là nguồn sự thật.
Tool chỉ auto-hoá thao tác thật (auto-bấm DOM), nên vẫn qua replay validation.

## Kinh tế game
`STARTER_GRANT_AMOUNT=1e5` (nhận vốn 10 tỷ? thực tế 100k đơn vị nội bộ),
`OFFLINE_CAP_HOURS=24`, `MAP_PROPERTIES_LIMIT=300`, danh hiệu `chain` (>10) / `tycoon` (>20).
Ledger có: `LOAN_INTEREST`, `SHARE_PURCHASE`, `DIVIDEND_INCOME`, `SAVINGS_DEPOSIT`,
`TREASURE_REWARD`, `MANAGER_COMMISSION`...

## Kho báu GPS
- `TREASURE_MIN_ZOOM=14`, `TREASURE_MAX_ACCURACY_M=150`, `TREASURE_ACCURACY_SLACK_M=50`,
  bán kính 20–2000m.
- Trạng thái: `LIVE | EXHAUSTED | EXPIRED | PROPERTY_GIVEN | HIDDEN`.
- Quà chỉ nhận khi đứng đúng tọa độ (accuracy ≤150m).

## Bài học (pitfall đã gặp)
- Bundle Next.js: phải đọc `webpack.js` để lấy `r.u` chunk map, tải hết chunk rồi grep —
  không tìm được route `/map` chỉ từ HTML vì server redirect 307 về `/login`.
- `preview.html` serialize ra rồi click tab sẽ **không** đổi state (JS chết).
  Muốn chụp UI từng tab: chạy script sống trong Chromium headless (puppeteer) với fetch mock.
- Memory Hermes đầy → không ép `memory.add`, ghi vào file notes thay thế.
