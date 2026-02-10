#!/usr/bin/env node
/**
 * Contact Discovery Web App v3
 * 
 * Working API integrations:
 *   - SerpAPI (Google.com.au search for LinkedIn profiles)
 *   - Apollo.io (verified emails, personal emails)
 *   - Firmable (AU/NZ company data, emails, phones) - Bearer auth
 * 
 * Usage:
 *   node webapp.js
 *   Then open http://localhost:3000
 */

const http = require('http');
const { execSync } = require('child_process');
const url = require('url');

const PORT = process.env.PORT || 3000;

const config = {
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
// HTTP CLIENT (uses curl to avoid Node SSL issues in some environments)
// ============================================================================

function curlGet(reqUrl, headers = {}) {
  try {
    let cmd = `curl -skL --max-time 15`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    cmd += ` "${reqUrl}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    return JSON.parse(result);
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

function curlPost(reqUrl, headers = {}, body = {}) {
  try {
    let cmd = `curl -skL --max-time 15 -X POST`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    cmd += ` -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
    cmd += ` "${reqUrl}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    return JSON.parse(result);
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

// ============================================================================
// NICKNAME MAP
// ============================================================================

const nicknameMap = {
  'bob': 'robert', 'rob': 'robert', 'bill': 'william', 'will': 'william',
  'mike': 'michael', 'mick': 'michael', 'jim': 'james', 'jimmy': 'james',
  'tom': 'thomas', 'steve': 'steven', 'dave': 'david', 'dan': 'daniel',
  'tony': 'anthony', 'joe': 'joseph', 'chris': 'christopher', 'matt': 'matthew',
  'nick': 'nicholas', 'alex': 'alexander', 'sam': 'samuel', 'ben': 'benjamin',
  'jack': 'john', 'johnny': 'john', 'pete': 'peter', 'andy': 'andrew',
  'greg': 'gregory', 'jeff': 'jeffrey', 'liz': 'elizabeth', 'beth': 'elizabeth',
  'kate': 'katherine', 'katie': 'katherine', 'meg': 'margaret', 'sue': 'susan',
  'jen': 'jennifer', 'jenny': 'jennifer', 'pat': 'patricia',
};

function getNameVariants(name) {
  const lower = name.toLowerCase();
  const variants = [name];
  if (nicknameMap[lower]) variants.push(nicknameMap[lower].charAt(0).toUpperCase() + nicknameMap[lower].slice(1));
  Object.entries(nicknameMap).forEach(([nick, full]) => {
    if (full === lower) variants.push(nick.charAt(0).toUpperCase() + nick.slice(1));
  });
  return [...new Set(variants)];
}

// ============================================================================
// DISCOVERY ENGINE
// ============================================================================

function discoverContact(person) {
  const startTime = Date.now();
  const log = [];

  if (!person.location) person.location = 'Australia';

  const results = {
    input: person,
    linkedin: person.linkedinUrl || null,
    linkedinConfidence: null,
    linkedinTitle: null,
    emails: [],
    phones: [],
    companyInfo: null,
    sources: { serp: { status: 'pending' }, apollo: { status: 'pending' }, firmable: { status: 'pending' } },
    log: [],
    metadata: { timestamp: new Date().toISOString(), duration_ms: 0 },
  };

  // ── Phase 1: SerpAPI LinkedIn Search ──────────────────────────────
  log.push({ phase: 1, name: 'Web Search (SerpAPI)' });

  try {
    const nameVariants = getNameVariants(person.firstName);
    const queries = [
      `${person.firstName} ${person.lastName} ${person.company} linkedin site:linkedin.com/in`,
    ];
    if (nameVariants.length > 1) {
      queries.push(`${nameVariants[1]} ${person.lastName} ${person.company} linkedin site:linkedin.com/in`);
    }

    let bestLinkedin = null;
    let bestScore = 0;

    for (const query of queries) {
      const serpUrl = `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(query)}&num=10&gl=au&google_domain=google.com.au`;
      const serpData = curlGet(serpUrl);

      if (serpData._error) {
        log.push({ phase: 1, msg: `SerpAPI error: ${serpData.message}` });
        results.sources.serp = { status: 'error', error: serpData.message };
        continue;
      }

      if (serpData.organic_results) {
        for (const r of serpData.organic_results) {
          if (!r.link?.includes('linkedin.com/in/')) continue;

          let score = 0;
          const titleLower = (r.title || '').toLowerCase();
          const urlLower = (r.link || '').toLowerCase();
          const firstLower = person.firstName.toLowerCase();
          const lastLower = person.lastName.toLowerCase();

          if (titleLower.includes(firstLower)) score += 25;
          if (titleLower.includes(lastLower)) score += 25;
          if (urlLower.includes(lastLower)) score += 15;
          if (person.company && titleLower.includes(person.company.toLowerCase())) score += 25;
          if (person.title && titleLower.includes(person.title.toLowerCase())) score += 10;

          if (score > bestScore) {
            bestScore = score;
            bestLinkedin = { url: r.link, title: r.title, score };
          }
        }
      }

      if (bestScore >= 50) break;
    }

    if (bestLinkedin) {
      results.linkedin = bestLinkedin.url;
      results.linkedinConfidence = Math.min(bestLinkedin.score / 100, 0.99);
      results.linkedinTitle = bestLinkedin.title;
      results.sources.serp = { status: 'success' };
      log.push({ phase: 1, msg: `Found LinkedIn: ${bestLinkedin.url} (${Math.round(results.linkedinConfidence * 100)}%)` });
    } else {
      results.sources.serp = { status: 'success', note: 'No LinkedIn match' };
      log.push({ phase: 1, msg: 'No LinkedIn profile found' });
    }
  } catch (err) {
    results.sources.serp = { status: 'error', error: err.message };
    log.push({ phase: 1, msg: `Error: ${err.message}` });
  }

  // ── Phase 2: Apollo.io ────────────────────────────────────────────
  log.push({ phase: 2, name: 'Apollo.io' });

  try {
    const apolloBody = {
      first_name: person.firstName,
      last_name: person.lastName,
      organization_name: person.company,
      reveal_personal_emails: true,
    };
    if (person.domain) apolloBody.domain = person.domain;
    if (results.linkedin) apolloBody.linkedin_url = results.linkedin;

    const apolloData = curlPost(
      'https://api.apollo.io/api/v1/people/match',
      { 'x-api-key': config.apollo.apiKey, 'Content-Type': 'application/json' },
      apolloBody
    );

    if (apolloData._error) {
      results.sources.apollo = { status: 'error', error: apolloData.message };
      log.push({ phase: 2, msg: `Apollo error: ${apolloData.message}` });
    } else if (apolloData.person) {
      const p = apolloData.person;
      results.sources.apollo = { status: 'success', matched: p.name, headline: p.headline };

      log.push({ phase: 2, msg: `Matched: ${p.name}${p.headline ? ' — ' + p.headline : ''}` });

      if (p.email) {
        results.emails.push({ email: p.email, source: 'Apollo', type: 'work', status: p.email_status, confidence: p.email_status === 'verified' ? 0.95 : 0.7 });
        log.push({ phase: 2, msg: `Email: ${p.email} (${p.email_status})` });
      }
      if (p.personal_emails?.length) {
        p.personal_emails.forEach(e => {
          results.emails.push({ email: e, source: 'Apollo', type: 'personal', confidence: 0.7 });
          log.push({ phase: 2, msg: `Personal email: ${e}` });
        });
      }
      if (p.phone_numbers?.length) {
        p.phone_numbers.forEach(ph => {
          results.phones.push({ number: ph.raw_number || ph.sanitized_number, source: 'Apollo', type: ph.type || 'mobile', confidence: 0.85 });
          log.push({ phase: 2, msg: `Phone: ${ph.raw_number || ph.sanitized_number}` });
        });
      }
      if (p.linkedin_url && !results.linkedin) {
        results.linkedin = p.linkedin_url;
      }
    } else {
      results.sources.apollo = { status: 'success', note: 'No match' };
      log.push({ phase: 2, msg: 'No match found' });
    }
  } catch (err) {
    results.sources.apollo = { status: 'error', error: err.message };
    log.push({ phase: 2, msg: `Error: ${err.message}` });
  }

  // ── Phase 3: Firmable (AU/NZ) — Bearer auth, /company endpoint ───
  log.push({ phase: 3, name: 'Firmable (AU/NZ)' });

  try {
    let searchDomain = person.domain;

    // Auto-discover domain if not provided
    if (!searchDomain && person.company) {
      const companyClean = person.company.toLowerCase().replace(/[^a-z0-9]/g, '');
      const candidates = [
        `${companyClean}.com.au`,
        `${companyClean}.com`,
        `${companyClean}.au`,
        `${companyClean}.io`,
      ];

      for (const candidate of candidates) {
        const test = curlGet(
          `https://api.firmable.com/company?website=${encodeURIComponent(candidate)}`,
          { 'Authorization': `Bearer ${config.firmable.apiKey}` }
        );
        if (test.id) {
          searchDomain = candidate;
          log.push({ phase: 3, msg: `Domain auto-discovered: ${candidate}` });
          break;
        }
      }
    }

    if (searchDomain) {
      const firmData = curlGet(
        `https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`,
        { 'Authorization': `Bearer ${config.firmable.apiKey}` }
      );

      if (firmData._error) {
        results.sources.firmable = { status: 'error', error: firmData.message };
        log.push({ phase: 3, msg: `Error: ${firmData.message}` });
      } else if (firmData.id) {
        results.sources.firmable = { status: 'success' };
        results.companyInfo = {
          name: firmData.name,
          address: firmData.hq_location,
          website: firmData.website,
          employees: firmData.au_employee_count,
          industries: firmData.industries,
          abn: firmData.industry_codes?.abn,
          acn: firmData.industry_codes?.acn,
          linkedin: firmData.social_media?.linkedin,
          founded: firmData.year_founded,
          size: firmData.company_size,
        };

        log.push({ phase: 3, msg: `Company: ${firmData.name}` });
        if (firmData.hq_location) log.push({ phase: 3, msg: `Address: ${firmData.hq_location}` });

        // Match company emails to person
        if (firmData.emails?.length) {
          const firstLower = person.firstName.toLowerCase();
          const lastLower = person.lastName.toLowerCase();

          firmData.emails.forEach(email => {
            const emailLower = email.toLowerCase();
            const isPersonMatch =
              emailLower.includes(firstLower + '.' + lastLower) ||
              emailLower.includes(firstLower[0] + '.' + lastLower) ||
              emailLower.includes(firstLower[0] + lastLower) ||
              emailLower.includes(firstLower) && emailLower.includes(lastLower);

            if (isPersonMatch) {
              results.emails.push({ email, source: 'Firmable', type: 'work', confidence: 0.9 });
              log.push({ phase: 3, msg: `Email (person match): ${email}` });
            } else {
              results.emails.push({ email, source: 'Firmable', type: 'company', confidence: 0.4 });
              log.push({ phase: 3, msg: `Email (company): ${email}` });
            }
          });
        }

        // Company phones
        if (firmData.phones?.length) {
          firmData.phones.forEach(phone => {
            results.phones.push({ number: phone, source: 'Firmable', type: 'company', confidence: 0.8 });
            log.push({ phase: 3, msg: `Phone: ${phone}` });
          });
        }
      } else if (firmData.error) {
        results.sources.firmable = { status: 'error', error: firmData.error };
        log.push({ phase: 3, msg: `Firmable: ${firmData.error}` });
      } else {
        results.sources.firmable = { status: 'success', note: 'Company not found' };
        log.push({ phase: 3, msg: 'Company not found' });
      }
    } else {
      results.sources.firmable = { status: 'success', note: 'No domain found' };
      log.push({ phase: 3, msg: 'Could not determine company domain' });
    }
  } catch (err) {
    results.sources.firmable = { status: 'error', error: err.message };
    log.push({ phase: 3, msg: `Error: ${err.message}` });
  }

  // ── Deduplicate & sort ────────────────────────────────────────────
  const emailMap = {};
  results.emails.forEach(e => {
    const key = e.email.toLowerCase();
    if (!emailMap[key]) {
      emailMap[key] = { ...e, sources: [e.source] };
    } else {
      emailMap[key].sources.push(e.source);
      emailMap[key].confidence = Math.min((emailMap[key].confidence || 0.5) + 0.15, 1.0);
      if (e.status === 'verified') emailMap[key].status = 'verified';
      if (e.type === 'work' && emailMap[key].type !== 'work') emailMap[key].type = 'work';
    }
  });
  results.emails = Object.values(emailMap).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const phoneMap = {};
  results.phones.forEach(p => {
    const key = p.number.replace(/\D/g, '');
    if (!phoneMap[key]) {
      phoneMap[key] = { ...p, sources: [p.source] };
    } else {
      phoneMap[key].sources.push(p.source);
      phoneMap[key].confidence = Math.min((phoneMap[key].confidence || 0.5) + 0.15, 1.0);
    }
  });
  results.phones = Object.values(phoneMap).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  results.log = log;
  results.metadata.duration_ms = Date.now() - startTime;
  return results;
}

