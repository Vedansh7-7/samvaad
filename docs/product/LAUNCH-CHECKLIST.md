# Launch checklist

A common "before you launch" list (site basics plus security for AI-built apps), checked against
Samvaad on 2026-09-15. Every item has a verdict and the evidence behind it.

- **Have**: already true, verified.
- **Done**: built and shipped on 2026-09-15.
- **Launch**: needed before the public launch, not before.
- **Later**: worth doing once a trigger is met (the trigger is stated).
- **Drop**: does not fit this product.

The site lives at `https://samvaad-mu.vercel.app`. That address is written into the meta tags,
Open Graph tags, `web/sitemap.xml` and `web/robots.txt`. When a custom domain arrives, replace it in
those files.

---

## Site basics

| Item | Verdict | Evidence or plan |
|---|---|---|
| Custom 404 page | **Done** | `web/404.html`, on brand, links home and to How it works. Vercel serves it for any missing path. |
| Meta title per page | **Done** | Every page has its own `<title>`. `app.html` and `login.html` had none. |
| Meta description per page | **Done** | Public pages have one. The app and admin are `noindex` instead. |
| Unique page titles | **Done** | Same fix as above; no two pages share a title. |
| CTA above the fold | **Have** (+ **Done**) | The intro has Skip to sign in from the first second; the sign-in page is itself the CTA. How it works now has a Start free button in its header. |
| Sticky mobile CTA | **Have** (+ **Done**) | The app's bottom bar keeps Talk in reach. How it works now has a sticky Start free bar on phones. |
| Favicon set | **Done** | `favicon.svg`, `favicon-32.png`, `favicon.ico`, `apple-touch-icon.png`, theme colour. |
| Robots.txt | **Done** | `web/robots.txt`: everything open except `app.html` and `admin.html`, and it points at the sitemap. |
| Sitemap.xml | **Done** | `web/sitemap.xml`: intro, How it works, sign in, privacy, terms. |
| Open Graph image | **Done** | `web/og.jpg`, 1200x630, rendered from the brand design. |
| Social share image | **Done** | Same image, with `twitter:card` set to `summary_large_image`. |
| Alt text on every image | **Have** | The site has no `<img>` tags. Illustrations are inline SVG marked decorative, and text in them is real text. |
| Mobile breakpoints | **Have** | Phone-first throughout; tested at 360x640 on every change. |
| Loading states | **Have** | Analysis progress messages, the calm queue countdown, and bubbles while you wait. |
| Form error states | **Have** | Sign-in, consent, file length, recording and upload errors all explain what to do next. |
| Thank you page | **Have** (as in-place states) | Sign-in shows a done state; reviews and the check-in say thank you where they happen. A separate page would add a click and nothing else. |
| Privacy policy page | **Have** (+ **Done**) | `web/privacy.html`. Updated to match reality: deletion on request within 7 days, a cookies and analytics section, and reviews. |
| PP page | **Have** | Same as above. |
| Terms and conditions | **Done** (draft) | `web/terms.html`, plain language, linked from sign-in, privacy and How it works. **Launch:** have a lawyer review it before paid plans. |
| Cookie banner | **Drop** | Samvaad sets no cookies, and Vercel Web Analytics is cookieless. Revisit only if an advertising pixel or a cookie-based tool is ever added. |
| Analytics installed | **Have** | Vercel Web Analytics on public pages, plus the product's own event log in admin. |
| Real contact address | **Launch** | Today it is a personal Gmail. Before launch: a business email (for example `hello@` on the custom domain), and a registered address once there is a company, which Razorpay will ask for anyway. |
| Response time promise | **Done** | "We reply within 7 days" on privacy and terms. **Founder:** change the number if 7 is not right. |
| Compressed images | **Have** | No raster images on the site. Clips are H.264 at about 100 to 160 KB, the music is 620 KB, and `og.jpg` is compressed. |
| Internal links | **Have** (+ **Done**) | Intro, How it works, sign in, privacy, terms and the You page all link to each other. Terms links were added. |
| Breadcrumbs | **Drop** | The site is a few flat pages. Breadcrumbs help deep hierarchies. |
| 5 FAQs | **Done** | Five questions on How it works (privacy, languages, length, consent, cost), with FAQ structured data. |
| Local schema | **Drop** (+ **Done**) | LocalBusiness schema is for places people visit. Samvaad is online, so it has Organization, WebApplication and FAQPage structured data instead. |
| Maps and directions | **Drop** | No physical location to visit. |
| Real reviews on the home page | **Later** | Trigger: 10 or more reviews where people ticked "Samvaad may quote this". The tick box and an "OK to quote" tag in admin shipped today, so the reviews collected from now on can be used. Then show three on the intro's last card and on How it works. |
| Case studies / blog | **Later** | Trigger: the first real stories, told with consent, after launch. Needs a `posts` table, an editor in admin, a public blog page and its own sitemap entries. |
| Team photo | **Later** | Trigger: an About page, which is worth having before paid plans. The founder decides whether faces go on it. |

