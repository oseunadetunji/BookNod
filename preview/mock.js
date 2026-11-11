// Preview mode: stands in for the server so the app can be clicked through with no setup.
// Ratings here are hand-written samples for a few well-known books.
(function () {
  const PARTNER = window.BOOKNOD_PARTNER || null;
  const PARTNERS = { demo: { slug: 'demo', name: 'Springfield Public Library', short: 'SPL', tagline: 'Free for SPL families',
    accent: '#00587C', accentDark: '#6FC3E3', catalogue: 'https://www.google.com/search?q={q}+library', unlimited: true, demo: true } };
  const Z = { level: 0, note: '' };
  const R = (o) => Object.assign({ profanity: Z, violence: Z, sexual: Z, romance: Z, bullying: Z, selfharm: Z, scary: Z, substances: Z, death: Z, disrespect: Z }, o);
  const BOOKS = [
    { k: ['hunger games'], title: 'The Hunger Games', author: 'Suzanne Collins', year: 2008, ageRange: '12+',
      summary: 'In a future nation, a teenager volunteers to take her sister’s place in a televised fight to the death.',
      ratings: R({ violence: { level: 3, note: 'Children are killed in the arena; deaths are described directly.' }, scary: { level: 2, note: 'Sustained peril, hunger and fear for survival.' },
        death: { level: 3, note: 'Several characters die, including a young ally.' }, romance: { level: 1, note: 'A staged romance and a kiss.' },
        substances: { level: 1, note: 'Haymitch, a mentor, is often drunk.' }, bullying: { level: 1, note: 'Cruelty from other tributes and the Capitol.' } }) },
    { k: ['wonder'], title: 'Wonder', author: 'R.J. Palacio', year: 2012, ageRange: '8–12', isbn: true,
      summary: 'A boy with a facial difference starts school for the first time in fifth grade.',
      ratings: R({ bullying: { level: 2, note: 'Classmates exclude and mock Auggie; it is a central theme.' }, violence: { level: 1, note: 'A brief scuffle with older kids at a school trip.' },
        death: { level: 1, note: 'A grandmother and the family dog die.' }, romance: { level: 1, note: 'Auggie’s older sister has a boyfriend.' } }) },
    { k: ['dog man'], title: 'Dog Man', author: 'Dav Pilkey', year: 2016, ageRange: '7–10',
      summary: 'A part-dog, part-cop hero foils a villainous cat in a comic told by two young creators.',
      ratings: R({ violence: { level: 1, note: 'Cartoon slapstick and explosions with no real injury.' }, disrespect: { level: 1, note: 'Potty humour and a gleefully naughty villain.' } }) },
    { k: ['wimpy kid'], title: 'Diary of a Wimpy Kid', author: 'Jeff Kinney', year: 2007, ageRange: '8–12',
      summary: 'Middle-schooler Greg Heffley records his schemes to survive the school year.',
      ratings: R({ disrespect: { level: 2, note: 'Greg lies, schemes and treats his best friend badly, played for laughs.' }, bullying: { level: 1, note: 'Teasing and pranks between students and brothers.' } }) },
    { k: ['harry potter', 'philosopher', 'sorcerer'], title: 'Harry Potter and the Philosopher’s Stone', author: 'J.K. Rowling', year: 1997, ageRange: '8–12', magic: true,
      summary: 'An orphan learns he is a wizard and starts his first year at Hogwarts.',
      ratings: R({ violence: { level: 1, note: 'A fight with a troll and a final confrontation.' }, scary: { level: 2, note: 'A dark forest scene and the villain Voldemort.' },
        death: { level: 1, note: 'Harry’s parents were murdered before the story starts.' }, bullying: { level: 1, note: 'Harry’s relatives and Draco Malfoy mistreat him.' },
        disrespect: { level: 1, note: 'The friends break school rules, usually for good reasons.' } }) },
    { k: ['charlotte'], title: 'Charlotte’s Web', author: 'E.B. White', year: 1952, ageRange: '7–11',
      summary: 'A pig named Wilbur is saved from slaughter by his friendship with a clever spider, Charlotte.',
      ratings: R({ violence: { level: 1, note: 'Talk of Wilbur being butchered.' }, scary: { level: 1, note: 'Wilbur’s fear of being killed.' }, death: { level: 2, note: 'Charlotte dies near the end, gently handled.' } }) },
  ];
  const day = () => new Date().toISOString().slice(0, 10);
  const ALLOW = () => { try { return localStorage.getItem('booknod.first') === new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) ? 3 : 1; } catch (e) { return 1; } };
  const used = () => { try { const u = JSON.parse(localStorage.getItem('booknod.preview.used')); return u && u.day === day() ? u.n : 0; } catch (e) { return 0; } };
  const setUsed = n => { try { localStorage.setItem('booknod.preview.used', JSON.stringify({ day: day(), n })); } catch (e) {} };
  const res = (obj, status = 200) => new Promise(ok => setTimeout(() => ok(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })), status === 200 && obj.result ? 900 : 150));
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (!u.startsWith('/api/')) return realFetch(input, init);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.startsWith('/api/config')) return res({ freePerDay: 1, firstDayFree: 3, tipUrl: 'https://ko-fi.com', manageUrl: 'https://billing.stripe.com',
      plans: [{ id: 'yearly', url: '?session_id=test_preview_yearly', price: '$49.99/year', note: 'Save 16%' },
              { id: 'monthly', url: '?session_id=test_preview_monthly', price: '$4.99/month', note: '' }],
      partner: PARTNER ? PARTNERS[PARTNER] : null });
    if (u === '/api/report') return res({ ok: true });
    if (u === '/api/pass/claim' || u === '/api/pass/redeem') {
      if (u === '/api/pass/redeem' && !/^NOD/i.test(String(body.code).replace(/\W/g, ''))) return res({ error: 'bad_code' }, 404);
      const sid = String(body.session_id || '');
      if (sid.includes('pack')) return res({ code: 'NOD-PACK-2026', expires: Date.now() + 365 * 86400000, plan: 'pack', renews: false, credits: 10 + (body.into ? (window.__packLeft || 0) : 0) });
      const plan = String(body.session_id || '').includes('monthly') ? 'monthly' : 'yearly';
      return res({ code: 'NOD-DEMO-2026', expires: Date.now() + (plan === 'monthly' ? 30 : 365) * 86400000, plan, renews: true });
    }
    if (u === '/api/check') {
      const isPack = /PACK/.test(String(body.pass || ''));
      let packLeft = null;
      if (isPack) { const ps = JSON.parse(localStorage.getItem('booknod.pass') || '{}'); packLeft = ps.credits || 0; }
      const pass = !!body.pass && (!isPack || packLeft > 0 || used() < 1), partner = !!PARTNER;
      if (!pass && !partner && used() >= ALLOW()) return res({ error: 'limit', freePerDay: ALLOW(), allowance: ALLOW() }, 402);
      const q = String(body.q || '').toLowerCase();
      let b = body.isbn || body.image ? BOOKS.find(x => x.isbn) : BOOKS.find(x => x.k.some(k => q.includes(k)));
      let result;
      if (b) result = { found: true, title: b.title, author: b.author, year: b.year, ageRange: b.ageRange, summary: b.summary, confidence: 'high', alternatives: [], ratings: b.ratings };
      else result = { found: true, title: body.q, author: 'Sample author', year: null, ageRange: '', confidence: 'medium', alternatives: [],
        summary: 'Preview with sample ratings. The live app rates the real book. Try Wonder, Dog Man, The Hunger Games or Harry Potter.',
        ratings: R({ violence: { level: 1, note: 'Sample rating for the preview.' } }) };
      result.custom = body.custom ? { query: body.custom, present: !!(b && b.magic && /magic|witch|wizard/i.test(body.custom)), note: b && b.magic && /magic|witch|wizard/i.test(body.custom) ? 'Magic and wizardry are central to the story.' : '' } : null;
      let remaining = null, mode = partner ? 'partner' : (pass && !isPack) ? 'pass' : (isPack && used() >= ALLOW()) ? 'pack' : 'free';
      if (mode === 'free') { setUsed(used() + 1); remaining = Math.max(0, ALLOW() - used()); }
      if (mode === 'pack') { packLeft -= 1; window.__packLeft = packLeft; }
      return res({ result, mode, remaining, allowance: mode === 'free' ? ALLOW() : undefined, ck: 'a'.repeat(64), credits: mode === 'pack' ? packLeft : undefined });
    }
    return res({ error: 'not_found' }, 404);
  };
})();
