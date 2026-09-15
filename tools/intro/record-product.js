// Records the REAL app.html driving the real flow, with a curated fixture behind the network.
//
// Capture uses Chrome's own screencast (CDP Page.startScreencast), not Playwright's recordVideo:
// recordVideo captures at CSS pixels and ignores deviceScaleFactor, which produced a 390px page in
// the corner of a 780px frame. Headless screencast ALSO ignores it unless Chrome is launched with
// --force-device-scale-factor; with that flag, 360x640 CSS at 3x density is exactly 1080x1920 — native Instagram/Reels resolution.
//
// Every frame carries Chrome's own timestamp; markers use the same clock, so loading frames can be
// cut out exactly and each segment can be timed to its narration line.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out', 'product');
const BASE = 'http://localhost:8123';
// the recording the footage uploads: Upload audio is the headline way in
const UPLOAD = path.join(__dirname, 'assets', 'Kavya and Rohit, Tuesday night.m4a');
const J = (b, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(b) });

const CHAT = [
  "Kavya: Rohit, aaj phir tumne mummy ko call nahi kiya. Unhe bura laga.",
  "Rohit: Yaar office mein kaam tha. Tum samajhti kyun nahi?",
  "Kavya: Samajhti hoon, but yeh daily ho raha hai. Hamesha koi excuse.",
  "Rohit: Excuse? Main hamare future ke liye kaam kar raha hoon.",
  "Kavya: Main yeh nahi keh rahi kaam mat karo. Mujhe akela feel hota hai.",
  "Rohit: ...Shayad main sach mein kuch miss kar raha hoon."
].join('\n');

const ANALYSIS = {
  scores: { connection: 68, empathy: 72, escalation_risk: 52, overall: 71 },
  summary: 'It started as blame and ended as honesty. Kavya named the loneliness underneath, and Rohit heard it.',
  speakers: { A: { name: 'Kavya', gender: 'female' }, B: { name: 'Rohit', gender: 'male' } },
  patterns: [
    { title: '"Hamesha" turned one evening into a verdict', who: 'Kavya', detail: 'Absolutes make the other person defend their whole character, not the moment.' },
    { title: 'Defending before hearing', who: 'Rohit', detail: '"Main future ke liye kaam kar raha hoon" answered an accusation nobody made.' }
  ],
  strengths: [
    { title: 'She named the real feeling', who: 'Kavya', detail: '"Mujhe akela feel hota hai" is the line that changed the direction.' },
    { title: 'He softened and owned it', who: 'Rohit', detail: '"Shayad main sach mein kuch miss kar raha hoon" is a genuine repair attempt.' }
  ],
  improvements: [
    { pattern: 'Blame opener', suggestion: 'Lead with the feeling, not the fault.', script: 'Mummy ko call nahi hua, aur mujhe bura laga. Kya hum kal saath mein kar sakte hain?' },
    { pattern: 'Defensive reply', suggestion: 'Acknowledge first, explain after.', script: 'Tum sahi keh rahi ho, main miss kar raha hoon. Mujhe batao kya hua.' }
  ],
  kpis: { talk_balance: 'even', question_ratio: 'low', repair_attempts: 1, self_reference: 'balanced' },
  original: [
    { speaker: 'A', display: 'Rohit, aaj phir tumne mummy ko call nahi kiya. Unhe bura laga.', speak: 'Rohit, aaj phir tumne mummy ko call nahi kiya. Unhe bura laga.', emotion: 'sad' },
    { speaker: 'B', display: 'Yaar office mein kaam tha. Tum samajhti kyun nahi?', speak: 'Yaar office mein kaam tha. Tum samajhti kyun nahi?', emotion: 'neutral' },
    { speaker: 'A', display: 'Samajhti hoon, but yeh daily ho raha hai. Hamesha koi excuse.', speak: 'Samajhti hoon, but yeh daily ho raha hai. Hamesha koi excuse.', emotion: 'sad' },
    { speaker: 'B', display: 'Excuse? Main hamare future ke liye kaam kar raha hoon.', speak: 'Excuse? Main hamare future ke liye kaam kar raha hoon.', emotion: 'neutral' },
    { speaker: 'A', display: 'Mujhe akela feel hota hai.', speak: 'Mujhe akela feel hota hai.', emotion: 'sad' },
    { speaker: 'B', display: 'Shayad main sach mein kuch miss kar raha hoon.', speak: 'Shayad main sach mein kuch miss kar raha hoon.', emotion: 'sorry' }
  ],
  improved: [
    { speaker: 'A', display: 'Mummy ko call nahi hua, aur mujhe bura laga.', speak: 'Mummy ko call nahi hua, aur mujhe bura laga.', emotion: 'sad' },
    { speaker: 'B', display: 'Tum sahi keh rahi ho. Main miss kar raha hoon.', speak: 'Tum sahi keh rahi ho. Main miss kar raha hoon.', emotion: 'sorry' },
    { speaker: 'A', display: 'Mujhe bas akela feel hota hai.', speak: 'Mujhe bas akela feel hota hai.', emotion: 'attentive' },
    { speaker: 'B', display: 'Kal saath mein call karte hain. Ab batao, kya hua?', speak: 'Kal saath mein call karte hain. Ab batao, kya hua?', emotion: 'warm' }
  ],
  sessionId: 'rec-session', truncated: false,
  limits: { maxChars: 11310, maxWords: 2056, maxMinutes: 13, maxAudioSeconds: 858 },
  allowance: { quota: 3, used: 1, left: 2, perDay: false }
};

