# Contact Discovery Bot v2.0 - Setup Guide

## What's New in v2.0

| Feature | Description |
|---------|-------------|
| 🔎 **Web Search Pre-Enrichment** | Searches Google (AU) before API calls for better matches |
| 🔗 **LinkedIn Discovery** | Multiple strategies to find LinkedIn profiles |
| 🎯 **Fuzzy Name Matching** | Handles nicknames (Bob→Robert), typos |
| 🏢 **Domain Auto-Lookup** | Finds company domains automatically |
| ✅ **Email/Phone Validation** | Verifies deliverability with NumVerify |
| 💾 **Redis Caching** | 30-day cache to avoid duplicate API costs |
| 📦 **Batch Processing** | Process up to 50 contacts at once |
| 🇦🇺 **Australia Default** | Optimized for Australian contacts |

---

## Architecture

```
┌──────────────┐     ┌─────────────────────────────────────────────────────┐
│    Slack     │────▶│              Contact Discovery Bot                  │
│   Channel    │     │                                                     │
└──────────────┘     │  ┌─────────────────────────────────────────────┐   │
                     │  │ Phase 1: Web Search Pre-Enrichment (AU)     │   │
                     │  │  • SerpAPI Google.com.au search             │   │
                     │  │  • Find LinkedIn URL (multiple strategies)  │   │
                     │  │  • Discover company domain                   │   │
                     │  └─────────────────────────────────────────────┘   │
                     │                       ▼                            │
                     │  ┌─────────────────────────────────────────────┐   │
                     │  │ Phase 2: API Enrichment (parallel)          │   │
                     │  │  • Firmable (AU/NZ - default)────┐          │   │
                     │  │  • Lusha ────────────────────────┼─▶Merge   │   │
                     │  │  • Apollo.io ────────────────────┘          │   │
                     │  └─────────────────────────────────────────────┘   │
                     │                       ▼                            │
                     │  ┌─────────────────────────────────────────────┐   │
                     │  │ Phase 3: Validation                         │   │
                     │  │  • NumVerify phone validation               │   │
                     │  │  • Email format validation                  │   │
                     │  └─────────────────────────────────────────────┘   │
                     │                       ▼                            │
                     │  ┌─────────────────────────────────────────────┐   │
                     │  │ Phase 4: Cache & Return                     │   │
                     │  │  • Store in Redis (30-day TTL)              │   │
                     │  │  • Format Slack message                     │   │
                     │  └─────────────────────────────────────────────┘   │
                     └─────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start Redis (optional but recommended)
docker run -d -p 6379:6379 redis:alpine

# 4. Run the bot
npm start
```

---

## Slack Usage

### Single Contact Discovery

```
/enrich John Smith, CEO, Acme Corp, Sydney
```

Or mention the bot:
```
@ContactBot Steven Lowy, Principal, LFG
```

### Batch Processing

Semicolon or newline separated:
```
/enrich-batch John Smith, CEO, Acme; Jane Doe, CFO, TechCorp; Bob Wilson @ Startup Inc
```

Or via mention:
```
@ContactBot batch: 
John Smith, CEO, Acme Corp
Jane Doe, CFO, TechCorp
Bob Wilson, CTO, Startup Inc
```

### Input Formats Supported

| Format | Example |
|--------|---------|
| Comma-separated | `John Smith, CEO, Acme Corp, Sydney` |
| @ symbol | `John Smith @ Acme Corp` |
| "at" keyword | `John Smith at Acme Corp` |
| With title in parens | `John Smith (CEO) at Acme Corp` |
| With LinkedIn URL | `John Smith, CEO, Acme, linkedin.com/in/johnsmith` |
| Name only | `John Smith` |

---

## API Configuration

### Required APIs

| API | Purpose | Pricing |
|-----|---------|---------|
| **Firmable** | AU/NZ contacts | Teams plan+ |
| **Lusha** | Global contacts | Premium+ |
| **Apollo.io** | Global + LinkedIn | Various plans |
| **SerpAPI** | Google search (AU) | $50/mo (5000) |

### Optional APIs

| API | Purpose | Pricing |
|-----|---------|---------|
| **NumVerify** | Phone validation | Free tier (250/mo) |
| **Hunter.io** | Email validation | $49/mo (1000) |

