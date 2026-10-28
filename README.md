# OS Technology website

A lightweight website and enquiry service for OS Technology, an IT hardware and services company in Nepal. It uses only Node.js built-in modules; no dependency installation or third-party font, script, or image requests are required.

## Run locally

Requires Node.js 20 or later.

```sh
npm start
```

Open `http://localhost:3000`. To use another port, set `PORT` before starting the server.

## Enquiries

`POST /api/enquiries` validates and stores enquiries as newline-delimited JSON in `data/enquiries.jsonl`. The data directory and file are created with owner-only permissions. Each record includes a generated ID and received timestamp. The service limits request size, validates fields, uses a honeypot and per-IP rate limit, and rejects cross-origin submissions.

Set `ADMIN_TOKEN` to a random secret of at least 32 characters to enable authenticated access to stored submissions:

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-domain.example/api/enquiries
```

Protect the token as a production secret and limit its use to trusted administrators. Enquiry data contains personal information: restrict server and backup access, set and follow an appropriate retention period, and securely remove records when they are no longer needed. The service does not send email or expose an unprotected admin dashboard.

The storage is suitable for a single Node.js instance with persistent disk. Enquiries are not emailed automatically: an administrator must retrieve them through the token-protected endpoint. For multiple instances or ephemeral hosting, configure persistent storage or replace the JSONL store with a managed database before launch.

## Production setup

Use Node.js 20+, persistent writable storage for `data/`, HTTPS at a reverse proxy or managed host, and set:

- `NODE_ENV=production`
- `SITE_URL=https://your-real-domain.example` (canonical public origin; HTTPS required)
- `ADMIN_TOKEN` (a randomly generated secret with at least 32 characters)
- `PORT` if required by the hosting provider
- `DATA_FILE` if enquiries should be stored on a mounted persistent volume

The server refuses production startup if `SITE_URL` or a sufficiently long `ADMIN_TOKEN` is missing. Keep Node.js and the host patched, configure backups and log retention, and verify that the host's reverse proxy forwards requests only from trusted sources.

## Search visibility and launch checklist

The server serves a canonical URL, Open Graph and Twitter metadata, a descriptive page title and meta description, crawlable service copy, `robots.txt`, an XML sitemap, and Schema.org `ComputerStore` structured data. It avoids client-rendered SEO content and external font downloads. Search engines and AI search tools decide independently what to index or cite; metadata cannot guarantee rankings or inclusion.

Before publishing:

1. Set `SITE_URL` to OS Technology's verified domain.
2. Verify the legal business name, service wording, operating locations, service hours, and supported equipment.
3. Add a real public business email, telephone number, address, and verified business profiles when supplied by the company.
4. Configure a privacy notice and enquiry-data retention process appropriate to the business.
5. Submit the production sitemap in Google Search Console and Bing Webmaster Tools after domain verification.
