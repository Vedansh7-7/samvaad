// Records the marketing cut from intro.html?film=1 with Chrome's own screencast (true device pixels),
// and notes where each card starts on the same clock so the narration can be laid on exactly.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out', 'film');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-device-scale-factor=2'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route('**/api/config', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"introEnabled":true}' }));
  await ctx.route('**/api/event', r => r.fulfill({ status: 200, body: '{}' }));
  const page = await ctx.newPage();
  const frames = [];
  let n = 0;
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const f = path.join(OUT, 'frames', String(n++).padStart(5, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t: metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch (e) {}
  });
  await page.goto('http://localhost:8123/intro.html?film=1', { waitUntil: 'load' });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 720, maxHeight: 1280 });
  await page.waitForFunction(() => window.i === 0, null, { timeout: 30000, polling: 'raf' });
  const meta = await page.evaluate(() => {
    let at = 0;
    return {
      start: (performance.timeOrigin + t0) / 1000,
      cards: SCENES.map(s => { const c = { audio: s.audio || null, at }; at += s.dur; return c; }),
      total: SCENES.reduce((a, s) => a + s.dur, 0)
    };
  });
  await page.waitForFunction(() => window.completed === true, null, { timeout: 120000 });
  await page.waitForTimeout(1800);
  await cdp.send('Page.stopScreencast');
  await ctx.close(); await browser.close();
  fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify({ frames, ...meta }, null, 1));
  console.log('frames', frames.length, '| reel length', meta.total.toFixed(2) + 's');
})().catch(e => { console.error(e); process.exit(1); });
