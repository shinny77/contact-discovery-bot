# Contact Discovery Bot

Real-time contact discovery for AU/NZ business contacts with Slack integration.

## Features

- **Slack Slash Command**: `/discover Tom Cowan, TDM Growth Partners`
- **Web Interface**: Browser-based search UI
- **REST API**: Programmatic access
- **Multi-source enrichment**: SerpAPI (LinkedIn), Apollo.io (emails), Firmable (AU/NZ data)

## Quick Start

```bash
npm install
npm run slack    # Start Slack bot server
npm start        # Start web interface
```

## Slack Setup

### 1. Create Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch

### 2. Add Slash Command

In your app → **Slash Commands** → Create New Command:

| Field | Value |
|-------|-------|
| Command | `/discover` |
| Request URL | `https://your-server.com/slack/command` |
| Description | Discover contact info for a person |
| Usage Hint | `FirstName LastName, Company Name` |

### 3. Install & Configure

1. **Install to Workspace** (OAuth & Permissions)
2. Copy **Signing Secret** from Basic Information
3. Add to `.env`:

```env
SLACK_SIGNING_SECRET=your-signing-secret
```

### 4. Deploy

Deploy to a public server (Heroku, Railway, Render, etc.) or use ngrok for local testing:

```bash
ngrok http 3000
# Update Slack slash command URL with ngrok URL
```

## Usage

### Slack
```
/discover Tom Cowan, TDM Growth Partners
/discover Myles Glashier @ Phocas Software
/discover John Smith at Atlassian
```

### API
```bash
curl "http://localhost:3000/api/discover?firstName=Tom&lastName=Cowan&company=TDM%20Growth%20Partners"
```

## Response Example

```
🔍 Tom Cowan @ TDM Growth Partners
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 LinkedIn: linkedin.com/in/tom-cowan-1627b410
📧 Email: tomc@tdmgrowth.com ✓ (95%) Apollo
📱 Phone: +61 2 9000 0000 Firmable

🏢 TDM Growth Partners • 19 AU employees • Est. 2004

Completed in 7234ms
```

## Files

| File | Description |
|------|-------------|
| `slack-bot.js` | Slack slash command server |
| `webapp.js` | Web interface with browser UI |
| `cli.js` | Command-line tool |
| `index.js` | Core API client library |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SLACK_SIGNING_SECRET` | Slack app signing secret | For Slack |
| `SERP_API_KEY` | SerpAPI key for LinkedIn search | Optional* |
| `APOLLO_API_KEY` | Apollo.io API key | Optional* |
| `FIRMABLE_API_KEY` | Firmable API key for AU/NZ | Optional* |
| `PORT` | Server port (default: 3000) | No |

*Defaults provided for testing

## Docker

```bash
docker-compose up
```

## License

MIT
