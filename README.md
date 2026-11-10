# BookNod

**Scan a book. Get a nod, or a no.**

BookNod helps parents decide, in seconds, whether a book suits their child. Scan the barcode, snap the cover or type the title, and BookNod rates it across ten content areas (profanity, violence, sexual content, romance, bullying, self-harm, scary content, drugs and alcohol, death, rude behaviour) and checks it against **your** rules for **each** reader: **Read**, **Skip** or **Check**.

> **Just want to use it?** [booknod.ca](https://booknod.ca) is the ready-made version: nothing to set up, free daily check, Family Pass for unlimited checks.
> This repository is for people who want to run their own copy for themselves, their family, school or library.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/booknod)

## What it does

- **Phone-first web app** that installs to the home screen; live barcode scanning with the camera, or a cover photo.
- **Readers:** each child has their own name, age and rules (None / Mild / Some / Any per category), plus an "anything else to avoid" note.
- **Private by design:** no accounts. Readers, ages, rules and history stay on the phone. The server only sees the book being checked.
- **Shared ratings cache:** once any family checks a book, everyone else gets the saved answer instantly, at no AI cost.
- **Built-in business model (optional):** a free daily allowance, a Family Pass subscription (yearly/monthly) and pay-as-you-go check packs through Stripe Payment Links, plus a tip link.
- **Partner editions:** a library or school gets its own link, colours and a "Find it at the library" catalogue button.
- **Protection against abuse:** invisible Cloudflare Turnstile bot check, per-phone and per-address limits, daily caps.
- **Private stats page** at `/stats`: checks, AI cost, sales, active phones, cities, devices, busiest hours, most-checked and not-found books. Totals only.

It runs as a single **Cloudflare Worker** (the free plan is enough to start) using **Claude** from Anthropic to rate books, and **Open Library** to look up ISBNs.

## Run your own copy

You'll need a Cloudflare account (free) and an Anthropic API key. Stripe is only needed if you want to charge.

### Option A: the Deploy button

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repository to your GitHub account, creates the Worker and its storage, and deploys it.
2. In the Cloudflare dashboard, open your Worker → **Settings → Variables and Secrets** and add the Secret `ANTHROPIC_API_KEY`.
3. Open your Worker's address and check a book.

### Option B: from your own GitHub repository

1. Fork this repository (or upload it to a new one).
2. Create a KV namespace (**Storage & Databases → KV → Create**) and put its ID in `wrangler.toml`.
3. In Cloudflare: **Workers & Pages → Create → Import a repository**, pick your repository, keep the deploy command `npx wrangler deploy`.
4. Add `ANTHROPIC_API_KEY` as a Secret. From then on, every push to `main` deploys automatically.

### Option C: the command line

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BOOKNOD_KV     # paste the ID into wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

### Try it locally with no keys

```bash
npm install
npm run dev        # http://localhost:8787, sample ratings, fake payments (MOCK=1)
```

`npm run build` also writes `dist/booknod-preview.html` and `dist/booknod-partner-preview.html`, clickable previews that run in any browser without a server. In mock mode, a title containing "notfound" behaves like an unknown book.

## Settings

All settings live in the Cloudflare dashboard (**Settings → Variables and Secrets**), never in the code. `keep_vars = true` in `wrangler.toml` keeps them when you redeploy. Only `ANTHROPIC_API_KEY` and the `BOOKNOD_KV` binding are required.

