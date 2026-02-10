#!/usr/bin/env node
/**
 * Contact Discovery Slack Bot
 * 
 * Slash command: /discover FirstName LastName, Company Name
 * Example: /discover Tom Cowan, TDM Growth Partners
 * 
 * Setup:
 *   1. Create Slack App at https://api.slack.com/apps
 *   2. Add Slash Command: /discover → https://your-server/slack/command
 *   3. Set SLACK_SIGNING_SECRET in .env
 *   4. Install app to workspace
 */

const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;

const config = {
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    botToken: process.env.SLACK_BOT_TOKEN || '',
  },
  serp: {
    apiKey: process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '',
  },
  apollo: {
    apiKey: process.env.APOLLO_API_KEY || process.env.APOLLO_API_KEY || '',
  },
  firmable: {
    apiKey: process.env.FIRMABLE_API_KEY || process.env.FIRMABLE_API_KEY || '',
  },
};

// ============================================================================
// HTTP CLIENT
// ============================================================================

function curlGet(reqUrl, headers = {}) {
  try {
    let cmd = `curl -sk --max-time 15`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    cmd += ` "${reqUrl}"`;
    return JSON.parse(execSync(cmd, { encoding: 'utf8', timeout: 20000 }));
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

function curlPost(reqUrl, headers = {}, body = {}) {
  try {
    let cmd = `curl -sk --max-time 15 -X POST`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    cmd += ` -d '${JSON.stringify(body)}' "${reqUrl}"`;
    return JSON.parse(execSync(cmd, { encoding: 'utf8', timeout: 20000 }));
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

// ============================================================================
// SLACK SIGNATURE VERIFICATION
// ============================================================================

function verifySlackSignature(signature, timestamp, body) {
  if (!config.slack.signingSecret) return true; // Skip if not configured
  
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;
  
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', config.slack.signingSecret)
    .update(sigBasestring)
    .digest('hex');
  
  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

// ============================================================================
// CONTACT DISCOVERY
// ============================================================================

function discoverContact(firstName, lastName, company, domain) {
  const results = {
    firstName, lastName, company,
    linkedin: null,
    linkedinTitle: null,
    emails: [],
    phones: [],
    companyInfo: null,
    duration: 0,
  };
  
  const start = Date.now();
  
  // Phase 1: SerpAPI LinkedIn search
  try {
    const query = `${firstName} ${lastName} ${company} site:linkedin.com`;
    const serpUrl = `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(query)}&num=5&gl=au`;
    const serpData = curlGet(serpUrl);
    
    if (serpData.organic_results?.length) {
      const li = serpData.organic_results.find(r => r.link?.includes('linkedin.com/in/'));
      if (li) {
        results.linkedin = li.link;
        results.linkedinTitle = li.title;
      }
    }
  } catch (e) { /* continue */ }
  
  // Phase 2: Apollo.io enrichment
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/v1/people/match',
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { first_name: firstName, last_name: lastName, organization_name: company, domain }
    );
    
    if (apolloData.person) {
      if (apolloData.person.email) {
        results.emails.push({ 
          email: apolloData.person.email, 
          source: 'Apollo', 
          verified: apolloData.person.email_status === 'verified',
          confidence: 0.95 
        });
      }
      if (apolloData.person.personal_emails?.length) {
        apolloData.person.personal_emails.forEach(e => {
          results.emails.push({ email: e, source: 'Apollo', type: 'personal', confidence: 0.8 });
        });
      }
      if (apolloData.person.phone_numbers?.length) {
        apolloData.person.phone_numbers.forEach(p => {
          results.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo', confidence: 0.85 });
        });
      }
    }
  } catch (e) { /* continue */ }
  
  // Phase 3: Firmable (AU/NZ)
  try {
    let searchDomain = domain;
    if (!searchDomain && company) {
      // Try to guess domain
      const guesses = [
        company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au',
        company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com',
      ];
      for (const guess of guesses) {
        const test = curlGet(
          `https://api.firmable.com/company?website=${encodeURIComponent(guess)}`,
          { 'Authorization': `Bearer ${config.firmable.apiKey}` }
        );
        if (test.id) { searchDomain = guess; break; }
      }
    }
    
    if (searchDomain) {
      const firmData = curlGet(
        `https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`,
        { 'Authorization': `Bearer ${config.firmable.apiKey}` }
      );
      
      if (firmData.id) {
        results.companyInfo = {
          name: firmData.name,
          website: firmData.website,
          employees: firmData.au_employee_count,
          founded: firmData.year_founded,
          description: firmData.description?.substring(0, 200),
          linkedin: firmData.linkedin,
        };
        
        if (firmData.phone) {
          results.phones.push({ number: firmData.phone, source: 'Firmable', type: 'company', confidence: 0.9 });
        }
        
        // Try to find person's email pattern
        if (firmData.fqdn) {
          const patterns = [
            `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${firmData.fqdn}`,
            `${firstName.toLowerCase()[0]}${lastName.toLowerCase()}@${firmData.fqdn}`,
            `${firstName.toLowerCase()}@${firmData.fqdn}`,
          ];
          // Add as lower confidence guesses if not already found
          const existingEmails = results.emails.map(e => e.email.toLowerCase());
          patterns.forEach(p => {
            if (!existingEmails.includes(p.toLowerCase())) {
              results.emails.push({ email: p, source: 'Firmable (pattern)', confidence: 0.3 });
            }
          });
        }
      }
    }
  } catch (e) { /* continue */ }
  
  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// FORMAT SLACK RESPONSE
// ============================================================================

function formatSlackResponse(results) {
  const { firstName, lastName, company, linkedin, emails, phones, companyInfo, duration } = results;
  
  let text = `🔍 *${firstName} ${lastName}*`;
  if (company) text += ` @ ${company}`;
  text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  
  // LinkedIn
  if (linkedin) {
    text += `🔗 *LinkedIn:* <${linkedin}|View Profile>\n`;
  }
  
  // Emails
  if (emails.length > 0) {
    const topEmails = emails
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 3);
    topEmails.forEach(e => {
      const badge = e.verified ? ' ✓' : '';
      const conf = e.confidence ? ` (${Math.round(e.confidence * 100)}%)` : '';
      text += `📧 *Email:* \`${e.email}\`${badge}${conf} _${e.source}_\n`;
    });
  } else {
    text += `📧 _No emails found_\n`;
  }
  
  // Phones
  if (phones.length > 0) {
    phones.slice(0, 2).forEach(p => {
      text += `📱 *Phone:* \`${p.number}\` _${p.source}_\n`;
    });
  }
  
  // Company info
  if (companyInfo) {
    text += `\n🏢 *${companyInfo.name}*`;
    if (companyInfo.employees) text += ` • ${companyInfo.employees} AU employees`;
    if (companyInfo.founded) text += ` • Est. ${companyInfo.founded}`;
    text += '\n';
  }
  
  text += `\n_Completed in ${duration}ms_`;
  
  return {
    response_type: 'in_channel',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text }
      }
    ]
  };
}

