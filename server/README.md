# STO server

Phase 0 Worker: Captain / System / Encounter / World Durable Objects + playtest SPA in `public/`.

## Deploy / initialize

```bash
npm install
npm test
npm run typecheck
npm run db:migrate:local   # apply D1 migrations (accounts, sessions, magic_links, projections)
npm run dev                # wrangler dev — ENVIRONMENT=development by default
npm run test:e2e           # Playwright: full sign-in + dock/market/travel loop against a real dev server
```

Production (sketch):

```bash
# Set ENVIRONMENT=production (disables /admin/bootstrap and other admin endpoints)
# Apply D1 migrations remotely, then:
npm run deploy
```

## Auth

Phase 0 uses email magic-link + HttpOnly `sto_session` cookie (D1 `accounts` / `sessions` / `magic_links`).

1. `POST /auth/request-link` `{ "email": "…" }`
2. In development the response includes `magicLinkToken` (no mail provider yet)
3. `POST /auth/verify` `{ "token": "…" }` sets the session cookie and ensures a human Captain DO
4. Player mutations under `/captains/:id/…` require session ownership

## Play loop

1. Sign in → (dev) **Initialize galaxy** seeds systems + NPCs and starts ambient World DO alarms
2. Dock: refuel / repair / upgrade ship / market trade
3. Travel → advance approach → **Scan for traffic** runs ambient tick + window match
4. Encounter actions; disconnect grace uses Durable Object alarms

Ruleset pin: `@sto/ruleset-phase0-v1` (never edit baseline for balance).
