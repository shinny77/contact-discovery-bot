# Contact Discovery Bot v4

Multi-source contact discovery for AU/NZ business contacts with 4 powerful features.

## Features

| Feature | Description | Slack Command |
|---------|-------------|---------------|
| **Discover** | Find emails, phones, LinkedIn for a person | `/discover Tom Cowan, TDM Growth Partners` |
| **Prospect** | Search for new leads by criteria (FREE) | `/prospect CEO Sydney fintech 10` |
| **Company** | Full company intelligence profile | `/company atlassian.com` |
| **LinkedIn** | Enrich contact from LinkedIn URL | `/linkedin linkedin.com/in/tom-cowan` |

## Data Sources

- **SerpAPI** - LinkedIn profile discovery via Google
- **Apollo.io** - Email enrichment, people search (FREE)
- **Firmable** - AU/NZ company data, ABN/ACN, mobiles
- **Lusha** - Global contact enrichment, verified emails

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

## Slack Setup

### 1. Create Slack App
Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App

### 2. Add Slash Commands

| Command | Request URL | Description |
|---------|-------------|-------------|
| `/discover` | `https://your-server/slack/discover` | Find person's contact info |
| `/prospect` | `https://your-server/slack/prospect` | Search for new leads |
| `/company` | `https://your-server/slack/company` | Get company intelligence |
| `/linkedin` | `https://your-server/slack/linkedin` | Enrich from LinkedIn URL |

### 3. Install & Configure
```bash
# Add to .env
SLACK_SIGNING_SECRET=your-signing-secret
```

## Usage Examples

### Slack
```
/discover Tom Cowan, TDM Growth Partners
/discover Myles Glashier @ Phocas Software
/prospect CEO Sydney 10
/prospect CFO, Director Melbourne fintech
/company atlassian.com
/company TDM Growth Partners
/linkedin https://linkedin.com/in/tom-cowan
```

### API
```bash
# Discover person
curl "http://localhost:3000/api/discover?firstName=Tom&lastName=Cowan&company=TDM"

# Prospect (POST)
curl -X POST http://localhost:3000/api/prospect \
  -H "Content-Type: application/json" \
  -d '{"titles":["CEO","CFO"],"locations":["Sydney"],"limit":10}'

# Company intel
curl "http://localhost:3000/api/company?domain=atlassian.com"

# LinkedIn enrichment
curl "http://localhost:3000/api/linkedin?url=https://linkedin.com/in/tom-cowan"
```

## Response Example

### /discover
```
🔍 Tom Cowan @ TDM Growth Partners
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 LinkedIn: linkedin.com/in/tom-cowan-1627b410
📧 tomc@tdmgrowth.com ✓ Apollo
📱 +61 2 9000 0000 Firmable

🏢 TDM Growth Partners • 19 AU employees

7234ms
```

### /prospect (FREE - no credits)
```
🎯 Found 847 prospects
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• John Smith - CEO
  Acme Corp (250 emp) LinkedIn
• Jane Doe - Chief Executive Officer
  Tech Startup (50 emp) LinkedIn
...
```

### /company
```
🏢 Atlassian
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 atlassian.com
👥 3,767 AU employees
🌍 12,000 global employees
📅 Founded 2002
🔢 ABN: 53 102 443 916

💻 Tech: Jira, Confluence, AWS, React...
💼 Hiring: 47 open positions
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SLACK_SIGNING_SECRET` | Slack app signing secret | - |
| `SERP_API_KEY` | SerpAPI key | Provided |
| `APOLLO_API_KEY` | Apollo.io API key | Provided |
| `FIRMABLE_API_KEY` | Firmable API key | Provided |
| `LUSHA_API_KEY` | Lusha API key | Provided |
| `PORT` | Server port | 3000 |

## License

MIT
