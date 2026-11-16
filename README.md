# Maltby Mavericks website

Website for 5th Rotherham (Maltby) Scout Group, www.maltbyscouts.org.

| Folder | What it is |
|---|---|
| `site/` | The website: a [Zola](https://www.getzola.org) static site (Zola **0.23**, which uses Tera 2 templates and components) |
| `worker/` | Cloudflare Worker that receives the contact and join forms and emails them on |
| `tools/` | One-off migration script from the old Scout Websites site, and an image optimiser |
| `.github/workflows/site.yml` | Builds the site, checks images and links, runs Worker tests, and deploys to GitHub Pages |

## Editing the site

```sh
cd site
zola serve          # http://127.0.0.1:1111 with live reload
```

- **News article:** add `site/content/news/article/<slug>.md`:

  ```toml
  +++
  title = "Cubs camp 2027"
  date = 2027-05-20
  description = "One-line summary used on cards and when shared on Facebook."

  [taxonomies]
  news_tag = ["Cubs"]          # Squirrels, Beavers, Cubs, Scouts, Community, ...

  [extra]
  author = "Akela"
  image = "/images/uploads/cubs-camp-2027.jpg"   # card + social preview image
  +++
  Article text in Markdown...
  ```

  Put photos in `site/static/images/uploads/` and **run the image optimiser before committing**
  (CI rejects photos that still contain GPS location data or are larger than 1600px):

  ```sh
  python -m venv .venv && .venv/Scripts/pip install -r tools/migrate/requirements.txt
  .venv/Scripts/python tools/optimise_images.py site/static/images
  ```

- **Pages** are Markdown files under `site/content/`. The URL follows the file path.
- **Menu, address, social links, section list:** `[extra]` in `site/config.toml`.
- **Team list on About Us:** `members` in the front matter of `site/content/about-us.md`.
- Old URLs are kept working with `aliases = [...]` in front matter (Zola writes a redirect page).

Templates live in `site/templates/`. Reusable bits are Tera components in `components.html`
(called like `{{<page_header title={page.title} />}}`), and styles are in `site/sass/style.scss`.

## Forms

The contact and join forms are plain HTML forms that post to the Worker (`forms_endpoint` in
`site/config.toml`). The Worker:

1. checks the post came from our site, a hidden honeypot field is empty, and the
   [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) check passed
2. validates the fields
3. sends email through [Resend](https://resend.com) from `forms@maltbyscouts.org` (a send-only address, no mailbox needed)
4. redirects back to `/join/thanks/`, `/contact/thanks/`, or the form with `?error=...`

**Join form → OSM script:** the email to `JOIN_SCRIPT_TO` (maltbywaiting@gmail.com) has the
plain-text body in exactly the old Scout Websites format, e.g.

```json
{ "entry_id": "1001", "join_type": "Young Person", "parent_name": "...", "young_persons_name": "...", "adults_name": "", "date_of_birth": "12/12/2022", "email_address": "...", "telephone_number": "...", "address_1": "...", "address_2": "", "post_code": "S62 2DJ", "city": "Rotherham", "country": "United Kingdom" }
```

`entry_id` is a counter kept in Workers KV, starting after `ENTRY_ID_START`. Volunteering interests
aren't in that body (the old one didn't have them). They go in the optional human-readable copy
sent to `JOIN_NOTIFY_TO`.

**Contact form** goes to `CONTACT_TO` (the leaders list), with Reply-To set to the enquirer.

### Worker setup (once)

You need a free Cloudflare account and a free Resend account.

```sh
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create COUNTER     # paste the id into wrangler.toml
npx wrangler secret put TURNSTILE_SECRET     # from Cloudflare dashboard → Turnstile → add widget for www.maltbyscouts.org
npx wrangler secret put RESEND_API_KEY       # from Resend, after verifying the domain (below)
npx wrangler deploy
```

Then fill in `CONTACT_TO`, `JOIN_NOTIFY_TO` and `ENTRY_ID_START` in `wrangler.toml`, and put the
Turnstile **site** key in `site/config.toml` (`turnstile_site_key`). The secret key must never go in the repo.

- **Resend domain:** add `maltbyscouts.org` in Resend and create the DNS records it gives you
  (SPF/DKIM TXT records, plus an MX record on a `send.` subdomain). Add a DMARC record too if
  there isn't one: `_dmarc TXT "v=DMARC1; p=none;"`.
- **`forms.maltbyscouts.org`:** `wrangler.toml` uses a Workers custom domain, which needs the domain's DNS on
  Cloudflare (free plan is fine). If DNS stays elsewhere, delete `routes` from `wrangler.toml` and use the
  `https://maltbyscouts-forms.<account>.workers.dev` URL as `forms_endpoint` instead.

Local testing: `npm run dev` with a `worker/.dev.vars` file containing
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA` (Cloudflare's always-pass test secret),
a real or dummy `RESEND_API_KEY`, and `EXTRA_ORIGINS=http://127.0.0.1:1111`. Unit tests: `npm test`.

## Hosting (GitHub Pages)

1. Push this repo to GitHub. On the free plan Pages needs a public repo. Nothing secret is committed.
2. **Settings → Pages → Source: GitHub Actions.** Pushes to `main` then deploy automatically.
3. **Settings → Pages → Custom domain:** `www.maltbyscouts.org`, then tick *Enforce HTTPS* once the certificate is issued.
   (`site/static/CNAME` already contains the domain.)
4. DNS:
   - `www` → `CNAME` → `<github-user-or-org>.github.io`
   - apex `maltbyscouts.org` → `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
     (GitHub then redirects the apex to `www`).

## Go-live checklist

- [ ] Review the migrated pages, especially `privacy-policy.md` and `cookies.md`. They still describe
      Google Analytics, and should now name Cloudflare (forms/Turnstile), Resend (email) and Gmail (waiting list mailbox).
      The new site sets no cookies of its own. Turnstile may set a strictly-necessary one.
- [ ] Decide whether `/training` (leader training links) should stay public, and link to it if so.
- [ ] Set `ENTRY_ID_START` above the last entry id the old site produced.
- [ ] Update the OSM import script's filter for the new sender (`forms@maltbyscouts.org`) and subject (`JOIN_SUBJECT`).
- [ ] Submit a test join and a test contact enquiry end to end, and confirm the OSM import works.
- [ ] Lower DNS TTLs a day before switching, then point DNS at GitHub Pages.
- [ ] Check the old Scout Websites notice period, and that nothing else (email, shop/cart, District links) depends on it, before cancelling.
- [ ] Optionally replace `images/brand/scouts-logo-standard.svg` with the group's own logo from the [Scouts brand centre](https://scouts.org.uk/brand).

## Re-running the migration

`tools/migrate/migrate.py` pulls pages from the old site's WordPress REST API and scrapes the news
articles. It overwrites the generated content files, so only re-run it before making manual edits.
`_index.md`, `join/`, `contact/` and the news section index were written by hand and are never touched.