| Name | Type | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secret | **Required.** Rates books. Set a monthly spend limit in the Anthropic Console. |
| `MODEL` | Text | Claude model (default `claude-sonnet-5-5`). |
| `FREE_PER_DAY` | Text | Free checks per phone per day (default `1`). Days roll over at midnight Toronto time; change `TZ` in `src/worker.js` for another zone. |
| `STRIPE_SECRET_KEY` | Secret | Restricted key with **read** access to Checkout Sessions and Subscriptions. |
| `PASS_YEARLY_URL`, `PASS_YEARLY_PRICE` | Text | Stripe Payment Link for a yearly subscription, and its button label (e.g. `$99.99/year`). |
| `PASS_MONTHLY_URL`, `PASS_MONTHLY_PRICE` | Text | Same for monthly (e.g. `$9.80/month`). |
| `PASS_SAVINGS` | Text | Tag on the yearly button (e.g. `Save 15%`). |
| `MANAGE_URL` | Text | Stripe customer portal login link, for "Manage or cancel your plan". |
| `PACK_URL`, `PACK_PRICE`, `PACK_CHECKS` | Text | Pay-as-you-go: a **one-time** Stripe Payment Link, its label and how many checks it adds (default `10`). Any one-time payment is treated as a pack. |
| `COMP_CODES` | Text | Free pass codes, comma-separated, 8+ characters. `CODE:200` lets a code work on 200 phones (default 5). |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | Text + Secret | Cloudflare Turnstile bot check. Strongly recommended for a public site. Your own domain only. |
| `RATE_LIMIT_PER_HOUR`, `IP_LIMIT_PER_HOUR` | Text | Checks per phone (40) and per internet address (60) each hour. |
| `DAILY_CAP` | Text | Most paid-for checks per day across everyone. |
| `STATS_KEY` | Secret | Password (12+ characters) for the private stats page at `/stats`. |
| `TIP_URL` | Text | Tip page link (Ko-fi, Buy Me a Coffee…). |
| `CONTACT_EMAIL`, `OPERATOR` | Text | Shown on the Privacy & Terms page (`/privacy`), e.g. `hello@example.com` and `Example Books, Ontario, Canada`. |
| `PARTNERS_JSON` | Text | Partner editions. See below. |

Optional binding: a Rate Limiting binding named `CHECK_LIMITER` for instant burst limits.

**Stripe Payment Links** must redirect after payment to `https://YOUR-SITE/?session_id={CHECKOUT_SESSION_ID}`. That's how a purchase is confirmed and switched on, with no accounts.

## Partner editions

Set `PARTNERS_JSON` to give a library or school its own link at `https://YOUR-SITE/<slug>`:

```json
{"mylib": {"name": "My Public Library", "short": "MPL", "tagline": "Free for MPL families",
  "accent": "#00587C", "accentDark": "#6FC3E3",
  "catalogue": "https://catalogue.example.org/search?q={q}",
  "unlimited": false, "country": "CA", "regions": ["Springfield"],
  "perPhone": 20, "dailyCap": 2000, "demo": true}}
```

- `unlimited: true` gives visitors on that link unlimited checks (the partner pays you instead), but only for connections from the listed `regions` cities, up to `perPhone` a day each and `dailyCap` in total.
- `demo: true` shows a "Preview, not affiliated" banner. Keep it until there's a signed agreement.
- `{q}` in `catalogue` becomes the book's title and author.

## Project layout

```
src/worker.js        API and server (rating, limits, payments, stats)
public/              the app: index.html, privacy.html, stats.html, icons, manifest, service worker
preview/mock.js      stand-in server for the offline previews
build.mjs            bundles public/ into dist/worker.js (runs before every deploy)
wrangler.toml        Cloudflare config (safe to publish: no secrets)
```

## Privacy

Out of the box, BookNod keeps readers, ages, rules and history on the phone; the server receives the title, ISBN or cover photo, the "anything else to avoid" note, a random phone ID and the connection's address. Stats are daily totals with no names, emails or exact locations. If you run a public copy, review and adapt `public/privacy.html` for your service and the law where you operate. It's a starting point, not legal advice.

## Ratings disclaimer

Ratings are generated automatically from what's known about each book and can be incomplete or wrong. BookNod says so on every result.

## Licence

Copyright © 2026 BookNod. Released under the **Functional Source License 1.1, Apache 2.0 Future License** (FSL-1.1-ALv2, see [LICENSE](LICENSE)).

In plain terms (the licence text is what counts):

- **You can** use, change and share it for yourself, your family, your school, your library or your organisation's internal use, and for non-commercial education and research.
- **You can't** offer it, or something substantially similar built from it, as a **competing commercial product or service**.
- **Two years after each version is published**, that version becomes available under the Apache License 2.0, with no restrictions on competing use.

BookNod is therefore *source available*, not "open source" in the OSI sense, until each version's two years are up.

The **BookNod** name and logo are not licensed for your use. See [TRADEMARKS.md](TRADEMARKS.md): please give your copy its own name.

## Contributing

Issues and pull requests are welcome, but this is maintained in spare time and comes with no support promise. For security problems, see [SECURITY.md](SECURITY.md).
