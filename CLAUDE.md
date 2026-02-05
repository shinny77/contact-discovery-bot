# Contact Discovery Bot

## Overview

Multi-source contact discovery platform for AU/NZ business contacts (v6.9). Aggregates Apollo, Lusha, Firmable, SerpAPI. Used for M&A deal origination and lead enrichment.

## Architecture

Node.js + Express. Multiple interfaces: web app (primary), CLI, Slack bot.

```
webapp-v4.js (156KB, primary)    Web interface with search, discovery, company intel
index.js (56KB)                  Core discovery logic and all API integrations
cli.js                           Command-line interface
slack-bot.js                     Slack integration
watchlist.js                     Target company/contact monitoring
stats.js                         Usage and credit tracking
```

Older webapp versions (v1-v3) retained but superseded by v4.

## Development Commands

- Start (web): `npm start` or `node webapp-v4.js`
- CLI: `node cli.js`
- Slack bot: `node slack-bot.js`
- Test: `node test.js`
- Docker: `docker compose up`
- Full setup: see `SETUP.md`

## Key Files

- `webapp-v4.js` - Primary web interface (156KB, latest)
- `index.js` - Core discovery logic and API integrations (56KB)
- `watchlist.js` - Monitoring for target companies/contacts
- `stats.js` - Usage and credit tracking
- `SETUP.md` - Full environment setup and API key configuration
- `.env.example` - Required environment variables

## Modes

| Mode | Purpose | Cost |
|------|---------|------|
| Discover | Full contact lookup for a named person (all sources) | Credits |
| Prospect | Lead search by title/location (Apollo free tier) | Free |
| Colleagues | Find specific roles at a company (Firmable + Apollo) | Credits |
| Company | Full company intel: ABN/ACN, employees, tech stack | Credits |

## Data Sources

| Source | Capability | Cost |
|--------|-----------|------|
| Apollo.io | Discovery, prospecting, free tier search | Credits per enrichment |
| Lusha | Email, phone, personal contact details | Credits per lookup |
| Firmable /company | Australian company data, ABN-linked profiles | Credits per lookup |
| Firmable /people | Individual lookup via LinkedIn URL (best AU mobiles) | Credits per lookup |
| SerpAPI | LinkedIn profile validation, web search | Per-search pricing |

## Enrichment Pipeline (v6.9)

```
discoverContact() flow:
  Phase 1: Web search pre-enrichment (SerpAPI)
    - Find LinkedIn URL via site:linkedin.com/in queries
    - Find company domain
    - Name-in-slug confidence gate: reject matches where LinkedIn slug
      does not contain first or last name (prevents false positives)
  Phase 2: API enrichment (parallel)
    - Apollo: name/company match -> email, LinkedIn URL
    - Lusha: name/company match -> email, phone
  Phase 3: Firmable (AU/NZ only, sequential)
    - 3a: /company endpoint (domain-based) -> company info, matching emails
    - 3b: /people?ln_url= endpoint (LinkedIn-based) -> direct email, AU mobile
    - Key: /people endpoint requires LinkedIn URL but returns best AU data
  Phase 4: Consolidation
    - Deduplicate across sources, boost confidence for multi-source matches
    - Flag non-AU phone numbers (confidence reduced by 0.3)
  Phase 5: Validation
    - Email format + deliverability check
    - Phone number format validation
```

Key insights from production testing:
- Apollo matches ~100% by name but only ~25% return LinkedIn URLs
- SerpAPI discovers LinkedIn for ~60% of remaining contacts
- Firmable /people (LinkedIn-based) returns AU mobiles Lusha misses
- Lusha sometimes returns stale UK/US numbers for AU contacts

## Critical Gotchas

- Apollo rate limits: add 200ms delay between batch requests
- Firmable /people requires ln_url param: without LinkedIn URL it cannot be queried
- Firmable /company returns company-level data only (not individual contacts)
- Lusha non-AU phones: +44/+1/+65 numbers flagged, confidence reduced
- LinkedIn slug confidence: profiles rejected if name not found in URL slug
- PII handling: contact data must never be committed to repo
- Always use `webapp-v4.js` (the `main` entry in package.json), not older versions
- Docker config exists for containerised deployment