const DAY = 86400e3;
const HISTORY = [
  [18, 44, 'Silence after a hard moment'],
  [14, 49, 'Blame openers'],
  [10, 53, '"Hamesha" and "kabhi nahi"'],
  [6, 58, 'Defending before hearing'],
  [3, 63, 'Repair attempts missed']
].map(([ago, overall, title], n) => ({
  id: 'h' + n, created_at: new Date(Date.now() - ago * DAY).toISOString(),
  mode: 'relationship', submode: 'couple', name_a: 'Kavya', name_b: 'Rohit',
  scores: { overall, escalation_risk: Math.round(60 - overall / 3) }, summary: '', patterns: [{ title, who: '', detail: '' }],
  strengths: [], improvements: [], improved: [], original: [], kpis: {}, speakers: {}
}));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--hide-scrollbars', '--force-device-scale-factor=3'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });

  await ctx.route('**/api/**', r => r.fulfill(J({})));
  await ctx.route('**/api/me', r => r.fulfill(J({
    kind: 'user', email: 'kavya@example.com', status: 'active', act1: 'silent', selfMode: false,
    quota: { minutes: 60, used: 4 }, allowance: { quota: 3, used: 0, left: 3, perDay: false },
    limits: ANALYSIS.limits, phone: '919876543210'
  })));
  await ctx.route('**/api/history', r => r.fulfill(J({ sessions: HISTORY.slice().reverse() })));
  await ctx.route('**/api/transcribe', async r => { await new Promise(x => setTimeout(x, 80)); r.fulfill(J({ transcript: CHAT, turns: [], seconds: 33, truncated: false })); });
  await ctx.route('**/api/analyze', async r => { await new Promise(x => setTimeout(x, 80)); r.fulfill(J(ANALYSIS)); });
  await ctx.route('**/auth/v1/**', r => r.fulfill(J({
    id: 'u1', email: 'kavya@example.com', access_token: 'stub', refresh_token: 'stub', expires_in: 360000,
    expires_at: Math.floor(Date.now() / 1000) + 360000, user: { id: 'u1', email: 'kavya@example.com' }
  })));
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('samvaad.session', JSON.stringify({
        access_token: 'stub', refresh_token: 'stub', expires_at: Math.floor(Date.now() / 1000) + 360000,
        user: { id: 'u1', email: 'kavya@example.com' }
      }));
      localStorage.setItem('samvaad.introSeen', '1');
    } catch (e) {}
  });

  const page = await ctx.newPage();
  const frames = [];
  const marks = {};
  const now = () => Date.now() / 1000;
  const mark = (k) => { marks[k] = now(); console.log(k.padEnd(14), 'marked'); };
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(BASE + '/app.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.S && S.me && S.sessions && S.sessions.length >= 5, null, { timeout: 20000 });
  await page.evaluate(() => {
    var e = window.endAct1; window.endAct1 = function () { e(); S._silent = true; };
    S._silent = true;
  });

  // start capturing only once the app is settled, so there is no boot flash to trim
  const cdp = await ctx.newCDPSession(page);
  let n = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const f = path.join(OUT, 'frames', String(n++).padStart(5, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push({ f, t: metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch (e) {}
  });

  // ── Scene 1: upload the recording ──────────────────────────────────────────
  // Signed in, so the form only asks who you were talking with; your own name comes from Profile.
  await page.evaluate(() => {
    startSession('relationship', 'couple');
    document.getElementById('nameA').value = 'Kavya';
    document.getElementById('nameB').value = 'Rohit';
    document.getElementById('consentChk').checked = true;
    document.querySelector('.tabs .tab[data-tab="up"]').click();
  });
  await page.evaluate(() => {
    const t = document.querySelector('.tabs');
    window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 64, behavior: 'instant' });
  });
  await wait(300);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
  await wait(400);
  mark('paste_start');
  await wait(700);
  await page.evaluate(() => document.getElementById('drop').classList.add('over'));   // the file arriving
  await wait(500);
  await page.setInputFiles('#file', UPLOAD);
  await page.waitForFunction(() => /MB/.test(document.getElementById('fileName').textContent), null, { timeout: 8000 });
  await page.evaluate(() => document.getElementById('drop').classList.remove('over'));
  await wait(1300);
  await page.evaluate(() => {
    const b = document.getElementById('goBtn');
    window.scrollTo({ top: b.getBoundingClientRect().top + window.scrollY - 380, behavior: 'smooth' });
  });
  await wait(650);
  mark('click_analyse');
  await page.evaluate(() => document.getElementById('goBtn').click());

  // The walk-through opens by itself after analysis (2026-09-16 review). The reel shows the score before the
  // replay, so the recording jumps straight to each slide rather than walking them in app order.
  await page.waitForFunction(() => document.getElementById('slides').classList.contains('show'), null, { timeout: 15000 });
  const titles = await page.evaluate(() => WALK.slides.map(s => s.eyebrow));
  console.log('slides:', JSON.stringify(titles));
  const goTo = async (re) => {
    const k = await page.evaluate((src) => { const k = WALK.slides.findIndex(s => new RegExp(src, 'i').test(s.eyebrow)); if (k >= 0) { WALK.i = k; renderSlide(); } return k; }, re);
    if (k < 0) throw new Error('slide not found: ' + re);
  };
  const riveUp = () => page.waitForFunction(() => S._rive && S._rive.a && S._rive.a.ready && S._rive.b && S._rive.b.ready, null, { timeout: 20000 }).catch(() => {});

  // ── Scene 2: the score ───────────────────────────────────────────────────
  await goTo('your score');
  await wait(150);
  mark('score_shown');
  await wait(2600);
  mark('score_end');

  // ── Scene 3: the conversation played back ────────────────────────────────
  await goTo('your conversation');
  await riveUp();
  await wait(250);
  mark('act1_start');
  await wait(7200);
  mark('act1_end');

  // ── Scene 4: what went wrong, then what to say instead ───────────────────
  await goTo('what went wrong');
  mark('patterns');
  await wait(2300);
  await goTo('what to say instead');
  mark('improve');
  await wait(2500);
  mark('end');

  await cdp.send('Page.stopScreencast');
  await wait(200);
  await ctx.close(); await browser.close();
  fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify({ frames, marks, titles }, null, 1));
  console.log('frames:', frames.length, '| span:', (frames[frames.length - 1].t - frames[0].t).toFixed(1) + 's');
})();