### Alternative Search APIs

If you don't want to use SerpAPI, you can use:

1. **Google Custom Search API**
   - 100 free queries/day
   - $5 per 1000 after that
   - Set `GOOGLE_API_KEY` and `GOOGLE_CSE_ID`

2. **Bing Search API**
   - 1000 free/month
   - Configure in code

---

## Fuzzy Matching

The bot automatically handles name variations:

| Input | Also Matches |
|-------|--------------|
| Bob | Robert, Bobby, Rob |
| Steve | Steven, Stephen |
| Mike | Michael, Mick |
| Bill | William, Will, Billy |
| Kate | Katherine, Katie, Kathy |
| Liz | Elizabeth, Beth, Lizzy |

And handles typos with Levenshtein distance matching.

---

## Caching

### How It Works

- Results are cached for **30 days** by default
- Cache key = MD5 hash of `firstName_lastName_company`
- Cross-source matches boost confidence scores

### Cache Backends

| Backend | When to Use |
|---------|-------------|
| **Redis** | Production (recommended) |
| **Memory** | Development/testing |

### Railway Deployment

Railway provides Redis as an add-on. Just add it and it auto-configures `REDIS_URL`.

### Cache API Endpoints

```bash
# Get cache stats
GET /api/cache/stats

# Clear specific cache entry
DELETE /api/cache/:key
```

---

## API Endpoints

### Slack Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /slack/commands` | `/enrich` slash command |
| `POST /slack/commands/batch` | `/enrich-batch` slash command |
| `POST /slack/events` | @mentions |

### Direct API

```bash
# Single contact
curl -X POST http://localhost:3000/api/discover \
  -H "Content-Type: application/json" \
  -d '{"query": "John Smith, CEO, Acme Corp"}'

# Batch
curl -X POST http://localhost:3000/api/discover/batch \
  -H "Content-Type: application/json" \
  -d '{
    "contacts": [
      "John Smith, CEO, Acme Corp",
      "Jane Doe, CFO, TechCorp"
    ],
    "concurrency": 3
  }'

# Skip cache
curl -X POST http://localhost:3000/api/discover \
  -H "Content-Type: application/json" \
  -d '{"query": "John Smith, CEO, Acme Corp", "skipCache": true}'
```

---

## Deployment

### Railway (Recommended)

```bash
# Install CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway add --plugin redis  # Add Redis
railway up
```

### Docker

```bash
docker-compose up -d
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  bot:
    build: .
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
  redis:
    image: redis:alpine
    volumes:
      - redis_data:/data
volumes:
  redis_data:
```

---

## Response Example

```
📋 Contact Discovery: Steven Lowy

Company: LFG                Title: Principal
Location: Sydney            Confidence: 🟢 HIGH

🔗 LinkedIn:
https://linkedin.com/in/steven-lowy (92% match)

📧 Emails:
• steven.lowy@lfg.com.au (apollo, lusha, 95%) ✓
• slowy@lowyinstitute.org (lusha, 85%)

📱 Mobile Numbers:
• +61 412 345 678 (firmable, 90%) ✓

Sources: Firmable ✅ | Lusha ✅ | Apollo ✅ 🔎 | ⏱️ 2341ms
```

Legend:
- `✓` = Validated
- `🔎` = Web search enriched
- Multiple sources = higher confidence

---

## Cost Optimization Tips

1. **Enable caching** - Avoid re-querying same contacts
2. **Use batch processing** - More efficient API usage
3. **Skip validation for low-confidence** - Only validate top results
4. **Set up webhooks** - Real-time updates instead of polling

---

## Troubleshooting

### "No LinkedIn found"

- Check if SerpAPI/Google CSE is configured
- Try adding more context (company, title, location)
- The person may have limited LinkedIn visibility

### "Cache not working"

- Verify Redis is running: `redis-cli ping`
- Check `REDIS_URL` is correct
- Falls back to memory cache automatically

### "API rate limited"

- Reduce batch concurrency
- Add delays between requests
- Check your API plan limits

---

## Security Notes

⚠️ **Important:**
- Never commit `.env` to version control
- Rotate API keys regularly
- Use environment variables in production
- Consider IP whitelisting for API endpoints
- Enable Slack request verification in production
