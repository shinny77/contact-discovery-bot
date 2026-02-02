# Contact Discovery Bot v5

Multi-source contact discovery for AU/NZ business contacts with **bulk upload** and **compliance workflow**.

## Features

| Feature | Description | Endpoint |
|---------|-------------|----------|
| **Discover** | Find contact info for a person | `/api/discover` |
| **Prospect** | Search for leads by criteria (FREE) | `/api/prospect` |
| **Company** | Full company intelligence | `/api/company` |
| **LinkedIn** | Enrich from LinkedIn URL | `/api/linkedin` |
| **📋 Bulk Upload** | CSV upload with compliance checks | `/api/bulk/*` |

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

---

## 📋 Bulk Upload

### CSV File Requirements

**Required columns:**
- `firstName` - Person's first name
- `lastName` - Person's last name

**Recommended columns:**
- `company` - Company name
- `domain` - Company domain (e.g., atlassian.com)
- `linkedin` - LinkedIn profile URL

**Optional columns:**
- `email` - Existing email (will be preserved)
- `phone` - Existing phone
- `title` - Job title
- `location` - City/region

**Compliance columns:**
- `doNotContact` - Set to "true" to skip this contact
- `optedOut` - Set to "true" if previously opted out

### Column Name Flexibility

The system accepts various column name formats:
- `firstName`, `first_name`, `First Name`, `given name`
- `lastName`, `last_name`, `Last Name`, `surname`
- `company`, `Company Name`, `organisation`, `employer`
- etc.

### Example CSV

```csv
firstName,lastName,company,domain,linkedin,title
John,Smith,Acme Corp,acme.com,https://linkedin.com/in/johnsmith,CEO
Jane,Doe,Tech Startup,techstartup.io,,CTO
Tom,Cowan,TDM Growth Partners,tdmgrowthpartners.com,,Managing Director
```

### Limits

- Maximum **100 contacts** per batch
- Rate limited to ~5 contacts/second

---

## Compliance Workflow

The bulk upload feature includes a **4-step compliance workflow**:

### Step 1: Upload CSV
- Drag & drop or browse for CSV file
- System detects columns and maps to standard fields
- Download template if needed

### Step 2: Compliance Validation
- **Data quality checks**: Valid email format, LinkedIn URL format
- **Required fields**: First name, last name, plus company/domain/LinkedIn
- **Duplicate detection**: Flags same name + company
- **Opt-out flags**: Respects doNotContact and optedOut columns
- Review and acknowledge compliance requirements

### Step 3: Enrichment
- Contacts enriched via Apollo, Firmable, Lusha
- Progress bar shows real-time status
- ~200ms delay between requests (rate limiting)

### Step 4: Download Results
- Download enriched CSV with all contact data
- **DNC Warning**: Australian phone numbers flagged for Do Not Call verification
- Columns include: emails, phones, LinkedIn, company ABN, sources, timestamps

---

## Output CSV Format

The enriched CSV includes:

| Column | Description |
|--------|-------------|
| `firstName`, `lastName` | Original input |
| `company`, `title`, `domain` | Enriched/original |
| `email_1`, `email_1_type`, `email_1_source`, `email_1_verified` | Primary email |
| `email_2`, `email_2_type`, `email_2_source` | Secondary email |
| `phone_1`, `phone_1_type`, `phone_1_source`, `phone_1_dnc_note` | Primary phone |
| `phone_2`, `phone_2_type`, `phone_2_source` | Secondary phone |
| `linkedin` | LinkedIn URL |
| `company_abn`, `company_au_employees`, `company_phone` | Company data |
| `sources` | Data sources used |
| `enriched_at` | Timestamp |
| `errors` | Any errors encountered |

---

## Australian Compliance Notes

### Do Not Call Register

Australian mobile numbers (+61 4xx) are flagged with a note:
> "Verify against ACMA Do Not Call Register before calling"

Before calling any Australian numbers:
1. Check https://www.donotcall.gov.au/
2. Register as a caller if not already
3. Wash your list against the DNC register

### Privacy Act

Ensure you have a lawful basis for processing under the Australian Privacy Act:
- Existing business relationship
- Legitimate interest for B2B prospecting
- Consent for marketing communications

---

## API Reference

### Bulk Validate
```bash
POST /api/bulk/validate
Content-Type: application/json

{
  "csv": "firstName,lastName,company\nJohn,Smith,Acme"
}

# Response
{
  "validContacts": [...],
  "issues": [{"row": 2, "contact": "Jane Doe", "issues": ["Missing company"]}],
  "totalRows": 10
}
```

### Bulk Enrich
```bash
POST /api/bulk/enrich
Content-Type: application/json

{
  "contacts": [
    {"firstName": "John", "lastName": "Smith", "company": "Acme"}
  ]
}

# Response
{
  "results": [
    {
      "firstName": "John",
      "lastName": "Smith",
      "emails": [{"email": "john@acme.com", "source": "Apollo"}],
      "phones": [...],
      "companyInfo": {...}
    }
  ]
}
```

### Bulk Download
```bash
POST /api/bulk/download
Content-Type: application/json

{
  "results": [...]  // From enrich response
}

# Response: CSV file download
```

### Template Download
```bash
GET /api/bulk/template

# Response: CSV template file
```

---

## Data Sources

| Source | Coverage | Best For |
|--------|----------|----------|
| **Apollo.io** | Global | Emails, verified contacts |
| **Firmable** | AU/NZ | ABN, AU employees, mobiles |
| **Lusha** | Global | Verified emails, phones |
| **SerpAPI** | Global | LinkedIn profile discovery |

---

## Environment Variables

```env
SERP_API_KEY=your-key
APOLLO_API_KEY=your-key
FIRMABLE_API_KEY=your-key
LUSHA_API_KEY=your-key
PORT=3000
```

## License

MIT
