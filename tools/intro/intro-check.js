// Intro reel after the 2026-09-16 review: opens on product video, 4 clips + close, story-style taps,
// purple Try now to sign-in with next=talk, voice buffered up front, blocked-autoplay still handled.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:8123';
const OUT = require('path').join(__dirname, 'out', 'introcheck');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')); };

async function open(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const events = [], errors = [];
  await ctx.route('**/api/config', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"introEnabled":true}' }));
  await ctx.route('**/api/event', r => { try { events.push(JSON.parse(r.request().postData() || '{}')); } catch (e) {} r.fulfill({ status: 200, body: '{}' }); });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE + url, { waitUntil: 'load' });
  return { ctx, page, events, errors };
}
const st = page => page.evaluate(() => ({ i, soundOn, blocked, playing: !!(window.au && !au.paused), vol: window.au ? au.volume : null,
  n: SCENES.length, kinds: SCENES.map(s => s.kind), total: SCENES.reduce((a, s) => a + s.dur, 0), buffered: SCENES.filter(s => s._au).length }));
const tapAt = async (page, frac) => { const b = await page.locator('#reel').boundingBox(); await page.mouse.click(b.x + b.width * frac, b.y + b.height * 0.55); };

(async () => {
  const b1 = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let { ctx, page, events, errors } = await open(b1, '/intro.html');
  await page.waitForTimeout(1400);
  let s = await st(page);
  ok('opens on product video, not text', s.kinds[0] === 'video' && s.i === 0, s.kinds);
  ok('four clips and a closing card', s.n === 5 && s.kinds[4] === 'close', s.kinds);
  ok('reel is short (under 32 seconds)', s.total < 32, s.total.toFixed(1));
  ok('every voice line buffered up front', s.buffered === 5, s.buffered);
  ok('voice plays on the first card at 75%', s.playing && Math.abs(s.vol - 0.75) < 0.01, s);
  const tryBtn = page.locator('#skip');
  ok('Try now label', (await tryBtn.textContent()).trim() === 'Try now');
  const bg = await tryBtn.evaluate(e => getComputedStyle(e).backgroundImage + '|' + getComputedStyle(e).color);
  ok('Try now is purple with white text', /gradient/.test(bg) && /255, 255, 255/.test(bg), bg);
  await page.screenshot({ path: OUT + '/0-first.png' });

  await tapAt(page, 0.8); await page.waitForTimeout(500);
  ok('tap right goes to the next card', (await st(page)).i === 1);
  await tapAt(page, 0.8); await page.waitForTimeout(500);
  ok('tap right again', (await st(page)).i === 2);
  await tapAt(page, 0.15); await page.waitForTimeout(500);
  s = await st(page);
  ok('tap left goes back a card', s.i === 1, s.i);
  ok('voice restarts on the card you went back to', s.playing, s);
  ok('back is tracked', events.some(e => e.name === 'intro_back'));
  for (let k = 0; k < 6; k++) { await tapAt(page, 0.8); await page.waitForTimeout(300); }
  s = await st(page);
  ok('tapping right stops on the last card', s.i === 4, s.i);
  await page.waitForTimeout(1500);
  ok('closing card copy', /Try it, visualise, and score your progress\./.test(await page.textContent('.layer.on')));
  ok('closing card button visible', await page.isVisible('#cta'));
  await page.screenshot({ path: OUT + '/4-close.png' });
  await page.click('#cta');
  await page.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {});
  ok('end of reel goes to sign-in without next=talk', /login\.html$/.test(page.url()), page.url());
  ok('no script errors', errors.length === 0, errors.slice(0, 3));
  await ctx.close();

  ({ ctx, page } = await open(b1, '/intro.html'));
  await page.waitForTimeout(700);
  await page.click('#skip');
  await page.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {});
  ok('Try now goes to sign-in with next=talk', /login\.html\?next=talk/.test(page.url()), page.url());
  await ctx.close();

  ({ ctx, page } = await open(b1, '/intro.html'));
  await page.waitForTimeout(700);
  await page.click('#skipBlog');
  await page.waitForURL(/how-it-works/, { timeout: 8000 }).catch(() => {});
  ok('Skip to blog still opens How it works', /how-it-works/.test(page.url()));
  await ctx.close();
  await b1.close();

  const b2 = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=document-user-activation-required'] });
  ({ ctx, page, errors } = await open(b2, '/intro.html'));
  await page.waitForTimeout(1400);
  s = await st(page);
  ok('blocked browser: big speaker button shows', s.blocked && await page.evaluate(() => document.getElementById('tapSound').classList.contains('show')), s);
  await tapAt(page, 0.8); await page.waitForTimeout(700);
  s = await st(page);
  ok('first tap unlocks sound and does not skip the card', s.soundOn && !s.blocked && s.i === 0, s);
  ok('blocked browser: no script errors', errors.length === 0, errors.slice(0, 3));
  await ctx.close(); await b2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); process.exit(1); });
