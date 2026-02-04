# Contact Discovery Bot

## Overview

Multi-source contact discovery platform for AU/NZ business contacts (v6.8). Aggregates Apollo, Lusha, Firmable, SerpAPI. Used for M&A deal origination and lead enrichment.

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
| Firmable | Australian company data, ABN-linked profiles | Credits per lookup |
| SerpAPI | LinkedIn profile validation, web search | Per-search pricing |

## Critical Gotchas

- Apollo rate limits: add 200ms delay between batch requests
- Firmable returns ABN-linked data: useful for ASIC cross-referencing
- Lusha is expensive: only call for final shortlisted contacts
- PII handling: contact data must never be committed to repo
- Always use `webapp-v4.js` (the `main` entry in package.json), not older versions
- Docker config exists for containerised deployment