## Security

| Item | Verdict | Evidence or plan |
|---|---|---|
| Hide API keys | **Have** | Every provider key lives in the backend's environment on Render. The browser only ever holds the public Supabase key. |
| Purge Git secrets | **Have** | Every real secret value in `backend/.env` was searched for across all git history: none found, and no `.env` file was ever committed. Nothing to purge. |
| Use public DB key | **Have** | `web/auth.js` holds only the anon (publishable) key; the service key exists only on the server. |
| Enable row-level security | **Have** | Probed live with the public key: all seven tables return no rows, and a direct insert is refused. |
| Lock record access | **Have** | RLS in the database, and every server query is filtered to the signed-in user (`forUser`). |
| Enforce server-side auth | **Have** | Every endpoint that costs money or touches data requires a signed-in user, a signed guest token, or an admin ID. |
| Block field tampering | **Have** (+ **Done**) | Admin changes are whitelisted and rows are built on the server. Now mode, submode, source and consent are checked against their allowed values, and names are cleaned and capped. |
| Parameterize queries | **Have** | All database access goes through the Supabase client; there is no raw SQL built from strings. |
| Validate all input | **Done** | Names, enums, stars, review length, voice text length, audio type and audio size are all checked on the server. |
| Escape user content | **Have** | Every place that puts model or user text into the page escapes it; a scan found no gaps. The content security policy is a second line. |
| Restrict file uploads | **Done** | The server accepts audio types only (plus audio-only `video/webm` and `video/mp4`), up to 18 MB. |
| Trim API responses | **Done** | Unexpected errors now say only that something went wrong; the detail goes to the server log. The voice endpoint no longer relays the provider's error body. |
| Add security headers | **Done** | Site: Content-Security-Policy, `X-Frame-Options`, `nosniff`, Referrer-Policy and Permissions-Policy in `web/vercel.json`. Backend: `nosniff`, no framing, `no-store`, and no `X-Powered-By`. |
| Force HTTPS | **Have** | HTTP redirects on both hosts (308 on Vercel, 301 on Render), and the site sends HSTS with preload. |
| Scan dependencies | **Done** | `npm audit` found 3 moderate advisories (`qs` via `express`); fixed, now 0. The Rive script is pinned to 2.42.1 with an integrity hash instead of a floating `@2`. **Later:** turn on GitHub Dependabot alerts for the repository. |
| Rate limit login | **Have** | Supabase Auth rate-limits sign-in emails and code attempts. **Launch:** review those limits once custom SMTP is set up. |
| Add bot protection | **Done** (+ **Launch**) | Guest tokens are now limited per network address (10 a minute, 60 a day), and guests are capped at 9 analyses a day per network. **Launch:** add Cloudflare Turnstile to sign-in and guest access (Supabase Auth supports it). |
| Secure session cookies | **Drop** (not used) | There are no cookies. The session token sits in `sessionStorage`, and the content security policy limits what could read it. |
| Hash passwords | **Drop** (not used) | There are no passwords: magic link and one-time code only, handled by Supabase. |
| Encrypt sensitive data | **Have** (+ **Later**) | Supabase encrypts the database at rest, and everything travels over HTTPS. **Later**, when stored reports grow or paid users arrive: encrypt the report text columns with a key held on the server. |

---

## Before the public launch

1. Lawyer review of `web/terms.html` and `web/privacy.html`.
2. A business contact email and, once incorporated, a registered address on both pages.
3. Cloudflare Turnstile on sign-in and guest access.
4. Custom domain: then update the address in meta tags, `sitemap.xml` and `robots.txt`, and set `ALLOWED_ORIGIN` on Render to match.
5. Review Supabase Auth rate limits after custom SMTP.

## Later, with triggers

- **Reviews on the home page**: once 10 or more reviews are marked OK to quote.
- **Blog and case studies**: once real stories exist with consent.
- **About page and team photo**: before paid plans, founder's call on faces.
- **Column-level encryption of stored reports**: before paid users, or when stored reports grow.
- **Dependabot alerts**: any time; a switch in the GitHub repository settings.
