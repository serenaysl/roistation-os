# Security Policy

## Supported versions

Only the latest release on the `main` branch receives security fixes.

| Version | Supported |
|---|---|
| 1.7.x | ✅ |
| < 1.7 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's **Security → Report a vulnerability** (private vulnerability reporting) on this repository. Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected endpoints, files or configuration,
- any suggested mitigation.

You can expect an acknowledgement within **3 business days** and a status update within **10 business days**. Please give reasonable time for a fix before any public disclosure; credit is given in the changelog unless you prefer otherwise.

## Scope

In scope:

- authentication and session handling (`lib/admin.ts`, `app/api/session`),
- authorization of route handlers and public read APIs,
- token sealing and storage (`lib/crypto-box.ts`, `lib/vercel/credentials.ts`, `lib/github/credentials.ts`),
- webhook and cron verification,
- the connector kit and widget (`connectors/`, `public/widget.js`, `app/embed`),
- server-side requests to client sites (host allow-listing, redirects, timeouts).

Out of scope: vulnerabilities in third-party services (Vercel, GitHub, Google, Anthropic, OpenAI), denial of service through volumetric traffic, and findings that require a compromised administrator account or deployment environment.

## Security model in brief

- A single administrator signs in with a password; sessions are HMAC-SHA256 signed cookies (`httpOnly`, `sameSite=strict`, `secure` on Vercel, 8 hours).
- Every mutating admin request must come from a trusted origin (`MASTER_PUBLIC_URL` or the Vercel deployment URLs).
- Login and public form submissions are rate-limited.
- Vercel and GitHub tokens are sealed with AES-256-GCM using a key derived from `PANEL_SESSION_SECRET` and are never returned to the browser.
- Cron calls require `CRON_SECRET`; webhooks require a valid `x-vercel-signature`.
- Public APIs return published content only; private Blob URLs and tokens never reach the browser.
- The panel page sends `frame-ancestors 'none'`; responses carry `nosniff` and a strict referrer policy.

Details: [docs/Authentication.md](docs/Authentication.md) and [docs/Permissions.md](docs/Permissions.md).

## Operator checklist

- Use a long, unique `PANEL_ADMIN_PASSWORD` and a random `PANEL_SESSION_SECRET` of at least 32 characters.
- Use a **private** Blob store; never reuse a public media store.
- Scope the GitHub token to the client repositories with *Contents* and *Pull requests* read/write only.
- Rotate `PANEL_SESSION_SECRET` to end all sessions (stored Vercel/GitHub tokens must then be reconnected).
