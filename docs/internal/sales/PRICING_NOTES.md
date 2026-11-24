# Pricing notes (internal)

> **Internal.** The cost model behind [mailharbor-pricing-standard.pdf](mailharbor-pricing-standard.pdf) (standard) and [mailharbor-pricing.pdf](mailharbor-pricing.pdf) (with the Pilot programme). Both are built from
> `mailharbor-pricing.html`; rebuild both with `cd portal && npm run brochure -- pricing`). The prices are **suggestions**: adjust
> them here first, then in the HTML. Researched 23 Nov 2026; check rates again before quoting.

## Inputs

| Input | Value | Source / note |
|---|---|---|
| Railway Pro | $20/month per workspace, includes $20 of usage; **already paid** (existing account) | railway.com pricing. One workspace holds every customer project, so per customer only usage counts |
| Railway compute | $20 per vCPU-month, $10 per GB RAM-month, billed per minute | Railway docs |
| Railway volume storage | ~$0.15 per GB-month; egress $0.05 per GB | Railway docs |
| Backup storage (Cloudflare R2) | $0.015 per GB-month, no egress fees; first 10 GB free | Cloudflare R2 pricing |
| Exchange rate | R17.40 per US$ | Market rate 23 Nov 2026 (17.39–17.48); the rand weakened ~4.5% in the month before |
| Your time | R850 per hour | Salaried senior developers average ~R630/hour (Payscale); contract rates must also cover tax, leave and unbilled time |
| Market reference | ~R1,500/month for 10,000 contacts (Everlytic, unverified secondary source) | Treat as indicative only |

## Hosting: cost per customer per month

Usage estimates for one instance (MailHarbor service + PostgreSQL + daily backup job), averaged over a month. These are
estimates; **measure real usage** on the first customers (Railway → project → Usage) and correct this table.

| Plan | Railway usage (est.) | Backups | Ops time (monitoring, updates, restore tests, alerts) | **Cost** | Price | Margin |
|---|---|---|---|---|---|---|
| Starter (≤10k contacts) | ~$20 (≈0.25 vCPU, 0.75 GB RAM, 5 GB volume) ≈ R350 | ~R5 | 0.75 h ≈ R640 | **≈ R1,000** | R1,350 | ≈ 26% |
| Growth (≤50k) | ~$40 ≈ R700 | ~R10 | 1 h ≈ R850 | **≈ R1,560** | R2,450 | ≈ 36% |
| Scale (≤250k) | ~$90 ≈ R1,570 | ~R25 | 1.5 h ≈ R1,275 | **≈ R2,870** | R4,650 | ≈ 38% |

- Ops time is the real cost driver at small sizes; Starter's margin is thin by design, as an entry point.
- Shared costs not in the table: the Railway Pro fee (already paid; covers usage up to $20 across all projects),
  uptime monitoring tool, your password manager and helpdesk tool. Spread them across customers once known.
- Exchange rate risk: a 10% weaker rand adds ~R35–R160 a month per instance. The terms allow a review after a >10% move.

## Installation

| | Effort (hours) | At R850/h | Development contribution | **Price** |
|---|---|---|---|---|
| Standard | ~22 h: provisioning (3), mail/DNS/mailboxes (4), email design (2), import (4), users (1), training (4), go-live + first campaign (4) | R18,700 | ~R15,800 | **R34,500** |
| Migration | ~38 h: Standard + migration and suppression carry-over (8), sign-up forms (4), extra training and campaigns (4) | R32,300 | ~R22,200 | **R54,500** |

The development contribution is the part of installation that recovers the cost of building MailHarbor. Over
10 customers it recovers roughly R160k–R220k.

## Pilot programme (invitation only)

Replaces the earlier "founding customers 40% off" idea. Pilots are deliberately **below cost**: an investment in
feedback, references and first real usage, not a revenue line.

| | Pilot price | Cost to deliver | Difference |
|---|---|---|---|
| Installation (reduced scope: one import, one training session) | R7,500 | ~14 h ≈ R11,900 | −R4,400 |
| Monthly (hosting + Essential support, ≤5k contacts) | R1,250 | Railway ~R260 + backups ~R5 + ops 0.5 h ≈ R425 + helpdesk and feedback call ~1 h ≈ R850 → **≈ R1,540** | −R290 a month |
| 6-month pilot in total | R15,000 | ≈ R21,140 | **≈ −R6,100 per pilot** |
| After the pilot (25% off Starter + Essential for 12 months) | R2,850 a month | | R11,400 of list price forgone in year one |

- With the 5-pilot cap, the programme costs roughly **R30k** in delivery below cost, plus discounts on conversion.
- Guardrails written into the PDF: invitation only, max 5, not transferable, 6 months (one extension of up to 3 months),
  5,000 contacts / 25,000 emails a month, monthly feedback call, reference and case study.
- The limits keep Railway usage near the minimum. If a pilot outgrows them, move them to a standard plan early.
- Decide upfront what a successful pilot is (for example, 3 real campaigns sent and a reference), and choose pilots that
  are likely to convert.

## Development & Support

| Plan | Included time | Helpdesk / on-call cost | Value of included hours (R850) | **Price** | Left for roadmap development |
|---|---|---|---|---|---|
| Essential | 2 h | ~R600 (monitored helpdesk, triage) | R1,700 | **R2,450** | small; mostly funds fixes and releases |
| Professional | 8 h + quarterly review (~1 h/month) | ~R900 | R7,650 | **R5,450** | priced **below** hours value: expect ~60–70% of hours to be used |
| Partner | 20 h + account management (~2 h) | ~R1,500 | R18,700 | **R10,950** | as above; assumes partial use and longer commitments |

- Included hours are the main risk. If customers use all of them every month, Professional and Partner run at a loss
  against R850/hour. Either track usage for 3 months and adjust, or price them at full value (Professional ≈ R8,500,
  Partner ≈ R19,500).
- New features built for one customer go into MailHarbor for everyone. That is the basis of the "continued development"
  value.

## Open decisions

1. **Licence vs ownership.** The PDF says installation gives the customer the right to use MailHarbor while hosted, and
   that MailHarbor stays yours. If customers should instead *own* their copy (source code), installation must be priced
   as custom development, likely R250k+, and that copy cannot be resold. Decide before the first quote.
2. **Hosting region and POPIA section 72.** Railway regions are outside South Africa (US, EU, Asia). Choose a region
   (EU West keeps data under GDPR, which helps the s72 cross-border test) and state it in the agreement.
3. **Support plan required with hosting:** the PDF says yes (minimum Essential). Change it there if you prefer otherwise.
4. **Pilot programme:** price (R7,500 + R1,250 a month), cap (5), length (6 months) and the 25% conversion discount are
   suggestions; adjust them in the PDF's page 5 and here together.