// ============================================================================
// HTML
// ============================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contact Discovery</title>
  <style>
    :root{--bg:#0f1117;--bg2:#1a1d27;--bg3:#232733;--border:rgba(255,255,255,0.08);--text:#e4e4e7;--text2:#a1a1aa;--accent:#3b82f6;--accent2:#8b5cf6;--green:#22c55e;--red:#ef4444}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .header{padding:20px 0;text-align:center;border-bottom:1px solid var(--border)}
    .header h1{font-size:1.8em;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .header p{color:var(--text2);font-size:.9em;margin-top:4px}
    .container{max-width:960px;margin:0 auto;padding:20px}
    .search-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:24px}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .form-group{display:flex;flex-direction:column;gap:4px}
    .form-group.full{grid-column:1/-1}
    .form-group label{font-size:.8em;color:var(--text2);font-weight:500;text-transform:uppercase;letter-spacing:.05em}
    .form-group input{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:.95em;transition:border-color .15s}
    .form-group input:focus{outline:none;border-color:var(--accent)}
    .form-group input::placeholder{color:#555}
    .search-btn{grid-column:1/-1;margin-top:8px;padding:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-size:1em;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s}
    .search-btn:hover{opacity:.9;transform:translateY(-1px)}
    .search-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
    .loading{display:none;text-align:center;padding:48px 20px}
    .loading.show{display:block}
    .spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .loading .phase{color:var(--accent);font-weight:500;margin-top:8px;font-size:.95em}
    .results{display:none}
    .results.show{display:block}
    .result-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px}
    .person-header{display:flex;align-items:center;gap:16px;padding:20px 24px;border-bottom:1px solid var(--border)}
    .avatar{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:1.2em;font-weight:700;color:#fff;flex-shrink:0}
    .person-header h2{font-size:1.3em;margin-bottom:2px}
    .person-header .meta{color:var(--text2);font-size:.9em}
    .section{padding:16px 24px;border-bottom:1px solid var(--border)}
    .section:last-child{border-bottom:none}
    .section-label{font-size:.75em;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px}
    .contact-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg);border-radius:6px;margin-bottom:6px}
    .contact-row:last-child{margin-bottom:0}
    .contact-value{font-family:'SF Mono',Consolas,monospace;font-size:.9em}
    .contact-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.72em;font-weight:600;white-space:nowrap}
    .badge-source{background:rgba(139,92,246,.15);color:#a78bfa}
    .badge-verified{background:rgba(34,197,94,.15);color:#4ade80}
    .badge-confidence{background:rgba(59,130,246,.12);color:#60a5fa}
    .badge-personal{background:rgba(234,179,8,.15);color:#facc15}
    .badge-company{background:rgba(100,116,139,.2);color:#94a3b8}
    .copy-btn{background:var(--bg3);border:1px solid var(--border);padding:3px 10px;border-radius:4px;color:var(--text2);cursor:pointer;font-size:.75em;transition:all .15s}
    .copy-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
    .copy-btn.copied{background:var(--green);color:#fff;border-color:var(--green)}
    .linkedin-btn{display:inline-flex;align-items:center;gap:8px;background:#0a66c2;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:500;font-size:.9em;transition:background .15s}
    .linkedin-btn:hover{background:#004182}
    .sources-bar{display:flex;gap:20px;padding:14px 24px;border-top:1px solid var(--border)}
    .source-item{display:flex;align-items:center;gap:6px;font-size:.85em;color:var(--text2)}
    .source-dot{width:8px;height:8px;border-radius:50%}
    .source-dot.success{background:var(--green)}
    .source-dot.error{background:var(--red)}
    .source-dot.skip{background:#555}
    .duration{text-align:right;color:#555;font-size:.8em;padding:8px 24px}
    .company-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:16px}
    .company-card h3{font-size:1.1em;margin-bottom:12px;color:var(--accent)}
    .company-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .company-field{font-size:.85em}
    .company-field .label{color:var(--text2)}
    .company-field .value{color:var(--text)}
    .log-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin-top:16px}
    .log-toggle{background:none;border:none;color:var(--text2);cursor:pointer;font-size:.85em;padding:0;display:flex;align-items:center;gap:6px}
    .log-toggle:hover{color:var(--text)}
    .log-entries{display:none;margin-top:12px;font-family:monospace;font-size:.8em;line-height:1.8;color:var(--text2)}
    .log-entries.show{display:block}
    .log-phase{color:var(--accent);font-weight:600}
    .empty-state{padding:20px;text-align:center;color:#555;font-size:.9em}
    .error-msg{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);padding:12px 16px;border-radius:8px;color:#fca5a5;margin-bottom:16px;display:none;font-size:.9em}
    .error-msg.show{display:block}
    @media(max-width:600px){.form-grid{grid-template-columns:1fr}.company-grid{grid-template-columns:1fr}.contact-row{flex-direction:column;align-items:flex-start;gap:6px}}
  </style>
</head>
<body>
  <div class="header">
    <h1>&#128270; Contact Discovery</h1>
    <p>Find emails &amp; phone numbers for business contacts &mdash; Australia-first</p>
  </div>
  <div class="container">
    <div class="search-card">
      <div class="form-grid">
        <div class="form-group"><label>First Name *</label><input type="text" id="firstName" placeholder="John" autofocus></div>
        <div class="form-group"><label>Last Name *</label><input type="text" id="lastName" placeholder="Smith"></div>
        <div class="form-group"><label>Company</label><input type="text" id="company" placeholder="Acme Corp"></div>
        <div class="form-group"><label>Company Domain</label><input type="text" id="domain" placeholder="acmecorp.com.au"></div>
        <div class="form-group"><label>Title</label><input type="text" id="title" placeholder="CEO"></div>
        <div class="form-group"><label>Location</label><input type="text" id="location" placeholder="Sydney" value="Australia"></div>
        <div class="form-group full"><label>LinkedIn URL (optional)</label><input type="text" id="linkedin" placeholder="https://linkedin.com/in/..."></div>
        <button class="search-btn" id="searchBtn" onclick="discover()">&#128640; Discover Contact</button>
      </div>
    </div>
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div style="color:var(--text2)">Searching across data sources...</div>
      <div class="phase" id="loadingPhase">Phase 1: Web Search</div>
    </div>
    <div class="error-msg" id="errorMsg"></div>
    <div class="results" id="results"></div>
  </div>
  <script>
    async function discover(){
      const btn=document.getElementById('searchBtn'),loading=document.getElementById('loading'),results=document.getElementById('results'),errorMsg=document.getElementById('errorMsg');
      const f={firstName:document.getElementById('firstName').value.trim(),lastName:document.getElementById('lastName').value.trim(),company:document.getElementById('company').value.trim(),domain:document.getElementById('domain').value.trim(),title:document.getElementById('title').value.trim(),location:document.getElementById('location').value.trim()||'Australia',linkedin:document.getElementById('linkedin').value.trim()};
      if(!f.firstName||!f.lastName){errorMsg.textContent='First name and last name are required.';errorMsg.classList.add('show');return}
      btn.disabled=true;loading.classList.add('show');results.classList.remove('show');results.innerHTML='';errorMsg.classList.remove('show');
      const phases=['Phase 1: Web Search (SerpAPI)','Phase 2: Apollo.io Enrichment','Phase 3: Firmable AU/NZ Data','Consolidating results...'];
      let pi=0;const iv=setInterval(()=>{pi=(pi+1)%phases.length;document.getElementById('loadingPhase').textContent=phases[pi]},2500);
      try{const resp=await fetch('/api/discover?'+new URLSearchParams(f));const data=await resp.json();clearInterval(iv);if(data.error)throw new Error(data.error);render(data)}catch(err){clearInterval(iv);errorMsg.textContent=err.message;errorMsg.classList.add('show')}finally{btn.disabled=false;loading.classList.remove('show')}
    }
    function render(d){
      const el=document.getElementById('results'),p=d.input,initials=((p.firstName||'')[0]||'')+((p.lastName||'')[0]||''),meta=[p.title,p.company,p.location].filter(Boolean).join(' \\u00b7 ');
      let h='<div class="result-card"><div class="person-header"><div class="avatar">'+initials.toUpperCase()+'</div><div><h2>'+esc(p.firstName+' '+p.lastName)+'</h2><div class="meta">'+esc(meta)+'</div></div></div>';
      if(d.linkedin){const conf=d.linkedinConfidence?' ('+Math.round(d.linkedinConfidence*100)+'% match)':'';h+='<div class="section"><div class="section-label">LinkedIn Profile</div><a href="'+esc(d.linkedin)+'" target="_blank" class="linkedin-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>View Profile</a>';if(d.linkedinTitle)h+=' <span style="color:var(--text2);font-size:.85em;margin-left:8px">'+esc(d.linkedinTitle)+'</span>';h+='<span class="badge badge-confidence" style="margin-left:8px">'+esc(conf)+'</span></div>'}
      h+='<div class="section"><div class="section-label">&#128231; Email Addresses</div>';
      if(d.emails?.length){d.emails.forEach(e=>{h+='<div class="contact-row"><span class="contact-value">'+esc(e.email)+'</span><div class="contact-meta"><span class="badge badge-source">'+esc((e.sources||[e.source]).join(', '))+'</span>';if(e.status==='verified')h+='<span class="badge badge-verified">\\u2713 Verified</span>';if(e.type==='personal')h+='<span class="badge badge-personal">Personal</span>';if(e.type==='company')h+='<span class="badge badge-company">Company</span>';h+='<span class="badge badge-confidence">'+Math.round((e.confidence||0)*100)+'%</span><button class="copy-btn" onclick="copyVal(this,\''+esc(e.email)+'\')">Copy</button></div></div>'})}else{h+='<div class="empty-state">No emails found</div>'}h+='</div>';
      h+='<div class="section"><div class="section-label">&#128241; Phone Numbers</div>';
      if(d.phones?.length){d.phones.forEach(ph=>{h+='<div class="contact-row"><span class="contact-value">'+esc(ph.number)+'</span><div class="contact-meta"><span class="badge badge-source">'+esc((ph.sources||[ph.source]).join(', '))+'</span>';if(ph.type)h+='<span class="badge badge-company">'+esc(ph.type)+'</span>';h+='<span class="badge badge-confidence">'+Math.round((ph.confidence||0)*100)+'%</span><button class="copy-btn" onclick="copyVal(this,\''+esc(ph.number)+'\')">Copy</button></div></div>'})}else{h+='<div class="empty-state">No phone numbers found</div>'}h+='</div>';
      h+='<div class="sources-bar">';['serp','apollo','firmable'].forEach(s=>{const src=d.sources?.[s]||{};const st=src.status==='success'?'success':src.status==='error'?'error':'skip';const lb=s==='serp'?'SerpAPI':s.charAt(0).toUpperCase()+s.slice(1);h+='<div class="source-item"><div class="source-dot '+st+'"></div>'+lb+'</div>'});
      h+='</div><div class="duration">Completed in '+(d.metadata?.duration_ms||0)+'ms</div></div>';
      if(d.companyInfo){const c=d.companyInfo;h+='<div class="company-card"><h3>&#127970; '+esc(c.name||'Company')+'</h3><div class="company-grid">';if(c.address)h+='<div class="company-field"><span class="label">Address: </span><span class="value">'+esc(c.address)+'</span></div>';if(c.website)h+='<div class="company-field"><span class="label">Website: </span><span class="value">'+esc(c.website)+'</span></div>';if(c.employees)h+='<div class="company-field"><span class="label">AU Employees: </span><span class="value">'+c.employees+'</span></div>';if(c.size)h+='<div class="company-field"><span class="label">Size: </span><span class="value">'+esc(c.size)+'</span></div>';if(c.founded)h+='<div class="company-field"><span class="label">Founded: </span><span class="value">'+c.founded+'</span></div>';if(c.abn)h+='<div class="company-field"><span class="label">ABN: </span><span class="value">'+esc(c.abn)+'</span></div>';if(c.acn)h+='<div class="company-field"><span class="label">ACN: </span><span class="value">'+esc(c.acn)+'</span></div>';if(c.industries?.length)h+='<div class="company-field" style="grid-column:1/-1"><span class="label">Industries: </span><span class="value">'+esc(c.industries.join(', '))+'</span></div>';h+='</div></div>'}
      if(d.log?.length){h+='<div class="log-card"><button class="log-toggle" onclick="this.nextElementSibling.classList.toggle(\'show\')">\\u25b6 Discovery Log ('+d.log.length+' entries)</button><div class="log-entries">';d.log.forEach(l=>{if(l.name){h+='<div class="log-entry"><span class="log-phase">Phase '+l.phase+': '+esc(l.name)+'</span></div>'}else{h+='<div class="log-entry">&nbsp;&nbsp;'+esc(l.msg||'')+'</div>'}});h+='</div></div>'}
      el.innerHTML=h;el.classList.add('show')
    }
    function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
    function copyVal(btn,text){navigator.clipboard.writeText(text).then(()=>{btn.textContent='Copied!';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},2000)})}
    document.querySelectorAll('input').forEach(i=>{i.addEventListener('keypress',e=>{if(e.key==='Enter')discover()})})
  </script>
</body>
</html>`;

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (parsed.pathname === '/api/discover') {
    const q = parsed.query;
    if (!q.firstName || !q.lastName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'firstName and lastName are required' }));
      return;
    }

    const person = {
      firstName: q.firstName, lastName: q.lastName,
      company: q.company || '', domain: q.domain || null,
      title: q.title || '', location: q.location || 'Australia',
      linkedinUrl: q.linkedin || null,
    };

    console.log(`\n\\x1b[36m\\x1b[1m🔍 Discovering: ${person.firstName} ${person.lastName} @ ${person.company || 'Unknown'}\\x1b[0m`);

    try {
      const results = discoverContact(person);
      console.log(`\\x1b[32m✅ Found: ${results.emails.length} emails, ${results.phones.length} phones (${results.metadata.duration_ms}ms)\\x1b[0m`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (err) {
      console.error('Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', apis: Object.keys(config) }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`
\\x1b[1m┌─────────────────────────────────────────┐
│                                         │
│   🔍 Contact Discovery Web App v3       │
│                                         │
│   http://localhost:${PORT}                  │
│                                         │
│   APIs: SerpAPI ✓  Apollo ✓  Firmable ✓ │
│                                         │
└─────────────────────────────────────────┘\\x1b[0m
  `);
});
