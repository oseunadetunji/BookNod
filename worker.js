// BookNod: check a children's book against a family's own content rules.
// Copyright 2026 BookNod. Licensed under the Functional Source License 1.1, Apache 2.0 Future License (see LICENSE).
//
// One Cloudflare Worker serves the app (bundled from public/ by build.mjs) and its API.
// Every setting lives in your Cloudflare dashboard, never in this file. See README.md for the full list.
//
// Required:  ANTHROPIC_API_KEY (secret), a KV namespace bound as BOOKNOD_KV.
// Payments:  STRIPE_SECRET_KEY (secret; restricted key with Checkout Sessions + Subscriptions read),
//            PASS_YEARLY_URL/PRICE, PASS_MONTHLY_URL/PRICE, PASS_SAVINGS, MANAGE_URL,
//            PACK_URL/PRICE/CHECKS, COMP_CODES ("CODE" or "CODE:200"; 8+ characters).
// Limits:    FREE_PER_DAY (1), RATE_LIMIT_PER_HOUR (40), IP_LIMIT_PER_HOUR (60), DAILY_CAP, CHECK_LIMITER binding.
// Bot check: TURNSTILE_SITE_KEY + TURNSTILE_SECRET (secret).
// Other:     MODEL, TIP_URL, CONTACT_EMAIL, OPERATOR, STATS_KEY (secret, 12+ characters), PARTNERS_JSON.
// Local testing only: MOCK=1 returns sample ratings and fakes payments. Never set it on a live site.

const ASSETS = __ASSETS__; // filled in by build.mjs

// ---- Partner editions ------------------------------------------------------
// Set PARTNERS_JSON (a Text variable) to give a library or school its own link: https://<your-site>/<slug>.
// Example: {"mylib":{"name":"My Public Library","short":"MPL","accent":"#00587C","accentDark":"#6FC3E3",
//   "catalogue":"https://catalogue.example.org/search?q={q}","unlimited":false,"country":"CA",
//   "regions":["Springfield"],"perPhone":20,"dailyCap":2000,"demo":true}}
// unlimited: visitors on the link skip the daily allowance (the partner pays you instead). Keep false until signed.
// regions:   unlimited checks only for connections in these cities ([] = anywhere); country limits it further.
// perPhone:  most checks one phone gets per day on the link. dailyCap: most checks a day across the link.
// catalogue: the partner's catalogue search; {q} becomes the title and author. demo: shows a "Preview" banner.
const partnerCache = new Map();
function partners(env) {
  const raw = env.PARTNERS_JSON || '';
  if (!partnerCache.has(raw)) {
    let v = {};
    try { v = raw ? JSON.parse(raw) : {}; } catch { console.log('PARTNERS_JSON is not valid JSON'); }
    partnerCache.set(raw, v && typeof v === 'object' ? v : {});
  }
  return partnerCache.get(raw);
}
function partnerCovers(P, request) {
  if (!P || !P.unlimited) return false;
  const cf = request.cf || {};
  if (P.country && cf.country && cf.country !== P.country) return false;
  if (!P.regions || !P.regions.length) return true;
  const city = String(cf.city || '').toLowerCase();
  return P.regions.some(r => String(r).toLowerCase() === city);
}

