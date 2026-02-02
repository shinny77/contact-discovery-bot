# Contact Discovery Bot v6.4

Multi-source contact discovery for AU/NZ business contacts.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

## Features

| Feature | Web Tab | Slack Command | API |
|---------|---------|---------------|-----|
| Person Lookup | 👤 Discover | `/discover Tom Cowan, TDM` | GET /api/discover |
| Lead Search | 🎯 Prospect | `/prospect CEO Sydney 10` | POST /api/prospect |
| Find Colleagues | 👥 Colleagues | `/colleagues atlassian.com CFO` | POST /api/colleagues |
| Company Intel | 🏢 Company | `/company atlassian.com` | GET /api/company |
| LinkedIn Enrich | 🔗 LinkedIn | `/linkedin linkedin.com/in/...` | GET /api/linkedin |
| Bulk Upload | 📋 Bulk | - | POST /api/bulk/* |
| Job Alerts | 👁️ Watchlist | `/watchlist [add\|check\|list]` | GET/POST /api/watchlist |
| ABN Lookup | 🔢 ABN | `/abn Atlassian` | GET /api/abn |
| Hiring Signals | 💼 Hiring | `/hiring canva.com` | GET /api/hiring |

## Slack Commands

### Person Discovery
```
/discover Tom Cowan, TDM Growth Partners
/discover Jane Smith @ Atlassian
```

### Prospecting (FREE - no credits)
```
/prospect CEO Sydney 10
/prospect CFO, Director Melbourne fintech
```

### Find Colleagues
```
/colleagues atlassian.com CFO
/colleagues canva.com CEO CTO
```

### Company Intelligence
```
/company atlassian.com
/company Canva
```

### LinkedIn Enrichment
```
/linkedin https://linkedin.com/in/tom-cowan
```

### ABN Lookup
```
/abn Atlassian
/abn 53 102 443 916
```

### Hiring Signals
```
/hiring canva.com
/hiring Atlassian
```

### Watchlist (Job Change Alerts)
```
/watchlist                          # List all watched contacts
/watchlist add Tom Cowan TDM        # Add contact to watchlist
/watchlist check                    # Check for job changes
/watchlist remove <id>              # Remove from watchlist
```

## Slack Setup

1. Create app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add slash commands:

| Command | Request URL |
|---------|-------------|
| `/discover` | `https://your-server/slack/discover` |
| `/prospect` | `https://your-server/slack/prospect` |
| `/colleagues` | `https://your-server/slack/colleagues` |
| `/company` | `https://your-server/slack/company` |
| `/linkedin` | `https://your-server/slack/linkedin` |
| `/abn` | `https://your-server/slack/abn` |
| `/hiring` | `https://your-server/slack/hiring` |
| `/watchlist` | `https://your-server/slack/watchlist` |

3. Set `SLACK_SIGNING_SECRET` in environment

## Data Sources

| Source | Coverage | Best For |
|--------|----------|----------|
| Apollo.io | Global | Emails, people search (FREE) |
| Firmable | AU/NZ | ABN, AU employees, mobiles |
| Lusha | Global | Verified emails, phones |
| SerpAPI | Global | LinkedIn discovery, ABN lookup |

## Environment Variables

```env
SLACK_SIGNING_SECRET=your-secret
SERP_API_KEY=your-key
APOLLO_API_KEY=your-key
FIRMABLE_API_KEY=your-key
LUSHA_API_KEY=your-key
PORT=3000
```

## License

MIT
