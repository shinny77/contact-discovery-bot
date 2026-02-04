# Contact Discovery Bot

## Overview

Multi-source contact discovery platform for AU/NZ business contacts (v6.8). Aggregates data from Apollo, Lusha, Firmable, and SerpAPI. Used for M&A deal origination and lead enrichment.

## Architecture

Node.js application with multiple interfaces: web app (`webapp-v4.js`, primary), CLI (`cli.js`), and Slack bot (`slack-bot.js`). Plain Express server, no framework.

## Development Commands

- Start (web): `npm start` or `node webapp-v4.js`
- CLI: `node cli.js`
- Slack bot: `node slack-bot.js`
- Test: `node test.js`
- Stats: `node stats.js`
- Watchlist: `node watchlist.js`
- Docker: `docker compose up`

## Key Files

- `webapp-v4.js` - Primary web interface (156KB, latest version)
- `index.js` - Core discovery logic and API integrations (56KB)
- `cli.js` - Command-line interface
- `slack-bot.js` - Slack integration
- `watchlist.js` - Monitoring for target companies/contacts
- `stats.js` - Usage and credit tracking
- `SETUP.md` - Detailed setup and deployment instructions
- `.env.example` - Required environment variables

Older webapp versions (v1, v2, v3) are retained but superseded by v4.

## Modes

1. **Discover** - Full contact lookup for a named person (all sources, costs credits)
2. **Prospect** - Lead search by title/location (Apollo free tier, no credits)
3. **Colleagues** - Find specific roles at a company (Firmable + Apollo)
4. **Company** - Full company intelligence profile with ABN/ACN, employee count, tech stack (Firmable + Apollo)

## Data Sources

| Source | Capability | Cost |
|--------|-----------|------|
| Apollo.io | Candidate discovery, prospecting, free tier search | Credits per enrichment |
| Lusha | Email, phone, personal contact details | Credits per lookup |
| Firmable | Australian company data, ABN-linked profiles | Credits per lookup |
| SerpAPI | LinkedIn profile validation, web search | Per-search pricing |

## Critical Gotchas

- Apollo rate limits: add 200ms delay between batch requests
- Firmable returns ABN-linked data: useful for ASIC cross-referencing
- Lusha is expensive: only call for final shortlisted contacts
- PII handling: contact data must not be committed to the repo
- Multiple webapp versions exist (v1-v4): always use `webapp-v4.js` (the `main` entry in package.json)
- Docker config exists for containerised deployment
- See `SETUP.md` for full environment setup and API key configuration
