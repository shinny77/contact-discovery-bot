# Contact Discovery Bot

A real-time contact discovery tool for Australian and New Zealand business contacts. Uses the Firmable API to search for contacts by company, job title, location, and other criteria.

## Features

- **Web Interface**: Real-time search with live results streaming
- **CLI Tool**: Command-line interface for batch operations
- **Multiple Search Modes**: 
  - Company search
  - Contact search by title/seniority
  - Domain lookup
  - Bulk company processing

## Quick Start

### Prerequisites

- Node.js 18+
- Firmable API key (get one at [firmable.com](https://firmable.com))

### Installation

```bash
npm install
```

### Configuration

Copy the example environment file and add your API key:

```bash
cp .env.example .env
# Edit .env and add your FIRMABLE_API_KEY
```

### Running the Web App

```bash
node webapp.js
```

Then open http://localhost:3456 in your browser.

### Running the CLI

```bash
node cli.js --help
```

## Docker

```bash
docker-compose up
```

## API Endpoints

- `GET /` - Web interface
- `GET /api/search/companies?q=<query>` - Search companies
- `GET /api/search/contacts?company_id=<id>` - Get contacts for a company
- `GET /api/search/domain?domain=<domain>` - Lookup by domain

## License

MIT