// ============================================================================
// PARSE SLASH COMMAND INPUT
// ============================================================================

function parseInput(text) {
  // Formats supported:
  // "Tom Cowan, TDM Growth Partners"
  // "Tom Cowan @ TDM Growth Partners"
  // "Tom Cowan at TDM Growth Partners"
  // "Tom Cowan TDM Growth Partners"
  
  let firstName = '', lastName = '', company = '', domain = '';
  
  // Check for domain in input
  const domainMatch = text.match(/(\S+\.(com|com\.au|io|co|net|org))/i);
  if (domainMatch) {
    domain = domainMatch[1];
    text = text.replace(domain, '').trim();
  }
  
  // Split by common delimiters
  let parts;
  if (text.includes(',')) {
    parts = text.split(',').map(s => s.trim());
  } else if (text.includes(' @ ')) {
    parts = text.split(' @ ').map(s => s.trim());
  } else if (text.toLowerCase().includes(' at ')) {
    parts = text.split(/\s+at\s+/i).map(s => s.trim());
  } else {
    // Assume format: FirstName LastName Company Company Company
    const words = text.split(/\s+/);
    if (words.length >= 2) {
      firstName = words[0];
      lastName = words[1];
      company = words.slice(2).join(' ');
    }
    return { firstName, lastName, company, domain };
  }
  
  // Parse name part
  if (parts[0]) {
    const nameParts = parts[0].split(/\s+/);
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
  }
  
  // Company is second part
  company = parts[1] || '';
  
  return { firstName, lastName, company, domain };
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    return;
  }
  
  // Slack slash command
  if (parsed.pathname === '/slack/command' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Verify Slack signature
      const signature = req.headers['x-slack-signature'] || '';
      const timestamp = req.headers['x-slack-request-timestamp'] || '';
      
      if (config.slack.signingSecret && !verifySlackSignature(signature, timestamp, body)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
      
      const params = querystring.parse(body);
      const { text, user_name, response_url } = params;
      
      console.log(`\n\x1b[36m\x1b[1m🔍 Slash command from @${user_name}: /discover ${text}\x1b[0m`);
      
      if (!text || text.trim() === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response_type: 'ephemeral',
          text: '❓ *Usage:* `/discover FirstName LastName, Company Name`\n_Example:_ `/discover Tom Cowan, TDM Growth Partners`'
        }));
        return;
      }
      
      // Parse input
      const { firstName, lastName, company, domain } = parseInput(text);
      
      if (!firstName || !lastName) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response_type: 'ephemeral',
          text: '❌ Please provide at least a first and last name.\n_Example:_ `/discover Tom Cowan, TDM Growth Partners`'
        }));
        return;
      }
      
      // Respond immediately (Slack requires response within 3 seconds)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response_type: 'in_channel',
        text: `🔍 Searching for *${firstName} ${lastName}*${company ? ` @ ${company}` : ''}...`
      }));
      
      // Do the actual discovery async and post back to response_url
      setImmediate(async () => {
        try {
          const results = discoverContact(firstName, lastName, company, domain);
          const response = formatSlackResponse(results);
          
          // Post back to Slack
          if (response_url) {
            curlPost(response_url, { 'Content-Type': 'application/json' }, response);
          }
          
          console.log(`\x1b[32m✅ Found: ${results.emails.length} emails, ${results.phones.length} phones (${results.duration}ms)\x1b[0m`);
        } catch (err) {
          console.error('Discovery error:', err);
          if (response_url) {
            curlPost(response_url, { 'Content-Type': 'application/json' }, {
              response_type: 'ephemeral',
              text: `❌ Error: ${err.message}`
            });
          }
        }
      });
    });
    return;
  }
  
  // Direct API access (for testing)
  if (parsed.pathname === '/api/discover') {
    const q = parsed.query;
    if (!q.firstName || !q.lastName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'firstName and lastName required' }));
      return;
    }
    
    const results = discoverContact(q.firstName, q.lastName, q.company || '', q.domain || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }
  
  // Home page with setup instructions
  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Contact Discovery Slack Bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #4ecdc4; }
    code { background: #16213e; padding: 2px 8px; border-radius: 4px; color: #4ecdc4; }
    pre { background: #16213e; padding: 15px; border-radius: 8px; overflow-x: auto; }
    .step { background: #16213e; padding: 20px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #4ecdc4; }
    .step h3 { margin-top: 0; color: #4ecdc4; }
    a { color: #4ecdc4; }
  </style>
</head>
<body>
  <h1>🔍 Contact Discovery Slack Bot</h1>
  <p>Find contact info (emails, phones, LinkedIn) for AU/NZ business contacts directly from Slack.</p>
  
  <h2>Setup Instructions</h2>
  
  <div class="step">
    <h3>Step 1: Create Slack App</h3>
    <p>Go to <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> → Create New App → From scratch</p>
  </div>
  
  <div class="step">
    <h3>Step 2: Add Slash Command</h3>
    <p>In your app settings → Slash Commands → Create New Command</p>
    <ul>
      <li><strong>Command:</strong> <code>/discover</code></li>
      <li><strong>Request URL:</strong> <code>https://YOUR-SERVER/slack/command</code></li>
      <li><strong>Description:</strong> Discover contact info for a person</li>
      <li><strong>Usage Hint:</strong> FirstName LastName, Company Name</li>
    </ul>
  </div>
  
  <div class="step">
    <h3>Step 3: Install App</h3>
    <p>OAuth & Permissions → Install to Workspace</p>
    <p>Copy the <strong>Signing Secret</strong> from Basic Information</p>
  </div>
  
  <div class="step">
    <h3>Step 4: Configure Environment</h3>
    <pre>SLACK_SIGNING_SECRET=your-signing-secret</pre>
  </div>
  
  <h2>Usage</h2>
  <pre>/discover Tom Cowan, TDM Growth Partners
/discover Myles Glashier @ Phocas Software
/discover John Smith at Atlassian</pre>
  
  <h2>API Endpoints</h2>
  <ul>
    <li><code>POST /slack/command</code> - Slack slash command handler</li>
    <li><code>GET /api/discover?firstName=X&lastName=Y&company=Z</code> - Direct API</li>
    <li><code>GET /health</code> - Health check</li>
  </ul>
  
  <p style="margin-top: 40px; color: #666;">Powered by SerpAPI, Apollo.io, and Firmable</p>
</body>
</html>`);
    return;
  }
  
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`
\x1b[1m┌─────────────────────────────────────────────────┐
│                                                 │
│   🔍 Contact Discovery Slack Bot                │
│                                                 │
│   Server: http://localhost:${PORT}                  │
│   Slack:  POST /slack/command                   │
│   API:    GET /api/discover                     │
│                                                 │
│   APIs: SerpAPI ✓  Apollo ✓  Firmable ✓         │
│                                                 │
└─────────────────────────────────────────────────┘\x1b[0m
  `);
});