const CATS = {
  profanity: 'Swearing, crude language',
  violence: 'Fighting, injury, weapons, gore',
  sexual: 'Innuendo, sexual references or scenes',
  romance: 'Crushes, kissing, dating',
  bullying: 'Teasing, cruelty, exclusion',
  selfharm: 'Self-harm or suicide: mentions, themes or depictions',
  scary: 'Horror, monsters, intense peril',
  substances: 'Drugs, alcohol, smoking: use or references',
  death: 'Death and grief: loss of a person or pet',
  disrespect: 'Lying, defiance or meanness shown as fun',
};
const YEAR = 365 * 86400_000;
const PASS_DEVICES = 5;
const mem = new Map(); // fallback counters when KV isn't bound (best effort only)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);
      try {
        if (p === '/api/config') return config(url, env, request);
        if (p === '/api/stats') return await stats(request, env);
        if (request.method !== 'POST') return json({ error: 'method' }, 405);
        if (Number(request.headers.get('content-length') || 0) > 3_000_000) return json({ error: 'bad_request' }, 413);
        const body = await request.json().catch(() => ({}));
        if (p === '/api/check') return await check(request, body, env, ctx, url);
        if (p === '/api/pass/claim') return await claimPass(body, env, ctx);
        if (p === '/api/pass/redeem') return await redeemPass(request, body, env, ctx);
        return json({ error: 'not_found' }, 404);
      } catch (e) {
        console.log('api error', e && e.stack);
        return json({ error: 'busy' }, 500);
      }
    }
    return serveAsset(p);
  },
};

// ---- Helpers ---------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function serveAsset(path) {
  if (path === '/') path = '/index.html';
  if (path === '/privacy' || path === '/terms') path = '/privacy.html';
  if (path === '/stats') path = '/stats.html';
  const a = ASSETS[path] || ASSETS['/index.html']; // partner links like /mylib get the app too
  const body = a.b64 ? Uint8Array.from(atob(a.body), c => c.charCodeAt(0)) : a.body;
  return new Response(body, { headers: {
    'content-type': a.type,
    'cache-control': path === '/sw.js' || a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  } });
}
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Days roll over at midnight Toronto time (stats, free checks, partner caps).
const TZ = 'America/Toronto';
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const today = () => ymdFmt.format(new Date());
const torontoHM = () => hmFmt.format(new Date());
const shiftDay = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const cleanId = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const cleanCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
const fmtCode = c => c.length === 11 && c.startsWith('NOD') ? `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}` : c;

async function kvGet(env, k) {
  if (env.BOOKNOD_KV) return env.BOOKNOD_KV.get(k, 'json');
  const v = mem.get(k); return v === undefined ? null : v;
}
async function kvPut(env, k, v, ttl) {
  if (env.BOOKNOD_KV) return env.BOOKNOD_KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
  mem.set(k, v);
}
const partnerOf = (env, slug) => (slug && Object.prototype.hasOwnProperty.call(partners(env), slug)) ? slug : null;

function config(url, env, request) {
  const slug = partnerOf(env, url.searchParams.get('partner'));
  const P = slug ? partners(env)[slug] : null;
  return json({
    turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY || '') : '',
    freePerDay: parseInt(env.FREE_PER_DAY || '1', 10),
    plans: [
      env.PASS_YEARLY_URL || env.PASS_URL ? { id: 'yearly', url: env.PASS_YEARLY_URL || env.PASS_URL, price: env.PASS_YEARLY_PRICE || env.PASS_PRICE || '', note: env.PASS_SAVINGS || '' } : null,
      env.PASS_MONTHLY_URL ? { id: 'monthly', url: env.PASS_MONTHLY_URL, price: env.PASS_MONTHLY_PRICE || '', note: '' } : null,
    ].filter(Boolean),
    pack: env.PACK_URL ? { url: env.PACK_URL, price: env.PACK_PRICE || '', checks: packSize(env) } : null,
    manageUrl: env.MANAGE_URL || '', tipUrl: env.TIP_URL || '', contactEmail: env.CONTACT_EMAIL || '', operator: env.OPERATOR || '',
    partner: P ? { slug, name: P.name, short: P.short, tagline: P.tagline, accent: P.accent, accentDark: P.accentDark,
      catalogue: P.catalogue, unlimited: partnerCovers(P, request), demo: !!P.demo } : null,
  });
}

// ---- Family Pass -----------------------------------------------------------
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return 'NOD' + [...r].map(b => A[b % A.length]).join('');
}
const GRACE = 3 * 86400_000;          // keeps a pass working for 3 days while a renewal payment retries
const KEEP = 800 * 86400;             // how long pass records stay in storage (seconds)
const stripeHeaders = env => ({ authorization: `Bearer ${env.STRIPE_SECRET_KEY}` });

