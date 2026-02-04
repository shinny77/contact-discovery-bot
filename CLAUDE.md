# Contact Discovery Bot

## Overview

Multi-source contact discovery platform for AU/NZ business contacts. Aggregates data from Apollo, Lusha, Firmable, and SerpAPI. Used for M&A deal origination and lead enrichment.

## Architecture

Node.js application with multiple interfaces: CLI (`cli.js`), web app (`webapp-v4.js`), and Slack bot (`slack-bot.js`). No framework: plain Express.

## Development Commands

- CLI: `node cli.js`
- Web: `node webapp-v4.js`
- Slack: `node slack-bot.js`
- Test: `node test.js`
- Stats: `node stats.js`
- Watchlist: `node watchlist.js`

## Key Files

- `index.js` - Core discovery logic and API integrations
- `webapp-v4.js` - Latest web interface version
- `cli.js` - Command-line interface
- `slack-bot.js` - Slack integration
- `watchlist.js` - Monitoring for target companies/contacts
- `stats.js` - Usage and credit tracking

## Data Sources

| Source | Capability | Cost |
|--------|-----------|------|
| Apollo.io | Candidate discovery, prospecting, free tier search | Credits per enrichment |
| Lusha | Email, phone, personal contact details | Credits per lookup |
| Firmable | Australian company data, ABN-linked profiles | Credits per lookup |
| SerpAPI | LinkedIn profile validation, web search | Per-search pricing |

## Modes

1. **Discover** - Full contact lookup (all sources, costs credits)
2. **Prospect** - Lead search by title/location (Apollo free tier, no credits)
3. **Colleagues** - Find specific roles at a company (Firmable + Apollo)

## Critical Gotchas

- Apollo rate limits: add 200ms delay between batch requests
- Firmable returns ABN-linked data: useful for ASIC cross-referencing
- Lusha is expensive: only call for final shortlisted contacts
- PII handling: contact data must not be committed to the repo
- Multiple webapp versions exist (v1-v4): always use `webapp-v4.js`
- Docker config exists but primary use is direct `node` execution
