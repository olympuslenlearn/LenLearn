# LenLearn LMS

A secure Learning Management System built for Glendale School — role-based Admin, Faculty, and Student portals with an AI-powered plagiarism checker, a browser-restricted quiz engine (Quiz Session Guard), full audit logging, and automated backups.

**Full title:** *LenLearn: A Secure LMS with Monitoring Records and AI-Powered Plagiarism Checker for Glendale School Using Browser-Based Restriction*

| | |
|---|---|
| **Frontend** | React 19 + Vite 8 + Tailwind CSS 4 |
| **Backend** | Node.js (Express 4) + Better Auth 1.6 |
| **Database** | PostgreSQL 15+ (single database for auth and all LMS data) |
| **Hosting** | DigitalOcean App Platform · Cloudflare (DNS/SSL) · Resend (email) |
| **AI** | Local transformer embeddings (free) or OpenAI Embeddings API (optional) for the plagiarism checker |

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Environment Variables](#environment-variables)
5. [Running the Project](#running-the-project)
6. [Database](#database)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Maintenance](#maintenance)
10. [Command Reference](#command-reference)
11. [Project Structure](#project-structure)
12. [Security Features](#security-features)
13. [Troubleshooting](#troubleshooting)

---

## How It Works

LenLearn runs as **one Node.js process** that serves both the REST API and the built React single-page app. In production it sits behind Cloudflare (DNS + SSL) and runs on DigitalOcean App Platform; PostgreSQL, file storage, and email are all separate managed services it talks to over the network.

```mermaid
flowchart LR
    Browser["Browser\n(Admin / Faculty / Student)"] -->|HTTPS| CF["Cloudflare\nDNS · SSL · proxy"]
    CF --> App["Node.js process\nExpress API + built React SPA\nDigitalOcean App Platform"]
    App --> DB[("PostgreSQL\nauth + all LMS data")]
    App --> Spaces[("DigitalOcean Spaces\nbackups + uploaded files")]
    App --> Resend["Resend\nOTP + password-reset email"]
```

### Roles and portals

| Role | What they do |
|---|---|
| **Institute Admin** | Manage faculties, students, sections, subjects, curriculum guides, announcements; view audit logs and incidents; run backups; transfer admin access |
| **Registrar** | Limited scope — manage Students and Sections only |
| **Faculty / Teacher** | Create lessons, assignments, activities, and quizzes; grade submissions; run the AI plagiarism checker; view their gradebook |
| **Student** | View subjects and classwork, take quizzes, submit work, check grades and announcements |

### Core modules

- **Authentication & Access Control** — email OTP two-factor authentication (required for every role), role-based access control, account lockout after 5 failed sign-ins
- **Curriculum & Grading** — grade-level curriculum guides whose units connect to specific Subjects and carry their own grading-criteria templates
- **Quiz Engine & Quiz Session Guard** — timed, optionally password-protected quizzes with browser-based exam restriction: fullscreen is enforced and tab-switching is detected and logged with timestamps
- **AI-Powered Plagiarism Checker** — blends lexical similarity (TF-IDF) with semantic similarity from transformer embeddings (self-hosted and free by default, or OpenAI's API if enabled) against web sources found via DuckDuckGo
- **Audit Logging & Incident Response** — every admin, grade, and archive action is recorded with who/what/when
- **Backup & Recovery** — automatic daily/weekly/monthly database backups, synced off the app's own (ephemeral) disk to DigitalOcean Spaces, with an optional Google Drive copy

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>=22 <25` | see `package.json` → `engines` |
| **PostgreSQL** | 15+ | used for both authentication and LMS data — no MySQL/XAMPP component despite the project folder's name |
| **npm** | bundled with Node | — |

## Installation

```bash
# 1. Install dependencies (also applies a required patch to better-auth via patch-package)
npm install

# 2. Create your local environment file
cp .env.example .env
```

Open `.env` and set at minimum:

```env
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/lenlearn_db
BETTER_AUTH_SECRET=          # 32+ random chars — generate below
AES_256_SECRET_KEY=          # 64 hex chars — generate below
SMTP_USER=your.sender@gmail.com
SMTP_PASS=your16charapppassword
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # BETTER_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # AES_256_SECRET_KEY
```

Then create the schema and the first admin account:

```bash
npm run migrate    # Better Auth tables (user, session, account, jwks, ...)
npm run seed       # institute admin account (SEED_ADMIN_* env vars, or defaults)
```

Full walkthrough with troubleshooting, GSuite/Gmail setup, and Google Drive backup config: **[SETUP.md](SETUP.md)**.

## Environment Variables

Only the essentials are shown above. The complete reference — every optional flag, rate-limit setting, and integration — lives in:

- **[`.env.example`](.env.example)** — full local-development reference, heavily commented
- **[`.env.production.example`](.env.production.example)** — production/DigitalOcean reference

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | Encrypts sessions, JWTs, and 2FA secrets |
| `AES_256_SECRET_KEY` | Yes | Encrypts student PII at rest (AES-256-GCM) |
| `BETTER_AUTH_URL` | Auto in dev | Public site origin the browser uses |
| `SMTP_USER` / `SMTP_PASS` | If using email OTP | Sends sign-in codes and password resets |
| `RESEND_API_KEY` / `RESEND_FROM` | Production (recommended) | HTTPS email API — required on hosts that block outbound SMTP (e.g. DigitalOcean) |
| `DO_SPACES_*` | Production | Persists backups/uploads off the app's ephemeral disk |
| `AUTH_DISABLE_SIGNUP` | No (default `true`) | Blocks public registration — accounts are admin-created only |
| `SEED_ADMIN_EMAIL` / `_USERNAME` / `_PASSWORD` | First deploy only | Creates the initial institute admin via `npm run seed` |

## Running the Project

```bash
npm run dev        # starts the API server and the Vite frontend together
```

Watch the terminal for the printed port (defaults to `http://localhost:5173`; the API defaults to port `3001` and is proxied automatically).

| Command | Purpose |
|---|---|
| `npm run dev` | Full local dev environment (API + frontend) |
| `npm run dev:auth` | API server only |
| `npm run dev:web` | Vite frontend only (API must already be running) |
| `npm run build` | Production build of the frontend to `Frontend/dist` |
| `npm run preview` | Preview the production build locally |
| `npm start` | Production entry point — runs migrations, then starts the server |

## Database

All schema changes are versioned SQL files under **`Database/migrations/`** (70+ files), plus the Better Auth CLI for the authentication tables. The server also auto-creates any missing LMS tables on startup as a safety net.

```bash
npm run migrate          # Better Auth tables (user, session, account, jwks)
npm run db:migrate        # Better Auth + LMS migrations together (used by `npm start`)
npm run pg:ping            # test the DATABASE_URL connection
npm run verify:migrations  # verify a specific migration range was applied
```

## Testing

```bash
npm test              # full automated suite (Node.js built-in test runner)
npm run test:verbose  # same suite, spec-style output
npm run lint          # ESLint across the whole project
```

The suite covers authentication, RBAC, curriculum, grades, quizzes, and more — run it before every deploy.

## Deployment

Production runs on **DigitalOcean App Platform**, fronted by **Cloudflare** (DNS + SSL), sending email through **Resend**, and backed by **DigitalOcean Managed PostgreSQL** and **DigitalOcean Spaces** (backups/uploads — the app server's own disk is temporary).

- The deploy spec is committed at **[`.do/app.yaml`](.do/app.yaml)** — DigitalOcean reads it automatically; every push to `main` redeploys (`deploy_on_push: true`).
- Build: `npm install --include=dev && npm run build` — Run: `npm start` (migrates, then serves the API + built frontend on port `8080`).
- Health check: `GET /api/health` → `{"status":"ok","database":"connected"}`.

First-time production setup (run once, from DigitalOcean's Console tab):

```bash
npm run pg:ping
npm run db:seed
npm run ensure:portal-mfa
npm run verify:portal-mfa
```

## Maintenance

**Automatic — no action needed:**

| Frequency | What happens |
|---|---|
| Daily 02:00 / Weekly Sun 01:00 / Monthly 1st 00:00 | Full database backup, synced to DigitalOcean Spaces |
| Every deploy | Pending schema migrations run before the server accepts traffic |

**Periodic — needs a human:**

| Task | Frequency |
|---|---|
| Check DigitalOcean App Platform Insights (CPU, memory, restarts) | Weekly |
| Check database/Spaces storage usage and Resend deliverability | Monthly |
| Update dependencies (`npm outdated`, then `npm test`) | Monthly |
| Rotate DigitalOcean Spaces access keys | Every 6–12 months |
| Restore a backup into a scratch database to confirm it actually works | Quarterly |
| Rotate `BETTER_AUTH_SECRET` (run `npm run auth:clear-jwks` after) | Only if compromise is suspected |

## Command Reference

| Command | What it does |
|---|---|
| `npm run dev` | Local dev environment (API + frontend) |
| `npm run build` | Production frontend build |
| `npm start` | Production entry point (migrate, then serve) |
| `npm run migrate` | Apply Better Auth schema |
| `npm run db:migrate` | Apply Better Auth + LMS migrations |
| `npm run db:seed` | Create/update the institute admin account |
| `npm run pg:ping` | Test the database connection |
| `npm run ensure:portal-mfa` / `verify:portal-mfa` | Enforce and confirm MFA on every account |
| `npm run smtp:test` | Test the Gmail/SMTP fallback (not Resend) |
| `npm run auth:clear-jwks` | Clear JWT signing keys after rotating `BETTER_AUTH_SECRET` |
| `npm test` | Run the full automated test suite |
| `npm run lint` | Run ESLint |
| `npm run ensure:teacher` | Create/update a faculty test account |

## Project Structure

```
LenLearn/
├── Frontend/src/       React UI — Admin, Teacher, and Student portals
├── server/             Express API, Better Auth config, LMS routes
│   ├── api/            REST route handlers, grouped by feature
│   ├── lib/            Shared server logic (DB helpers, storage, mail, backups)
│   └── jobs/           Scheduled jobs (backup scheduler)
├── Database/migrations/  Versioned PostgreSQL schema changes
├── scripts/            One-off and setup scripts (migrate, seed, verify, etc.)
├── docs/               Developer notes, thesis/defense documentation
├── .do/app.yaml         DigitalOcean App Platform deploy spec
├── .env.example          Local development environment reference
└── .env.production.example  Production environment reference
```

## Security Features

- **Multi-Factor Authentication** — email OTP required on every portal role
- **Role-Based Access Control** — enforced server-side on every route, not just in the UI
- **Password Hashing** — bcrypt
- **AES-256-GCM Encryption** — student PII (name, contact info, DOB, address) encrypted at rest
- **TLS in Transit** — Cloudflare Full (strict) SSL to the DigitalOcean origin
- **Audit Trail** — every admin, grade, and archive action logged with user, action, and timestamp
- **Rate Limiting** — dedicated limits on sign-in, OTP, and general API routes
- **Account Lockout** — 5 failed sign-ins locks an account for 5 minutes
- **Security Headers** — Helmet (CSP, HSTS, etc.)
- **Input Sanitization** — server-side sanitization middleware + DOMPurify on the frontend
- **Quiz Session Guard** — fullscreen enforcement and tab-switch detection during timed quizzes

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `DATABASE_URL is not set` / server exits immediately | Create `.env` from `.env.example` and set a real `DATABASE_URL` |
| `npm run pg:ping` fails | PostgreSQL isn't running, or the connection string is wrong |
| 2FA / OTP email never arrives | `SMTP_USER`/`SMTP_PASS` (or `RESEND_API_KEY`) not configured — check the server terminal for `[smtp]` or `[auth]` errors |
| "Failed to decrypt private key" after changing `BETTER_AUTH_SECRET` | Run `npm run auth:clear-jwks`, then restart |
| Uploaded files vanish after a production redeploy | DigitalOcean Spaces isn't configured — the app server's disk is ephemeral |

Full troubleshooting list: **[SETUP.md](SETUP.md) §8**.