// Reads a subscription's status and paid-through date from Stripe.
async function stripeSub(env, subId) {
  if (env.MOCK && subId.startsWith('sub_test')) {
    const months = subId.includes('monthly') ? 1 : 12;
    return { active: !subId.includes('cancelled'), until: Date.now() + months * 30 * 86400_000 };
  }
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, { headers: stripeHeaders(env) });
  if (!r.ok) return null;
  return subInfo(await r.json());
}
function subInfo(s) {
  const end = s.current_period_end || s.items?.data?.[0]?.current_period_end || 0; // newer Stripe API keeps it on items
  return { active: ['active', 'trialing', 'past_due'].includes(s.status), until: end * 1000 };
}
// For subscriptions: once the paid-through date passes, ask Stripe whether it renewed (at most hourly).
async function refreshPass(env, code, rec) {
  if (!rec || !rec.sub || rec.expires > Date.now()) return rec;
  if (rec.checkedAt && Date.now() - rec.checkedAt < 3600_000) return rec;
  const info = await stripeSub(env, rec.sub).catch(() => null);
  rec.checkedAt = Date.now();
  if (info && info.active && info.until) rec.expires = info.until + GRACE;
  await kvPut(env, 'p:' + code, rec, KEEP);
  return rec;
}
async function attachDevice(env, code, rec, deviceId) {
  if (!rec.devices.includes(deviceId)) {
    if (rec.devices.length >= (rec.maxDevices || PASS_DEVICES)) return { error: 'pass_full' };
    rec.devices.push(deviceId);
    await kvPut(env, 'p:' + code, rec, KEEP);
  }
  return { code: fmtCode(code), expires: rec.expires, plan: rec.plan || 'yearly', renews: !!rec.sub, credits: rec.plan === 'pack' ? rec.credits : undefined };
}
async function claimPass(body, env, ctx) {
  const session = String(body.session_id || '').slice(0, 200);
  const deviceId = cleanId(body.deviceId);
  if (!session || !deviceId) return json({ error: 'bad_request' }, 400);
  // Same payment always returns the same code (safe to reload the page).
  let code = await kvGet(env, 's:' + session);
  if (!code) {
    let rec = null;
    if (env.MOCK && session.startsWith('test_') && session.includes('pack')) {
      rec = { plan: 'pack' };
    } else if (env.MOCK && session.startsWith('test_')) {
      const plan = session.includes('monthly') ? 'monthly' : 'yearly';
      const sub = `sub_test_${plan}_${session}`;
      rec = { sub, plan, expires: (await stripeSub(env, sub)).until + GRACE };
    } else {
      if (!env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 500);
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session)}?expand[]=subscription`, { headers: stripeHeaders(env) });
      if (!r.ok) return json({ error: 'not_paid' }, 402);
      const s = await r.json();
      if (s.mode === 'subscription' && s.subscription) {
        const info = subInfo(s.subscription);
        if (!info.active) return json({ error: 'not_paid' }, 402);
        const interval = s.subscription.items?.data?.[0]?.price?.recurring?.interval;
        rec = { sub: s.subscription.id, plan: interval === 'month' ? 'monthly' : 'yearly', expires: (info.until || Date.now() + YEAR) + GRACE };
      } else if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
        rec = { plan: 'pack' }; // one-time payment = a pack of checks
      } else return json({ error: 'not_paid' }, 402);
    }
    bump(env, ctx, { ['pass_' + rec.plan]: 1 });
    if (rec.plan === 'pack') {
      // Top up the pack this phone already has, or start a new one. Pack checks last 12 months from the latest purchase.
      const into = cleanCode(body.into), old = into ? await kvGet(env, 'p:' + into) : null;
      if (old && old.plan === 'pack' && old.devices.includes(deviceId)) {
        code = into; rec = old;
        rec.credits = (rec.credits || 0) + packSize(env);
      } else {
        code = newCode(); rec = { plan: 'pack', credits: packSize(env), devices: [], source: 'stripe' };
      }
      rec.expires = Date.now() + YEAR;
    } else {
      code = newCode(); rec.devices = []; rec.source = 'stripe';
    }
    await kvPut(env, 'p:' + code, rec, KEEP);
    await kvPut(env, 's:' + session, code, KEEP);
  }
  const rec = await kvGet(env, 'p:' + code);
  const out = await attachDevice(env, code, rec, deviceId);
  return out.error ? json(out, 409) : json(out);
}
// Free codes from COMP_CODES: "CODE" (5 phones) or "CODE:200" (200 phones). Codes under 8 characters are ignored.
function compCodes(env) {
  const out = new Map();
  for (const raw of String(env.COMP_CODES || '').split(',')) {
    const [c, n] = raw.split(':');
    const code = cleanCode(c);
    if (code.length >= 8) out.set(code, Math.max(1, Math.min(5000, parseInt(n, 10) || PASS_DEVICES)));
  }
  return out;
}
async function redeemPass(request, body, env, ctx) {
  const code = cleanCode(body.code), deviceId = cleanId(body.deviceId);
  if (!code || !deviceId) return json({ error: 'bad_request' }, 400);
  // Limit wrong guesses: 10 an hour per internet address.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const failKey = `rf:${(await sha(ip)).slice(0, 24)}:${new Date().toISOString().slice(0, 13)}`;
  const fails = (await kvGet(env, failKey)) || 0;
  if (fails >= 10) return json({ error: 'too_many' }, 429);
  let rec = await refreshPass(env, code, await kvGet(env, 'p:' + code));
  if (!rec) {
    const comps = compCodes(env);
    if (!comps.has(code)) { await kvPut(env, failKey, fails + 1, 7200); return json({ error: 'bad_code' }, 404); }
    rec = { expires: Date.now() + YEAR, devices: [], source: 'comp', maxDevices: comps.get(code) };
    bump(env, ctx, { comp: 1 });
  }
  if (rec.expires < Date.now()) return json({ error: 'expired' }, 410);
  const out = await attachDevice(env, code, rec, deviceId);
  return out.error ? json(out, 409) : json(out);
}
const packSize = env => Math.max(1, parseInt(env.PACK_CHECKS || '10', 10));
// The phone's pass or pack, if it's valid on this phone.
async function passRecord(env, code, deviceId) {
  code = cleanCode(code); if (!code) return null;
  const rec = await refreshPass(env, code, await kvGet(env, 'p:' + code));
  return rec && rec.expires > Date.now() && rec.devices.includes(deviceId) ? { code, rec } : null;
}

// ---- Checking a book -------------------------------------------------------
async function check(request, body, env, ctx, url) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const deviceId = cleanId(body.deviceId) || 'ip-' + (await sha(ip)).slice(0, 16);
  const slug = partnerOf(env, body.partner);
  const P = slug ? partners(env)[slug] : null;
  const day = today(), hour = new Date().toISOString().slice(0, 13);
  const ipH = (await sha(ip)).slice(0, 24);

  // 1. Instant burst limit per internet address (Cloudflare Rate Limiting binding, if added).
  if (env.CHECK_LIMITER) {
    const { success } = await env.CHECK_LIMITER.limit({ key: ipH });
    if (!success) { bump(env, ctx, { ratelimited: 1 }); return json({ error: 'rate_limited' }, 429); }
  }

  // 2. Bot check: a Turnstile token, or a short-lived "human" pass from an earlier check on this phone.
  let human = null;
  if (env.TURNSTILE_SECRET) {
    const ok = await validHuman(env, body.human, deviceId);
    if (!ok) {
      if (!body.turnstile) return json({ error: 'verify' }, 403);
      if (!(await verifyTurnstile(env, body.turnstile, ip))) { bump(env, ctx, { botblocked: 1 }); return json({ error: 'verify' }, 403); }
      human = await makeHuman(env, deviceId);
    }
  }

  // 3. Hourly limits per phone and per internet address.
  const hourKey = `h:${deviceId}:${hour}`, ipHourKey = `hi:${ipH}:${hour}`;
  const [hourN, ipHourN] = [(await kvGet(env, hourKey)) || 0, (await kvGet(env, ipHourKey)) || 0];
  if (hourN >= parseInt(env.RATE_LIMIT_PER_HOUR || '40', 10) || ipHourN >= parseInt(env.IP_LIMIT_PER_HOUR || '60', 10)) {
    bump(env, ctx, { ratelimited: 1 }); return json({ error: 'rate_limited' }, 429);
  }

  const q = String(body.q || '').trim().slice(0, 160);
  const isbn = String(body.isbn || '').replace(/\D/g, '').slice(0, 13);
  const custom = String(body.custom || '').trim().slice(0, 200);
  const image = typeof body.image === 'string' ? body.image : '';
  if (!q && !isbn && !image) return json({ error: 'bad_request' }, 400);
  if (image && (image.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200)))) return json({ error: 'bad_image' }, 400);

  // 4. Who pays for this check: a partner, a Family Pass, or today's free allowance.
  const free = parseInt(env.FREE_PER_DAY || '1', 10);
  const usedKey = `a:${day}:${deviceId}`, ipKey = `ai:${day}:${ipH}`;
  const ppKey = slug ? `pp:${day}:${slug}:${deviceId}` : '', pcKey = slug ? `pc:${day}:${slug}` : '';
  let mode = 'free', used = 0, ipN = 0, ppN = 0, pcN = 0;
  if (P && partnerCovers(P, request)) {
    ppN = (await kvGet(env, ppKey)) || 0;
    pcN = (await kvGet(env, pcKey)) || 0;
    if (ppN < (P.perPhone || 20) && (!P.dailyCap || pcN < P.dailyCap)) mode = 'partner';
  }
  let pk = null;
  if (mode !== 'partner') {
    const pr = await passRecord(env, body.pass, deviceId);
    if (pr && pr.rec.plan !== 'pack') mode = 'pass';
    else if (pr && pr.rec.credits > 0) pk = pr;
  }
  if (mode === 'free') {
    // The daily free check is used first; a pack covers checks after that.
    used = (await kvGet(env, usedKey)) || 0;
    ipN = (await kvGet(env, ipKey)) || 0;
    // Backstop against clearing browser data to reset: generous per-network daily cap.
    if (used >= free || ipN >= free * 15) {
      if (pk) mode = 'pack';
      else { bump(env, ctx, { limit: 1 }); return json({ error: 'limit', freePerDay: free }, 402); }
    }
  }
  let dayN = 0;
  if (env.BOOKNOD_KV && env.DAILY_CAP && mode !== 'partner') {
    dayN = (await kvGet(env, 'd:' + day)) || 0;
    if (dayN >= parseInt(env.DAILY_CAP, 10)) return json({ error: 'busy' }, 503);
  }

  // 5. Count the check BEFORE asking Claude, so a burst of simultaneous requests can't all slip through.
  //    A free check is refunded below if the book isn't found or the check fails.
  const reserve = [kvPut(env, hourKey, hourN + 1, 7200), kvPut(env, ipHourKey, ipHourN + 1, 7200)];
  if (mode === 'free') reserve.push(kvPut(env, usedKey, used + 1, 172800), kvPut(env, ipKey, ipN + 1, 172800));
  if (mode === 'partner') reserve.push(kvPut(env, ppKey, ppN + 1, 172800), kvPut(env, pcKey, pcN + 1, 172800));
  if (mode === 'pack') { pk.rec.credits -= 1; reserve.push(kvPut(env, 'p:' + pk.code, pk.rec, KEEP)); }
  if (dayN || (env.BOOKNOD_KV && env.DAILY_CAP && mode !== 'partner')) reserve.push(kvPut(env, 'd:' + day, dayN + 1, 172800));
  await Promise.all(reserve);
  const refund = () => {
    if (mode === 'free') return Promise.all([kvPut(env, usedKey, used, 172800), kvPut(env, ipKey, ipN, 172800)]);
    if (mode === 'pack') { pk.rec.credits += 1; return kvPut(env, 'p:' + pk.code, pk.rec, KEEP); }
    return null;
  };

  // Shared cache: once anyone checks a book, everyone gets the saved answer.
  const cacheKey = image ? null : await sha(JSON.stringify({ v: 2, q: q.toLowerCase(), isbn, custom: custom.toLowerCase() }));
  const cacheReq = cacheKey ? new Request(`${url.origin}/__cache/${cacheKey}`) : null;
  let result = null, cached = false;
  if (cacheKey) {
    result = env.BOOKNOD_KV ? await env.BOOKNOD_KV.get('r:' + cacheKey, 'json') : null;
    if (!result) { const hit = await caches.default.match(cacheReq); if (hit) result = await hit.json(); }
    cached = !!result;
  }
  let known = '';
  if (!result) {
    known = isbn ? await lookupIsbn(isbn) : '';
    try {
      result = env.MOCK ? mockResult(q || known || isbn) : await askClaude(env, { q, isbn, known, custom, image });
    } catch (e) {
      console.log('claude error', e && e.message);
      ctx.waitUntil(refund());
      bump(env, ctx, { errors: 1 });
      return json({ error: 'busy' }, 502);
    }
    result.custom = custom ? { query: custom, present: !!result.custom?.present, note: String(result.custom?.note || '').slice(0, 200) } : null;
    if (cacheKey && result.found) {
      ctx.waitUntil(caches.default.put(cacheReq, new Response(JSON.stringify(result), { headers: { 'cache-control': 'public, max-age=2592000' } })));
      if (env.BOOKNOD_KV) ctx.waitUntil(env.BOOKNOD_KV.put('r:' + cacheKey, JSON.stringify(result), { expirationTtl: 2592000 }));
    }
  }

  // Books that weren't found don't use up a free check.
  let remaining = null;
  if (mode === 'free') {
    if (result.found) used += 1; else ctx.waitUntil(refund());
    remaining = Math.max(0, free - used);
  }
  const how = image ? 'photo' : isbn ? 'barcode' : 'typed';
  const ev = { checks: 1, [mode]: 1, [cached ? 'cached' : 'fresh']: 1, ['how|' + how]: 1, ['hr|' + torontoHM().slice(0, 2)]: 1 };
  if (image) ev.photo = 1;
  if (result.found && result.title) ev['book|' + result.title.slice(0, 80) + (result.author ? ' — ' + result.author.slice(0, 50) : '')] = 1;
  if (!result.found) {
    ev.notfound = 1;
    logNotFound(env, ctx, { how, q, isbn, lib: known, alts: result.alternatives || [] });
  }
  // One combined write for this check's counts and (once a day per phone) the phone's insights.
  if (env.BOOKNOD_KV) ctx.waitUntil(phoneFields(env, request, deviceId, !!body.app).then(pf => bumpNow(env, { ...ev, ...pf })).catch(() => {}));
  if (mode === 'pack' && !result.found) ctx.waitUntil(refund());
  return json({ result, cached, mode, remaining, human, credits: mode === 'pack' ? pk.rec.credits : undefined });
}

// ---- Private stats (totals only; no names, emails or exact locations) --------
// One record per day. Updates are best effort, so totals are close but not exact under heavy load.
function bump(env, ctx, fields) {
  if (env.BOOKNOD_KV) ctx.waitUntil(bumpNow(env, fields).catch(() => {}));
}
function bumpNow(env, fields) {
  const k = 'st:' + today();
  return (async () => {
    const o = (await kvGet(env, k)) || {};
    for (let [f, n] of Object.entries(fields)) {
      // Breakdowns ("city|…", "book|…") are capped at 300 names a day; the rest count as Other.
      const pre = f.includes('|') ? f.slice(0, f.indexOf('|') + 1) : '';
      if (pre && !(f in o) && Object.keys(o).filter(k => k.startsWith(pre)).length >= 300) f = pre + 'Other';
      o[f] = (o[f] || 0) + n;
    }
    await kvPut(env, k, o, 400 * 86400);
  })();
}
// Counts each phone once a day: new or returning, rough location from the connection (city/province, never stored
// with the phone), device type, and whether it's installed to the home screen. Totals only.
async function phoneFields(env, request, deviceId, installed) {
    if (!deviceId) return {};
    const day = today(), last = await kvGet(env, 'seen:' + deviceId);
    if (last === day) return {};
    await kvPut(env, 'seen:' + deviceId, day, 400 * 86400);
    const cf = request.cf || {}, ua = request.headers.get('user-agent') || '';
    const country = cf.country || '??';
    const prov = cf.region ? `${cf.region}${country !== 'CA' ? ', ' + country : ''}` : country;
    const city = cf.city ? `${cf.city}, ${cf.regionCode || cf.region || country}` : `Unknown, ${prov}`;
    const dev = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
    return { phones: 1, [last ? 'returning' : 'newphones']: 1, ['city|' + city]: 1, ['prov|' + prov]: 1,
      ['dev|' + dev]: 1, [installed ? 'installed' : 'browser']: 1 };
}
// Keeps what was entered for checks that found no book (no note, nothing about who), 30 days, last 200 a day.
function logNotFound(env, ctx, e) {
  if (!env.BOOKNOD_KV) return;
  const k = 'nf:' + today();
  ctx.waitUntil((async () => {
    const list = (await kvGet(env, k)) || [];
    list.unshift({ t: torontoHM(), how: e.how, q: String(e.q || '').slice(0, 120), isbn: e.isbn || '',
      lib: String(e.lib || '').slice(0, 160), alts: (e.alts || []).slice(0, 3).map(x => String(x).slice(0, 100)) });
    await kvPut(env, k, list.slice(0, 200), 30 * 86400);
  })().catch(() => {}));
}
async function stats(request, env) {
  const key = request.headers.get('x-stats-key') || '';
  if (!env.STATS_KEY || env.STATS_KEY.length < 12) return json({ error: 'not_configured' }, 404);
  if (key.length !== env.STATS_KEY.length || (await sha(key)) !== (await sha(env.STATS_KEY))) return json({ error: 'forbidden' }, 403);
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = shiftDay(today(), -i);
    days.push({ day: d, ...((await kvGet(env, 'st:' + d)) || {}) });
  }
  const notFound = [];
  for (let i = 0; i < 7; i++) {
    const d = shiftDay(today(), -i);
    for (const e of ((await kvGet(env, 'nf:' + d)) || [])) notFound.push({ day: d, ...e });
  }
  const num = v => parseFloat(String(v || '').replace(/[^\d.]/g, '')) || 0;
  return json({ days, notFound, model: env.MODEL || 'claude-sonnet-5-5',
    prices: { yearly: num(env.PASS_YEARLY_PRICE) || 99.99, monthly: num(env.PASS_MONTHLY_PRICE) || 9.80, pack: num(env.PACK_PRICE) } });
}

// ---- Bot check (Cloudflare Turnstile) ---------------------------------------
async function verifyTurnstile(env, token, ip) {
  if (env.MOCK && token === 'test-human') return true;
  try {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET); form.append('response', String(token).slice(0, 2048)); form.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    return !!(await r.json()).success;
  } catch { return false; }
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURNSTILE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
// A "human" pass lets the same phone skip the bot check for 30 minutes.
async function makeHuman(env, deviceId) {
  const exp = Date.now() + 30 * 60_000;
  return `${exp}.${await hmac(env, `${deviceId}|${exp}`)}`;
}
async function validHuman(env, token, deviceId) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  return sig === await hmac(env, `${deviceId}|${exp}`);
}

async function lookupIsbn(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, { cf: { cacheTtl: 604800 } });
    const b = (await r.json())[`ISBN:${isbn}`];
    if (!b) return '';
    const authors = (b.authors || []).map(a => a.name).join(', ');
    return `${b.title}${authors ? ' by ' + authors : ''}`;
  } catch { return ''; }
}

function buildPrompt({ q, isbn, known, custom, image }) {
  let book;
  if (image) book = `The attached photo shows a book's cover, spine, or barcode. Identify the book from it.${q ? ` The parent also typed: "${q}".` : ''}`;
  else if (isbn) book = `ISBN ${isbn}${known ? ` (library record: "${known}")` : ''}.${q ? ` The parent also typed: "${q}".` : ''}`;
  else book = `Book: "${q}"`;
  const shape = Object.keys(CATS).map(k => `"${k}":{"level":0,"note":""}`).join(',');
  return `You help parents decide whether a book suits their child. Identify the book, then rate how much of each content type it contains.

${book}

Scale: 0 = none; 1 = mild (brief, non-graphic, or gentle); 2 = some (recurring or moderately described); 3 = strong (frequent, graphic, explicit, or central to the story).
Categories:
${Object.entries(CATS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
${custom ? `\nAlso report whether the book contains this parent-specified concern: "${custom}".\n` : ''}
Base every rating on what you actually know of this book. If the title matches several books, pick the most likely children's or young-adult one and list up to 3 others in "alternatives" as "Title by Author". If you do not recognise the book, set "found" to false; never invent ratings. Use "confidence": "low" when you know the book only vaguely.
Notes: one short, specific sentence for each category above level 0; empty string for level 0. Keep the summary to one sentence without major spoilers.

Reply with only JSON in this shape:
{"found":true,"title":"","author":"","year":2000,"ageRange":"8–12","summary":"","confidence":"high","alternatives":[],"ratings":{${shape}},"custom":{"present":false,"note":""}}`;
}

