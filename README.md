# Contact Discovery Bot v6.8

Multi-source contact discovery for AU/NZ business contacts. Find emails, phones, company intel, and more.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

---

## Slack Commands

### `/cdhelp`
Show all available commands and usage examples.

---

### Person Lookup

```
/discover Tom Cowan, TDM Growth Partners
/discover Jane Smith @ Atlassian
```
→ Find emails, phones, LinkedIn for a specific person

---

### Prospecting ✨ FREE

```
/prospect CEO Sydney 10
/prospect CFO, Director Melbourne fintech
```
→ Find leads by job title, location, and keywords
→ Returns: name, title, company, LinkedIn

---

### Find Colleagues ✨ FREE

```
/colleagues atlassian.com CFO
/colleagues canva.com CEO CTO VP
/colleagues tdmgrowthpartners.com
```
→ Find people with specific roles at any company
→ Tip: Combine multiple roles in one command

---

### Company Intelligence

```
/company atlassian.com
/company Canva
```
→ Full company profile: employees, industry, ABN, tech stack

---

### LinkedIn Enrichment

```
/linkedin https://linkedin.com/in/tom-cowan
```
→ Get contact info from any LinkedIn profile URL

---

### ABN Lookup ✨ FREE

```
/abn Atlassian
/abn 53 102 443 916
```
→ Australian Business Number verification
→ Shows: entity name, status, type, ABR link

---

### Hiring Signals ✨ FREE

```
/hiring canva.com
/hiring Atlassian
```
→ See open job counts, growth indicators
→ Links to SEEK, LinkedIn, Indeed, career pages

---

### Tech Stack

```
/tech atlassian.com
```
→ See what technologies a company uses
→ Grouped by category (Cloud, Analytics, CMS, etc)

---

### Lookalike Companies ✨ FREE

```
/lookalike atlassian.com
/lookalike canva.com
```
→ Find similar companies by industry, size, age
→ Includes similarity score (0-100%)

---

### Job Change Alerts (Watchlist)

```
/watchlist                      List all watched contacts
/watchlist add Tom Cowan TDM    Add contact to watchlist
/watchlist check                Check all for job changes
/watchlist remove <id>          Remove from watchlist
```
→ Track contacts and get notified when they change jobs

---

## Slack Setup

1. Create Slack app at https://api.slack.com/apps
2. Add slash commands with these Request URLs:

| Command | Request URL |
|---------|-------------|
| `/cdhelp` | `https://your-server/slack/cdhelp` |
| `/discover` | `https://your-server/slack/discover` |
| `/prospect` | `https://your-server/slack/prospect` |
| `/colleagues` | `https://your-server/slack/colleagues` |
| `/company` | `https://your-server/slack/company` |
| `/linkedin` | `https://your-server/slack/linkedin` |
| `/abn` | `https://your-server/slack/abn` |
| `/hiring` | `https://your-server/slack/hiring` |
| `/tech` | `https://your-server/slack/tech` |
| `/lookalike` | `https://your-server/slack/lookalike` |
| `/watchlist` | `https://your-server/slack/watchlist` |

3. Install app to workspace

---

## Web UI Features

| Tab | Feature |
|-----|---------|
| 👤 Discover | Person lookup with all data sources |
| 🎯 Prospect | Search leads by criteria |
| 👥 Colleagues | Find roles at companies |
| 🏢 Company | Full company intelligence |
| 🔢 ABN | Australian Business Number lookup |
| 💼 Hiring | Job postings and growth signals |
| 🔧 Tech Stack | Company technology lookup |
| 🔄 Lookalikes | Find similar companies |
| 🔗 LinkedIn | Enrich from LinkedIn URL |
| 📋 Bulk | CSV upload with compliance workflow |
| 👁️ Watchlist | Job change monitoring |
| 📊 Dashboard | Usage stats and metrics |

---

## API Endpoints

### Person & Company
- `GET /api/discover?firstName=&lastName=&company=`
- `POST /api/prospect` - `{titles, locations, seniorities, limit}`
- `POST /api/colleagues` - `{domain, roles, limit}`
- `GET /api/company?domain=`
- `GET /api/linkedin?url=`

### Business Intel
- `GET /api/abn?q=` - ABN lookup
- `GET /api/hiring?company=` - Hiring signals
- `GET /api/tech?company=` - Tech stack
- `GET /api/tech/search?tech=&location=` - Find by tech
- `GET /api/lookalike?company=&limit=` - Similar companies

### Bulk Operations
- `GET /api/bulk/template` - Download CSV template
- `POST /api/bulk/validate` - Validate CSV
- `POST /api/bulk/enrich` - Enrich contacts
- `POST /api/bulk/download` - Download results

### CRM Export
- `POST /api/export/hubspot` - HubSpot format
- `POST /api/export/salesforce` - Salesforce format

### Watchlist
- `GET /api/watchlist` - List watched
- `POST /api/watchlist` - Add contact
- `DELETE /api/watchlist?id=` - Remove
- `POST /api/watchlist/check` - Check for changes

### Stats
- `GET /api/stats` - Usage dashboard
- `POST /api/stats/reset` - Reset stats

---

## Data Sources

| Source | Coverage | Best For |
|--------|----------|----------|
| Apollo.io | Global | Emails, people search (FREE tier) |
| Firmable | AU/NZ | ABN, AU employees, mobiles |
| Lusha | Global | Verified emails and phones |
| SerpAPI | Global | LinkedIn discovery, ABN lookup |

---

## Environment Variables

```env
PORT=3000
SLACK_SIGNING_SECRET=your-secret

# API Keys
SERP_API_KEY=your-key
APOLLO_API_KEY=your-key
FIRMABLE_API_KEY=your-key
LUSHA_API_KEY=your-key
```

---

## Files

```
webapp-v4.js    Main application (3200+ lines)
watchlist.js    Job change tracking module
stats.js        Usage statistics module
package.json    Dependencies and scripts
```

---

## License

MIT
