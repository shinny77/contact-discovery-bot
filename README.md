# Contact Discovery Bot v6.8

Multi-source contact discovery platform for AU/NZ business contacts. Aggregates data from Apollo, Lusha, Firmable, and SerpAPI.

## Features

### 👤 Discover
Find contact details for any person using all available sources.

**Sources:** Apollo + Lusha + Firmable + SerpAPI

**Input:** First name, last name, company, domain (optional)

**Returns:**
- Work emails (Apollo)
- Personal emails (Lusha)
- Phone numbers (Lusha)
- LinkedIn URL
- Company info (Firmable)

---

### 🎯 Prospect (FREE)
Search for leads by job title and location. No API credits consumed.

**Sources:** Apollo (free tier)

**Input:** Job titles, locations, seniority level

**Returns:** List of matching prospects with name, title, company, LinkedIn

---

### 👥 Colleagues (FREE)
Find specific roles at any company.

**Sources:** Firmable + Apollo

**Input:** Company domain, roles (CEO, CFO, etc.)

**Returns:** List of employees matching those roles

**Enrich:** Click "Get Contact" to enrich with emails/phones from Apollo + Lusha

---

### 🏢 Company
Full company intelligence profile.

**Sources:** Firmable + Apollo

**Input:** Company domain or name

**Returns:**
- Company name, domain, description
- Employee count (AU + global)
- ABN/ACN
- Industry
- Tech stack
- LinkedIn URL

---

### 🔢 ABN (FREE)
Australian Business Number lookup and validation.

**Sources:** SerpAPI + Firmable

**Input:** ABN number or company name

**Returns:**
- ABN number
- Entity name
- Status (Active/Cancelled)
- Entity type
- Link to ABR

---

### 💼 Hiring (FREE)
See which companies are actively hiring - indicates growth and budget.

**Sources:** Apollo + SerpAPI

**Input:** Company name or domain

**Returns:**
- Open job count
- Growth indicators (Aggressive/Active/Moderate)
- Links to career pages (LinkedIn, SEEK, Indeed)

---

### 🔧 Tech Stack
See what technologies a company uses.

**Sources:** Apollo

**Input:** Company domain

**Returns:** Technologies grouped by category (Cloud, Analytics, CMS, etc.)

---

### 🔄 Lookalikes (FREE)
Find companies similar to one you like.

**Sources:** Apollo

**Input:** Seed company domain

**Returns:** Similar companies by industry, size, and age with similarity score

---

### 🔗 LinkedIn
Enrich any LinkedIn profile URL with contact details.

**Sources:** Lusha + Apollo

**Input:** LinkedIn profile URL

**Returns:**
- Emails (work + personal)
- Phone numbers (mobile + work)
- Current title and company

---

### 📋 Bulk Upload
Upload CSV of contacts for bulk enrichment with compliance workflow.

**Features:**
- CSV validation
- Duplicate detection
- DNC (Do Not Contact) warnings
- AU phone number DNC checking
- Max 100 contacts per batch
- Export to CSV

---

### 👁️ Watchlist
Track contacts for job changes.

**Features:**
- Add contacts to watchlist
- Check for role/company changes
- Get notified when contacts move

---

### 📊 Dashboard
Usage statistics and API health metrics.

**Shows:**
- Total requests
- Enrichment success rates
- Last 7 days activity
- Top endpoints
- API health by provider

---

### 📤 CRM Export
Export results to HubSpot or Salesforce format.

**Available on:** Colleagues, Prospects, Lookalikes results

**Formats:**
- HubSpot contact import CSV
- Salesforce lead import CSV

---

## Slack Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/cdhelp` | Show all commands | `/cdhelp` |
| `/discover` | Find person's contact info | `/discover Tom Cowan, TDM Growth Partners` |
| `/prospect` | Search for leads | `/prospect CEO Sydney 10` |
| `/colleagues` | Find roles at company | `/colleagues atlassian.com CFO CTO` |
| `/company` | Company intelligence | `/company canva.com` |
| `/linkedin` | Enrich LinkedIn URL | `/linkedin https://linkedin.com/in/...` |
| `/abn` | ABN lookup | `/abn Atlassian` |
| `/hiring` | Hiring signals | `/hiring canva.com` |
| `/tech` | Tech stack | `/tech atlassian.com` |
| `/lookalike` | Similar companies | `/lookalike atlassian.com` |
| `/watchlist` | Manage watchlist | `/watchlist add Tom Cowan TDM` |

---

## API Endpoints

### Person Enrichment
```
GET  /api/discover?firstName=&lastName=&company=&domain=
POST /api/prospect {titles, locations, seniorities, limit}
POST /api/colleagues {domain, roles, seniority, limit}
POST /api/colleagues/enrich {firstName, lastName, linkedin}
GET  /api/linkedin?url=
```

### Company Intelligence
```
GET /api/company?domain=
GET /api/abn?q=
GET /api/hiring?company=
GET /api/tech?company=
GET /api/lookalike?company=&limit=
```

### Bulk Operations
```
GET  /api/bulk/template
POST /api/bulk/validate {csv}
POST /api/bulk/enrich {contacts}
POST /api/bulk/download {results}
```

### CRM Export
```
POST /api/export/hubspot {data, type}
POST /api/export/salesforce {data, type}
```

### Watchlist
```
GET    /api/watchlist
POST   /api/watchlist {firstName, lastName, company, linkedin}
DELETE /api/watchlist?id=
POST   /api/watchlist/check
```

### System
```
GET  /health
GET  /api/stats
POST /api/stats/reset
```

---

## Data Sources

| Source | Type | Best For |
|--------|------|----------|
| **Apollo.io** | Global B2B | Work emails, company data, prospecting |
| **Lusha** | Global | Verified emails, phone numbers |
| **Firmable** | AU/NZ | ABN, AU employees, local data |
| **SerpAPI** | Search | LinkedIn discovery, ABN lookup, job postings |

---

## Setup

### Local Development
```bash
git clone https://github.com/shinny77/contact-discovery-bot.git
cd contact-discovery-bot
npm install
npm start
```

### Environment Variables
API keys are configured in `webapp-v4.js` config section:
- `SERP_API_KEY`
- `APOLLO_API_KEY`
- `FIRMABLE_API_KEY`
- `LUSHA_API_KEY`

### Slack Setup
1. Create Slack app at https://api.slack.com/apps
2. Add slash commands pointing to your server
3. Install to workspace

---

## Files

```
webapp-v4.js    Main application (3400+ lines)
watchlist.js    Job change tracking module
stats.js        Usage statistics module
package.json    Dependencies
README.md       This file
```

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Server:** Native HTTP (no Express)
- **APIs:** REST with JSON
- **Frontend:** Embedded HTML/CSS/JS
- **Storage:** JSON files (stats, watchlist)

---

## License

MIT