async function askClaude(env, args) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret is not set');
  const content = [];
  if (args.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: args.image } });
  content.push({ type: 'text', text: buildPrompt(args) });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return normalize(parseJson((data.content || []).filter(c => c.type === 'text').map(c => c.text).join('')));
}
function parseJson(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('no json');
}
function normalize(r) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  const out = {
    found: !!r.found, title: s(r.title, 200), author: s(r.author, 160),
    year: Number.isFinite(+r.year) && +r.year > 0 ? Math.round(+r.year) : null,
    ageRange: s(r.ageRange, 20), summary: s(r.summary, 400),
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium',
    alternatives: Array.isArray(r.alternatives) ? r.alternatives.slice(0, 3).map(x => s(x, 160)) : [],
    ratings: {}, custom: r.custom || null,
  };
  for (const k of Object.keys(CATS)) {
    const v = r.ratings?.[k] || {};
    out.ratings[k] = { level: Math.max(0, Math.min(3, parseInt(v.level, 10) || 0)), note: s(v.note, 240) };
  }
  return out;
}
function mockResult(name) {
  // MOCK test hook: a title containing "notfound" behaves like an unknown book.
  if (/notfound/i.test(name)) return { found: false, title: '', author: '', alternatives: [], ratings: {}, custom: null };
  const ratings = {};
  for (const k of Object.keys(CATS)) ratings[k] = { level: 0, note: '' };
  ratings.violence = { level: 2, note: 'Test data: battles with injuries.' };
  return { found: true, title: `Test: ${name}`, author: 'Mock Author', year: 2001, ageRange: '9–12', summary: 'Mock result for local testing.', confidence: 'high', alternatives: [], ratings, custom: { present: false, note: '' } };
}
