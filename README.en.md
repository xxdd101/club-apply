# Club Apply — a generic application & review system

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-2-success.svg)](#)
[![Build](https://img.shields.io/badge/build-none-lightgrey.svg)](#)
[![Stars](https://img.shields.io/github/stars/xxdd101/club-apply?style=social)](https://github.com/xxdd101/club-apply/stargazers)

[简体中文](README.md) | **English**

> 🇨🇳 China mirror (faster access from mainland): [gitee.com/fate101/club-apply](https://gitee.com/fate101/club-apply)

A self-hosted **form + review workflow** system: people fill in an online form and upload attachments,
reviewers approve / reject / send back, and applicants can check their own status.

Built with plain Node.js and vanilla front-end code — **no build step, no database**
(state lives in JSON files), so it runs anywhere Node runs.

> ⭐ **If this project saves you some time, a star would be appreciated** — it helps others
> find the project and tells the author it is worth maintaining.

> This is a **template**. The club name "示例动漫社", the placeholder logo and the sample
> departments are all placeholders — see [Customization](#customization) to make it yours.
> The repository contains **no real applicant data**.

## Use cases

Anything shaped like "collect information → review it → tell the applicant the result":

| Scenario | What to change |
|---|---|
| Club / society recruitment | default configuration |
| Event or contest sign-up | rename "department" to "category", add a "work upload" field |
| Volunteer recruitment | fields become "available slots", "experience" |
| Supplier onboarding | fields become "company name", "business licence upload" |
| Internal approval (leave, expenses, venue) | fields become "reason", "amount", "attachment" |
| Artwork / submission collection | keep the upload fields, review as approve / reject |

Compared with a plain form builder, it adds a real **review state machine**
(pending → approved / rejected / returned → resubmitted → escalated → intervened),
self-service status lookup, image & audio uploads, Excel export with images embedded,
multiple reviewers with fine-grained permissions, and it keeps all data on your own server.

## Features

- **26 questions by default**, driven entirely by `config/form.json`
- Conditional fields (`showIf`), e.g. an upload question only appears for certain categories
- Image / audio attachments with preview, size and duration checks
- Review workflow: approve, reject with a reason, return for revision, escalate, intervene
- Max 2 resubmissions per application, with identity re-check
- "Nudge the reviewer" with a cooldown
- Role-based accounts: super admin + sub-reviewers, 5 granular permissions
- System switch: running / paused (still accepts) / stopped (submissions get HTTP 403)
- Excel export with artwork images embedded in cells
- Daily scheduled reboot (optional), server info page, audit log

## Quick start

Requires **Node.js ≥ 18**.

```bash
npm install
npm start
# http://localhost:3000
```

| URL | Page |
|---|---|
| `/` | application form |
| `/status` | status lookup |
| `/admin` | reviewer console |

First run creates a super admin: `admin` / `change-this-password` (override with `ADMIN_PASS`).
**Change it immediately after logging in.**

Want demo rows to look at?

```bash
npm run seed
```

## Customization

### Change the questions

Everything is in **`config/form.json`**:

```json
{
  "no": "03",
  "id": "school",
  "type": "text",
  "label": "Which school are you in?",
  "adminLabel": "School",
  "required": true,
  "maxLength": 50,
  "placeholder": "e.g. Example University"
}
```

Supported `type` values: `text`, `textarea`, `number`, `radio`, `choice-grid`, `region`
(province/city cascade, Chinese administrative data), `images`, `audio`.

Conditional display:

```json
{ "id": "experienceDesc", "type": "textarea", "label": "Describe your experience",
  "required": true, "showIf": { "field": "hasExperience", "in": ["Yes"] } }
```

The form rendering, client-side validation, server-side validation, admin detail page and
Excel export are all generated from this one file.

### Change the branding

Replace the three images in `public/img/` (keep the file names) and search/replace the name:

```bash
grep -rl "示例动漫社" public lib server.js deploy | xargs sed -i 's/示例动漫社/Your Club Name/g'
```

### Theme

Edit the CSS variables at the top of `public/css/style.css` (`--brand`, `--brand-2`, …).

Full Chinese manual (deployment, day-to-day operations, FAQ, backup) → [USAGE.md](USAGE.md).

## Deployment

```bash
# Ubuntu / Debian, one command
sudo ADMIN_PASS='a-strong-password' bash deploy/install-ubuntu.sh
```

It installs Node.js, creates the `club-apply` system user, copies the code to `/opt/club-apply`,
installs dependencies, sets up systemd with autostart, and opens the firewall.

Reverse proxy sample: `deploy/nginx-club.conf` (remember `client_max_body_size 40m`).
Put the Node process on `127.0.0.1` and let nginx terminate TLS.

## Data

Everything lives under `data/` (`DATA_DIR`):

```
applications.json  admins.json  review-state.json  reboot-log.json
secret.key  uploads/  thumbs/  server.log
```

Backup is just `tar -czf backup.tgz -C /opt/club-apply data`.
`data/` is git-ignored — it holds **real personal information** of applicants. Never commit it.

## Tests

```bash
node tools/review-state-test.js   # state machine
node tools/api-test.js            # API + permissions (needs a running server on :3100)
node tools/resubmit-test.js
node tools/urge-test.js
node tools/ban-expiry-test.js
node tools/system-test.js
```

## Security notes

- Passwords are hashed with scrypt; login is rate-limited per IP
- Tokens are HMAC-SHA256 signed, secret persisted in `data/secret.key`
- Attachment URLs are signed and expire
- Every admin endpoint re-checks permissions server-side
- Status lookup is exact-match only (no enumeration)

## License

[MIT](LICENSE). The placeholder name and graphics are for demonstration only.
