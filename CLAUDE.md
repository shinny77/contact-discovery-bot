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
| Firmable /company | GET ?website= or ?ln_slug=. Bearer auth. AU company data, ABN-linked | Credits per lookup |
| Firmable /people | GET ?work_email= (most reliable) or ?ln_slug= or ?id=. Bearer auth | Credits per lookup |
| Firmable /people/search | POST JSON body. Numeric seniority (1-7) + dept (1-17) IDs. Requires companyId anchor | Credits per search |
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
  Phase 3: Firmable (AU/NZ only, sequential, Bearer auth)
    - 3a: GET /company?website= or ?ln_slug= -> company info, companyId
    - 3b: GET /people?work_email= (most reliable) or ?ln_slug= -> direct email, AU mobile
    - 3c: POST /people/search body: {companyId, seniority: "3", department: "14", size: "10"}
         Seniority: 1=Board 2=Founder 3=C-Suite 4=VP/Director 5=Manager 6=Other
         Department: 1=GenMgmt 2=Sales 5=Engineering 6=HR 14=Finance (numeric IDs only)
    - Key: work_email is most reliable people lookup param; ln_slug coverage is patchy
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
- Firmable /people: work_email is most reliable param; ln_slug returns "not found" for many profiles
- Firmable /company: GET ?website= or ?ln_slug= returns company-level data + companyId for people/search
- Firmable /people/search: POST requires companyId anchor; seniority + dept cross-filter without companyId returns zero
- Firmable auth: Authorization: Bearer fbl_xxx header (not x-api-key)
- Lusha non-AU phones: +44/+1/+65 numbers flagged, confidence reduced
- LinkedIn slug confidence: profiles rejected if name not found in URL slug
- PII handling: contact data must never be committed to repo
- Always use `webapp-v4.js` (the `main` entry in package.json), not older versions
- Docker config exists for containerised deployment
