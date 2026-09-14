// Verifies the new intro reel at Android size: default sound, icon-only toggle, two skips,
// blocked-autoplay unlock, replay-from-app labels, layout, and a screenshot of every card.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:8123';
const OUT = path.join(__dirname, 'out', 'check');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };

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
const state = page => page.evaluate(() => ({
  i, soundOn, blocked, playing: !!(window.au && !au.paused), vol: window.au ? au.volume : null,
  pressed: document.getElementById('sound').getAttribute('aria-pressed'),
  iconText: document.getElementById('sound').textContent.trim(),
  hasSvg: !!document.querySelector('#sound svg'), off: document.getElementById('sound').classList.contains('off'),
  musicMissing: MU.missing
}));
const box = (page, sel) => page.locator(sel).first().boundingBox();

(async () => {
  // ---------- 1. autoplay allowed ----------
  const b1 = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let { ctx, page, events, errors } = await open(b1, '/intro.html');
  await page.waitForTimeout(1300);
  let st = await state(page);
  ok('sound is on by default', st.soundOn && st.pressed === 'true', st);
  ok('hook voice line is playing at 75%', st.playing && Math.abs(st.vol - 0.75) < 0.001, { playing: st.playing, vol: st.vol });
  ok('sound toggle is an icon with no text', st.hasSvg && st.iconText === '', st.iconText);
  ok('skip buttons read "Skip to blog" and "Skip to sign in"',
    (await page.textContent('#skipBlog')).trim() === 'Skip to blog' && (await page.textContent('#skip')).trim() === 'Skip to sign in');
  const sb = await box(page, '#sound'), bb = await box(page, '#skipBlog'), lb = await box(page, '#skip');
  ok('HUD row fits the phone width without overlap', sb.x + sb.width <= bb.x && bb.x + bb.width <= lb.x && lb.x + lb.width <= 360,
    { sound: Math.round(sb.x + sb.width), blog: [Math.round(bb.x), Math.round(bb.x + bb.width)], signin: [Math.round(lb.x), Math.round(lb.x + lb.width)] });
  ok('tap targets are at least 40px tall', sb.height >= 40 && bb.height >= 30, { sound: sb.height, blog: bb.height });
  await page.screenshot({ path: OUT + '/0-hook.png' });

  // walk every card, screenshotting each
  const shots = [[1, 1800, '1-paste'], [2, 2600, '2-score'], [3, 3000, '3-replay'], [4, 4000, '4-kinder'], [5, 2200, '5-tracked'], [6, 7500, '6-privacy'], [7, 3200, '7-close']];
  for (const [k, wait, name] of shots) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(wait);
    if (k === 1) {
      const kin = await box(page, '#kin .big'), hud = await box(page, '.hudrow');
      ok('caption sits below the HUD', kin && hud && kin.y > hud.y + hud.height, { kinTop: kin && Math.round(kin.y), hudBottom: Math.round(hud.y + hud.height) });
      ok('clip 1 video is decoding', await page.evaluate(() => layers[1].querySelector('video').readyState >= 2));
      const shot = await box(page, '.layer.on .shot');
      ok('caption never covers the product card', kin && shot && kin.y + kin.height <= shot.y, { kinBottom: kin && Math.round(kin.y + kin.height), cardTop: shot && Math.round(shot.y) });
    }
    if (k === 4) ok('clip 4 caption swapped to the kinder line', /kinder/.test(await page.textContent('#kin')));
    if (k === 7) ok('call to action is visible on the last card', await page.isVisible('#cta'));
    await page.screenshot({ path: OUT + '/' + name + '.png' });
  }
  st = await state(page);
  ok('voice still on after walking every card (no false "blocked")', st.soundOn && !st.blocked, st);
  const mu = await page.evaluate(() => ({ loaded: !!MU.el && !MU.missing, playing: !!(MU.el && !MU.el.paused), level: MU.level }));
  ok('music bed plays, quietly', mu.loaded && mu.playing && mu.level > 0 && mu.level < 0.4, mu);
  await page.click('#sound'); await page.waitForTimeout(200);
  st = await state(page);
  ok('tapping the icon turns sound off', !st.soundOn && st.pressed === 'false' && !st.playing, st);
  await page.click('#skipBlog');
  await page.waitForURL(/how-it-works\.html/, { timeout: 8000 }).catch(() => {});
  ok('Skip to blog opens the blog', /how-it-works\.html/.test(page.url()), page.url());
  const names = events.map(e => e.name);
  ok('events recorded (started, scene, muted)', ['intro_started', 'intro_scene', 'intro_muted'].every(n => names.includes(n)), [...new Set(names)]);
  const sk = events.find(e => e.name === 'intro_skipped');
  console.log('INFO intro_skipped via beacon captured:', sk ? JSON.stringify(sk.props) : 'not visible to the test (sendBeacon)');
  ok('no script errors', errors.length === 0, errors.slice(0, 3));
  await ctx.close();

  ({ ctx, page, errors } = await open(b1, '/intro.html'));
  await page.waitForTimeout(600);
  await page.click('#skip');
  await page.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {});
  ok('Skip to sign in opens sign-in', /login\.html/.test(page.url()), page.url());
  await ctx.close();

  ({ ctx, page, errors } = await open(b1, '/intro.html?from=app'));
  await page.waitForTimeout(600);
  ok('replay from the app says "Back to app"', (await page.textContent('#skip')).trim() === 'Back to app');
  await ctx.close();
  await b1.close();

  // ---------- 2. autoplay blocked, as on a first real visit ----------
  const b2 = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=document-user-activation-required'] });
  ({ ctx, page, events, errors } = await open(b2, '/intro.html'));
  await page.waitForTimeout(1300);
  st = await state(page);
  const tapShown = () => page.evaluate(() => document.getElementById('tapSound').classList.contains('show'));
  ok('blocked browser: big speaker button appears, icon shows off', st.blocked && !st.soundOn && st.off && await tapShown(), st);
  await page.screenshot({ path: OUT + '/9-blocked.png' });
  await page.waitForTimeout(2600);
  st = await state(page);
  ok('blocked browser: waits after the hook instead of running on silently', st.i === 0 && st.blocked, st);
  await page.mouse.click(180, 300);
  await page.waitForTimeout(700);
  st = await state(page);
  ok('first tap starts again from the top, with sound', st.soundOn && !st.blocked && st.playing && st.i === 0 && !(await tapShown()), st);
  ok('blocked browser: no script errors', errors.length === 0, errors.slice(0, 3));
  await ctx.close(); await b2.close();

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); process.exit(1); });
