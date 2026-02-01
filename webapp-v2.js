#!/usr/bin/env node
/**
 * Contact Discovery Web App v4
 * 
 * Features:
 *   1. /discover - Person lookup (existing)
 *   2. /prospect - Find new leads by criteria (Apollo FREE)
 *   3. /company - Full company intelligence
 *   4. /linkedin - LinkedIn URL → contact info
 * 
 * APIs: SerpAPI, Apollo.io, Firmable, Lusha
 */

const http = require('http');
const { execSync } = require('child_process');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const config = {
  serp: { apiKey: process.env.SERP_API_KEY || '76d491d95fe5a98fd8a86f9a2a1d722c191fdc4aafb7047d32ef166ee887049b' },
  apollo: { apiKey: process.env.APOLLO_API_KEY || '9J2iMFgV58TQXeE9PpetLg' },
  firmable: { apiKey: process.env.FIRMABLE_API_KEY || 'fbl_2GUDMcb9SDhv3FX5WM6dTV' },
  lusha: { apiKey: process.env.LUSHA_API_KEY || '5522a219-a387-4df9-ab7c-19b92b3640f3' },
  slack: { signingSecret: process.env.SLACK_SIGNING_SECRET || '' },
};

// ============================================================================
// HTTP CLIENT
// ============================================================================

function curlGet(reqUrl, headers = {}) {
  try {
    let cmd = `curl -sk --max-time 20`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    cmd += ` "${reqUrl}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 25000 });
    return JSON.parse(result);
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

function curlPost(reqUrl, headers = {}, body = {}) {
  try {
    let cmd = `curl -sk --max-time 20 -X POST`;
    Object.entries(headers).forEach(([k, v]) => { cmd += ` -H "${k}: ${v}"`; });
    const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''");
    cmd += ` -d '${bodyStr}' "${reqUrl}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 25000 });
    return JSON.parse(result);
  } catch (err) {
    return { _error: true, message: err.message?.substring(0, 200) };
  }
}

// ============================================================================
// 1. DISCOVER - Person lookup (existing functionality enhanced)
// ============================================================================

function discoverPerson(firstName, lastName, company, domain, linkedinUrl) {
  const start = Date.now();
  const results = {
    firstName, lastName, company,
    linkedin: linkedinUrl || null,
    linkedinTitle: null,
    emails: [],
    phones: [],
    companyInfo: null,
    sources: {},
  };

  // Phase 1: SerpAPI LinkedIn search (if no LinkedIn provided)
  if (!results.linkedin) {
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
      results.sources.serp = { status: 'success' };
    } catch (e) { results.sources.serp = { status: 'error', error: e.message }; }
  }

  // Phase 2: Apollo.io enrichment
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/v1/people/match',
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { first_name: firstName, last_name: lastName, organization_name: company, domain, reveal_personal_emails: true, reveal_phone_number: true }
    );
    if (apolloData.person) {
      if (apolloData.person.email) {
        results.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified', confidence: 0.95 });
      }
      if (apolloData.person.personal_emails?.length) {
        apolloData.person.personal_emails.forEach(e => results.emails.push({ email: e, source: 'Apollo', type: 'personal', confidence: 0.8 }));
      }
      if (apolloData.person.phone_numbers?.length) {
        apolloData.person.phone_numbers.forEach(p => results.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo', type: p.type, confidence: 0.85 }));
      }
      if (!results.linkedin && apolloData.person.linkedin_url) {
        results.linkedin = apolloData.person.linkedin_url;
      }
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error', error: e.message }; }

  // Phase 3: Lusha enrichment
  try {
    const lushaParams = new URLSearchParams({
      firstName, lastName,
      ...(company && { companyName: company }),
      ...(domain && { companyDomain: domain }),
      ...(results.linkedin && { linkedinUrl: results.linkedin }),
      revealEmails: 'true',
      revealPhones: 'true',
    });
    const lushaData = curlGet(
      `https://api.lusha.com/v2/person?${lushaParams}`,
      { 'api_key': config.lusha.apiKey }
    );
    if (lushaData.data) {
      if (lushaData.data.emailAddresses?.length) {
        lushaData.data.emailAddresses.forEach(e => {
          if (!results.emails.find(x => x.email === e.email)) {
            results.emails.push({ email: e.email, source: 'Lusha', type: e.type, confidence: 0.9 });
          }
        });
      }
      if (lushaData.data.phoneNumbers?.length) {
        lushaData.data.phoneNumbers.forEach(p => {
          if (!results.phones.find(x => x.number === p.localizedNumber || x.number === p.internationalNumber)) {
            results.phones.push({ number: p.internationalNumber || p.localizedNumber, source: 'Lusha', type: p.type, confidence: 0.9 });
          }
        });
      }
    }
    results.sources.lusha = { status: 'success' };
  } catch (e) { results.sources.lusha = { status: 'error', error: e.message }; }

  // Phase 4: Firmable (AU/NZ)
  try {
    let searchDomain = domain;
    if (!searchDomain && company) {
      const guesses = [company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au', company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com'];
      for (const guess of guesses) {
        const test = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(guess)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
        if (test.id) { searchDomain = guess; break; }
      }
    }
    if (searchDomain) {
      const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
      if (firmData.id) {
        results.companyInfo = {
          name: firmData.name, website: firmData.website, domain: firmData.fqdn,
          employees: firmData.au_employee_count, founded: firmData.year_founded,
          description: firmData.description?.substring(0, 300), linkedin: firmData.linkedin,
          abn: firmData.abn, acn: firmData.acn, phone: firmData.phone,
        };
        if (firmData.phone && !results.phones.find(p => p.number === firmData.phone)) {
          results.phones.push({ number: firmData.phone, source: 'Firmable', type: 'company', confidence: 0.9 });
        }
      }
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error', error: e.message }; }

  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// 2. PROSPECT - Find new leads by criteria (Apollo People Search - FREE)
// ============================================================================

function prospectPeople(filters) {
  const start = Date.now();
  const { titles, locations, seniorities, industries, companySize, limit = 10 } = filters;

  const params = new URLSearchParams();
  if (titles?.length) titles.forEach(t => params.append('person_titles[]', t));
  if (locations?.length) locations.forEach(l => params.append('person_locations[]', l));
  if (seniorities?.length) seniorities.forEach(s => params.append('person_seniorities[]', s));
  if (industries?.length) industries.forEach(i => params.append('organization_industry_tag_ids[]', i));
  if (companySize) {
    if (companySize.min) params.append('organization_num_employees_ranges[]', `${companySize.min},${companySize.max || 10000}`);
  }
  params.append('per_page', Math.min(limit, 25).toString());
  params.append('page', '1');

  const results = { prospects: [], total: 0, duration: 0, sources: {} };

  try {
    const apolloData = curlPost(
      `https://api.apollo.io/api/v1/mixed_people/api_search?${params}`,
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      {}
    );

    if (apolloData.people?.length) {
      results.total = apolloData.pagination?.total_entries || apolloData.people.length;
      results.prospects = apolloData.people.slice(0, limit).map(p => ({
        id: p.id,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        firstName: p.first_name,
        lastName: p.last_name,
        title: p.title,
        seniority: p.seniority,
        company: p.organization?.name,
        companyDomain: p.organization?.primary_domain,
        companySize: p.organization?.estimated_num_employees,
        linkedin: p.linkedin_url,
        location: p.city ? `${p.city}, ${p.state || p.country}` : p.country,
        // Note: Apollo search doesn't return emails/phones - need to enrich separately
      }));
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) {
    results.sources.apollo = { status: 'error', error: e.message };
  }

  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// 3. COMPANY - Full company intelligence
// ============================================================================

function getCompanyIntel(domainOrName) {
  const start = Date.now();
  const results = {
    company: null,
    contacts: [],
    techStack: [],
    jobs: [],
    signals: [],
    sources: {},
  };

  // Normalize domain
  let domain = domainOrName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) {
    // It's a company name, not domain - try to find domain
    domain = domainOrName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }

  // Phase 1: Firmable company data (best for AU/NZ)
  try {
    const firmData = curlGet(
      `https://api.firmable.com/company?website=${encodeURIComponent(domain)}`,
      { 'Authorization': `Bearer ${config.firmable.apiKey}` }
    );
    if (firmData.id) {
      results.company = {
        id: firmData.id,
        name: firmData.name,
        domain: firmData.fqdn,
        website: firmData.website,
        description: firmData.description,
        founded: firmData.year_founded,
        employees: { au: firmData.au_employee_count, global: firmData.employee_count },
        abn: firmData.abn,
        acn: firmData.acn,
        phone: firmData.phone,
        linkedin: firmData.linkedin ? `https://linkedin.com/company/${firmData.linkedin}` : null,
        headquarters: firmData.hq_location,
        industries: firmData.industries || [],
      };
      if (firmData.technologies?.length) {
        results.techStack = firmData.technologies;
      }
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error', error: e.message }; }

  // Phase 2: Apollo organization data (global coverage)
  try {
    const apolloData = curlGet(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { 'x-api-key': config.apollo.apiKey }
    );
    if (apolloData.organization) {
      const org = apolloData.organization;
      if (!results.company) {
        results.company = {
          name: org.name,
          domain: org.primary_domain,
          website: org.website_url,
          description: org.short_description,
          founded: org.founded_year,
          employees: { global: org.estimated_num_employees },
          linkedin: org.linkedin_url,
          industries: org.industry ? [org.industry] : [],
        };
      } else {
        // Merge additional data
        if (!results.company.description) results.company.description = org.short_description;
        if (org.estimated_num_employees) results.company.employees.global = org.estimated_num_employees;
        if (org.industry && !results.company.industries.includes(org.industry)) {
          results.company.industries.push(org.industry);
        }
      }
      if (org.technologies?.length && !results.techStack.length) {
        results.techStack = org.technologies.map(t => t.name || t);
      }
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error', error: e.message }; }

  // Phase 3: Lusha company data
  try {
    const lushaData = curlGet(
      `https://api.lusha.com/v2/company?domain=${encodeURIComponent(domain)}`,
      { 'api_key': config.lusha.apiKey }
    );
    if (lushaData.data) {
      const co = lushaData.data;
      if (!results.company) {
        results.company = {
          name: co.name,
          domain: co.domain,
          description: co.description,
          employees: { global: co.employeeCount },
          industries: co.mainIndustry ? [co.mainIndustry] : [],
          funding: co.funding,
        };
      } else {
        if (co.funding) results.company.funding = co.funding;
        if (co.revenue) results.company.revenue = co.revenue;
      }
      if (co.technologies?.length && !results.techStack.length) {
        results.techStack = co.technologies;
      }
    }
    results.sources.lusha = { status: 'success' };
  } catch (e) { results.sources.lusha = { status: 'error', error: e.message }; }

  // Phase 4: Apollo job postings
  try {
    const jobsData = curlGet(
      `https://api.apollo.io/v1/organizations/${encodeURIComponent(domain)}/job_postings`,
      { 'x-api-key': config.apollo.apiKey }
    );
    if (jobsData.job_postings?.length) {
      results.jobs = jobsData.job_postings.slice(0, 10).map(j => ({
        title: j.title,
        location: j.location,
        posted: j.posted_at,
        url: j.url,
      }));
    }
  } catch (e) { /* jobs are optional */ }

  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// 4. LINKEDIN - LinkedIn URL → contact info
// ============================================================================

function enrichLinkedIn(linkedinUrl) {
  const start = Date.now();
  const results = {
    person: null,
    emails: [],
    phones: [],
    company: null,
    sources: {},
  };

  // Normalize LinkedIn URL
  let liUrl = linkedinUrl.trim();
  if (!liUrl.startsWith('http')) liUrl = 'https://' + liUrl;
  if (!liUrl.includes('linkedin.com')) {
    return { error: 'Invalid LinkedIn URL', duration: Date.now() - start };
  }

  // Phase 1: Firmable People enrichment (best for AU mobiles)
  try {
    const firmData = curlGet(
      `https://api.firmable.com/people?ln_url=${encodeURIComponent(liUrl)}`,
      { 'Authorization': `Bearer ${config.firmable.apiKey}` }
    );
    if (firmData.id || firmData.first_name) {
      results.person = {
        firstName: firmData.first_name,
        lastName: firmData.last_name,
        title: firmData.title || firmData.current_title,
        company: firmData.company_name || firmData.current_company,
        location: firmData.location,
      };
      if (firmData.email) results.emails.push({ email: firmData.email, source: 'Firmable', type: 'work', confidence: 0.95 });
      if (firmData.personal_email) results.emails.push({ email: firmData.personal_email, source: 'Firmable', type: 'personal', confidence: 0.9 });
      if (firmData.mobile || firmData.phone) {
        results.phones.push({ number: firmData.mobile || firmData.phone, source: 'Firmable', type: 'mobile', confidence: 0.95 });
      }
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error', error: e.message }; }

  // Phase 2: Lusha enrichment
  try {
    const lushaData = curlGet(
      `https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(liUrl)}&revealEmails=true&revealPhones=true`,
      { 'api_key': config.lusha.apiKey }
    );
    if (lushaData.data) {
      if (!results.person) {
        results.person = {
          firstName: lushaData.data.firstName,
          lastName: lushaData.data.lastName,
          title: lushaData.data.currentJobTitle,
          company: lushaData.data.company?.name,
        };
      }
      if (lushaData.data.emailAddresses?.length) {
        lushaData.data.emailAddresses.forEach(e => {
          if (!results.emails.find(x => x.email === e.email)) {
            results.emails.push({ email: e.email, source: 'Lusha', type: e.type, confidence: 0.9 });
          }
        });
      }
      if (lushaData.data.phoneNumbers?.length) {
        lushaData.data.phoneNumbers.forEach(p => {
          const num = p.internationalNumber || p.localizedNumber;
          if (!results.phones.find(x => x.number === num)) {
            results.phones.push({ number: num, source: 'Lusha', type: p.type, confidence: 0.9 });
          }
        });
      }
    }
    results.sources.lusha = { status: 'success' };
  } catch (e) { results.sources.lusha = { status: 'error', error: e.message }; }

  // Phase 3: Apollo enrichment
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/v1/people/match',
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { linkedin_url: liUrl, reveal_personal_emails: true, reveal_phone_number: true }
    );
    if (apolloData.person) {
      if (!results.person) {
        results.person = {
          firstName: apolloData.person.first_name,
          lastName: apolloData.person.last_name,
          title: apolloData.person.title,
          company: apolloData.person.organization?.name,
        };
      }
      if (apolloData.person.email && !results.emails.find(e => e.email === apolloData.person.email)) {
        results.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified', confidence: 0.95 });
      }
      if (apolloData.person.personal_emails?.length) {
        apolloData.person.personal_emails.forEach(e => {
          if (!results.emails.find(x => x.email === e)) {
            results.emails.push({ email: e, source: 'Apollo', type: 'personal', confidence: 0.8 });
          }
        });
      }
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error', error: e.message }; }

  results.linkedin = liUrl;
  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// HTML UI
// ============================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contact Discovery v4</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; }
    .container { max-width: 900px; margin: 0 auto; padding: 30px 20px; }
    h1 { text-align: center; margin-bottom: 10px; font-size: 2em; }
    .subtitle { text-align: center; color: #8892b0; margin-bottom: 30px; }
    
    /* Tabs */
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 12px 24px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.2s; font-weight: 500; }
    .tab:hover { background: rgba(255,255,255,0.1); }
    .tab.active { background: #4ecdc4; color: #1a1a2e; border-color: #4ecdc4; }
    
    /* Panels */
    .panel { display: none; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 25px; border: 1px solid rgba(255,255,255,0.1); }
    .panel.active { display: block; }
    
    /* Form elements */
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 15px; }
    .form-group { display: flex; flex-direction: column; }
    label { font-size: 0.85em; color: #8892b0; margin-bottom: 5px; }
    input, select { padding: 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; background: rgba(255,255,255,0.05); color: #fff; font-size: 1em; }
    input:focus, select:focus { outline: none; border-color: #4ecdc4; }
    input::placeholder { color: #5a6a8a; }
    
    .btn { padding: 14px 28px; background: linear-gradient(135deg, #4ecdc4, #44a08d); border: none; border-radius: 8px; color: #fff; font-size: 1em; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(78, 205, 196, 0.3); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    
    /* Results */
    .results { margin-top: 25px; }
    .result-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1); }
    .result-card h3 { color: #4ecdc4; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
    .result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
    .result-item { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; }
    .result-item .label { font-size: 0.8em; color: #8892b0; margin-bottom: 4px; }
    .result-item .value { font-size: 1em; word-break: break-all; }
    .result-item .value a { color: #4ecdc4; text-decoration: none; }
    
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.75em; margin-left: 5px; }
    .badge-verified { background: #28a745; }
    .badge-source { background: rgba(78, 205, 196, 0.2); color: #4ecdc4; }
    .badge-confidence { background: rgba(255,255,255,0.1); }
    
    .contact-row { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; }
    .contact-value { font-family: monospace; font-size: 0.95em; }
    .copy-btn { padding: 5px 10px; background: #4ecdc4; border: none; border-radius: 4px; color: #1a1a2e; cursor: pointer; font-size: 0.8em; }
    
    /* Prospect cards */
    .prospect-card { background: rgba(255,255,255,0.03); border-radius: 8px; padding: 15px; border: 1px solid rgba(255,255,255,0.1); }
    .prospect-name { font-weight: 600; color: #4ecdc4; }
    .prospect-title { color: #8892b0; font-size: 0.9em; }
    .prospect-company { margin-top: 5px; }
    
    .loading { display: none; text-align: center; padding: 40px; }
    .loading.show { display: block; }
    .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #4ecdc4; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .error { background: rgba(220, 53, 69, 0.2); border: 1px solid #dc3545; color: #ff6b6b; padding: 15px; border-radius: 8px; margin-top: 15px; display: none; }
    .error.show { display: block; }
    
    .duration { text-align: right; color: #5a6a8a; font-size: 0.85em; margin-top: 10px; }
    .sources { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
    .source { padding: 5px 10px; border-radius: 4px; font-size: 0.8em; display: flex; align-items: center; gap: 5px; }
    .source.success { background: rgba(40, 167, 69, 0.2); color: #28a745; }
    .source.error { background: rgba(220, 53, 69, 0.2); color: #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 Contact Discovery</h1>
    <p class="subtitle">Find emails, phones, and company intel for AU/NZ business contacts</p>
    
    <div class="tabs">
      <div class="tab active" data-tab="discover">👤 Discover Person</div>
      <div class="tab" data-tab="prospect">🎯 Prospect</div>
      <div class="tab" data-tab="company">🏢 Company Intel</div>
      <div class="tab" data-tab="linkedin">🔗 LinkedIn Lookup</div>
    </div>
    
    <!-- Discover Person Panel -->
    <div class="panel active" id="panel-discover">
      <div class="form-row">
        <div class="form-group">
          <label>First Name *</label>
          <input type="text" id="d-firstName" placeholder="Tom">
        </div>
        <div class="form-group">
          <label>Last Name *</label>
          <input type="text" id="d-lastName" placeholder="Cowan">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Company</label>
          <input type="text" id="d-company" placeholder="TDM Growth Partners">
        </div>
        <div class="form-group">
          <label>Domain</label>
          <input type="text" id="d-domain" placeholder="tdmgrowthpartners.com">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>LinkedIn URL (optional)</label>
          <input type="text" id="d-linkedin" placeholder="https://linkedin.com/in/...">
        </div>
      </div>
      <button class="btn" onclick="discover()">🔍 Discover Contact</button>
      <div class="loading" id="d-loading"><div class="spinner"></div><div>Searching across 4 data sources...</div></div>
      <div class="error" id="d-error"></div>
      <div class="results" id="d-results"></div>
    </div>
    
    <!-- Prospect Panel -->
    <div class="panel" id="panel-prospect">
      <div class="form-row">
        <div class="form-group">
          <label>Job Titles (comma-separated)</label>
          <input type="text" id="p-titles" placeholder="CEO, CFO, Managing Director">
        </div>
        <div class="form-group">
          <label>Locations</label>
          <input type="text" id="p-locations" placeholder="Sydney, Melbourne, Australia">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Seniority</label>
          <select id="p-seniority">
            <option value="">Any</option>
            <option value="owner">Owner</option>
            <option value="founder">Founder</option>
            <option value="c_suite">C-Suite</option>
            <option value="partner">Partner</option>
            <option value="vp">VP</option>
            <option value="director">Director</option>
            <option value="manager">Manager</option>
          </select>
        </div>
        <div class="form-group">
          <label>Results (max 25)</label>
          <input type="number" id="p-limit" value="10" min="1" max="25">
        </div>
      </div>
      <button class="btn" onclick="prospect()">🎯 Find Prospects</button>
      <div class="loading" id="p-loading"><div class="spinner"></div><div>Searching Apollo database (FREE - no credits used)...</div></div>
      <div class="error" id="p-error"></div>
      <div class="results" id="p-results"></div>
    </div>
    
    <!-- Company Intel Panel -->
    <div class="panel" id="panel-company">
      <div class="form-row">
        <div class="form-group" style="flex: 1;">
          <label>Company Domain or Name *</label>
          <input type="text" id="c-domain" placeholder="atlassian.com or Atlassian">
        </div>
      </div>
      <button class="btn" onclick="companyIntel()">🏢 Get Company Intel</button>
      <div class="loading" id="c-loading"><div class="spinner"></div><div>Gathering company intelligence...</div></div>
      <div class="error" id="c-error"></div>
      <div class="results" id="c-results"></div>
    </div>
    
    <!-- LinkedIn Lookup Panel -->
    <div class="panel" id="panel-linkedin">
      <div class="form-row">
        <div class="form-group" style="flex: 1;">
          <label>LinkedIn Profile URL *</label>
          <input type="text" id="l-url" placeholder="https://linkedin.com/in/tom-cowan">
        </div>
      </div>
      <button class="btn" onclick="linkedinLookup()">🔗 Get Contact Info</button>
      <div class="loading" id="l-loading"><div class="spinner"></div><div>Enriching from LinkedIn profile...</div></div>
      <div class="error" id="l-error"></div>
      <div class="results" id="l-results"></div>
    </div>
  </div>
  
  <script>
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });
    
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function copyVal(text) { navigator.clipboard.writeText(text); }
    
    // Discover Person
    async function discover() {
      const firstName = document.getElementById('d-firstName').value.trim();
      const lastName = document.getElementById('d-lastName').value.trim();
      const company = document.getElementById('d-company').value.trim();
      const domain = document.getElementById('d-domain').value.trim();
      const linkedin = document.getElementById('d-linkedin').value.trim();
      
      if (!firstName || !lastName) { showError('d-error', 'First and last name required'); return; }
      
      showLoading('d-loading', true);
      hideError('d-error');
      document.getElementById('d-results').innerHTML = '';
      
      try {
        const params = new URLSearchParams({ firstName, lastName, company, domain, linkedin });
        const resp = await fetch('/api/discover?' + params);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderDiscoverResults(data);
      } catch (e) { showError('d-error', e.message); }
      finally { showLoading('d-loading', false); }
    }
    
    function renderDiscoverResults(d) {
      let h = '<div class="result-card"><h3>👤 ' + esc(d.firstName + ' ' + d.lastName) + (d.company ? ' @ ' + esc(d.company) : '') + '</h3>';
      
      if (d.linkedin) {
        h += '<div class="result-item"><div class="label">LinkedIn</div><div class="value"><a href="' + esc(d.linkedin) + '" target="_blank">' + esc(d.linkedin) + '</a></div></div>';
      }
      
      h += '<h4 style="margin: 20px 0 10px; color: #8892b0;">📧 Emails</h4>';
      if (d.emails?.length) {
        d.emails.forEach(e => {
          h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><div>';
          h += '<span class="badge badge-source">' + esc(e.source) + '</span>';
          if (e.verified) h += '<span class="badge badge-verified">✓ Verified</span>';
          if (e.type) h += '<span class="badge badge-confidence">' + esc(e.type) + '</span>';
          h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(e.email) + '\\')">Copy</button></div></div>';
        });
      } else { h += '<div style="color:#5a6a8a">No emails found</div>'; }
      
      h += '<h4 style="margin: 20px 0 10px; color: #8892b0;">📱 Phones</h4>';
      if (d.phones?.length) {
        d.phones.forEach(p => {
          h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><div>';
          h += '<span class="badge badge-source">' + esc(p.source) + '</span>';
          if (p.type) h += '<span class="badge badge-confidence">' + esc(p.type) + '</span>';
          h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(p.number) + '\\')">Copy</button></div></div>';
        });
      } else { h += '<div style="color:#5a6a8a">No phones found</div>'; }
      
      if (d.companyInfo) {
        h += '<h4 style="margin: 20px 0 10px; color: #8892b0;">🏢 Company</h4><div class="result-grid">';
        if (d.companyInfo.name) h += '<div class="result-item"><div class="label">Name</div><div class="value">' + esc(d.companyInfo.name) + '</div></div>';
        if (d.companyInfo.employees) h += '<div class="result-item"><div class="label">AU Employees</div><div class="value">' + d.companyInfo.employees + '</div></div>';
        if (d.companyInfo.abn) h += '<div class="result-item"><div class="label">ABN</div><div class="value">' + esc(d.companyInfo.abn) + '</div></div>';
        if (d.companyInfo.phone) h += '<div class="result-item"><div class="label">Company Phone</div><div class="value">' + esc(d.companyInfo.phone) + '</div></div>';
        h += '</div>';
      }
      
      h += '<div class="sources">';
      Object.entries(d.sources || {}).forEach(([name, s]) => {
        h += '<div class="source ' + s.status + '">' + (s.status === 'success' ? '✓' : '✗') + ' ' + name + '</div>';
      });
      h += '</div>';
      h += '<div class="duration">Completed in ' + d.duration + 'ms</div></div>';
      
      document.getElementById('d-results').innerHTML = h;
    }
    
    // Prospect
    async function prospect() {
      const titles = document.getElementById('p-titles').value.split(',').map(s => s.trim()).filter(Boolean);
      const locations = document.getElementById('p-locations').value.split(',').map(s => s.trim()).filter(Boolean);
      const seniority = document.getElementById('p-seniority').value;
      const limit = parseInt(document.getElementById('p-limit').value) || 10;
      
      if (!titles.length && !locations.length && !seniority) {
        showError('p-error', 'Please enter at least one filter');
        return;
      }
      
      showLoading('p-loading', true);
      hideError('p-error');
      document.getElementById('p-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/prospect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ titles, locations, seniorities: seniority ? [seniority] : [], limit })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderProspectResults(data);
      } catch (e) { showError('p-error', e.message); }
      finally { showLoading('p-loading', false); }
    }
    
    function renderProspectResults(d) {
      let h = '<div class="result-card"><h3>🎯 Found ' + d.total + ' prospects</h3>';
      h += '<p style="color:#5a6a8a;margin-bottom:15px">Showing ' + d.prospects.length + ' results (Apollo People Search - FREE)</p>';
      h += '<div class="result-grid">';
      d.prospects.forEach(p => {
        h += '<div class="prospect-card">';
        h += '<div class="prospect-name">' + esc(p.name) + '</div>';
        h += '<div class="prospect-title">' + esc(p.title) + '</div>';
        h += '<div class="prospect-company">' + esc(p.company) + (p.companySize ? ' (' + p.companySize + ' emp)' : '') + '</div>';
        if (p.location) h += '<div style="color:#5a6a8a;font-size:0.85em">📍 ' + esc(p.location) + '</div>';
        if (p.linkedin) h += '<div style="margin-top:8px"><a href="' + esc(p.linkedin) + '" target="_blank" style="color:#4ecdc4;font-size:0.85em">View LinkedIn →</a></div>';
        h += '</div>';
      });
      h += '</div>';
      h += '<div class="duration">Completed in ' + d.duration + 'ms</div></div>';
      document.getElementById('p-results').innerHTML = h;
    }
    
    // Company Intel
    async function companyIntel() {
      const domain = document.getElementById('c-domain').value.trim();
      if (!domain) { showError('c-error', 'Company domain or name required'); return; }
      
      showLoading('c-loading', true);
      hideError('c-error');
      document.getElementById('c-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/company?domain=' + encodeURIComponent(domain));
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderCompanyResults(data);
      } catch (e) { showError('c-error', e.message); }
      finally { showLoading('c-loading', false); }
    }
    
    function renderCompanyResults(d) {
      if (!d.company) {
        document.getElementById('c-results').innerHTML = '<div class="result-card"><h3>Company not found</h3></div>';
        return;
      }
      const c = d.company;
      let h = '<div class="result-card"><h3>🏢 ' + esc(c.name) + '</h3>';
      
      h += '<div class="result-grid">';
      if (c.domain) h += '<div class="result-item"><div class="label">Domain</div><div class="value"><a href="https://' + esc(c.domain) + '" target="_blank">' + esc(c.domain) + '</a></div></div>';
      if (c.employees?.au) h += '<div class="result-item"><div class="label">AU Employees</div><div class="value">' + c.employees.au + '</div></div>';
      if (c.employees?.global) h += '<div class="result-item"><div class="label">Global Employees</div><div class="value">' + c.employees.global + '</div></div>';
      if (c.founded) h += '<div class="result-item"><div class="label">Founded</div><div class="value">' + c.founded + '</div></div>';
      if (c.abn) h += '<div class="result-item"><div class="label">ABN</div><div class="value">' + esc(c.abn) + '</div></div>';
      if (c.acn) h += '<div class="result-item"><div class="label">ACN</div><div class="value">' + esc(c.acn) + '</div></div>';
      if (c.phone) h += '<div class="result-item"><div class="label">Phone</div><div class="value">' + esc(c.phone) + '</div></div>';
      if (c.linkedin) h += '<div class="result-item"><div class="label">LinkedIn</div><div class="value"><a href="' + esc(c.linkedin) + '" target="_blank">View Page</a></div></div>';
      if (c.industries?.length) h += '<div class="result-item"><div class="label">Industries</div><div class="value">' + esc(c.industries.join(', ')) + '</div></div>';
      if (c.funding) h += '<div class="result-item"><div class="label">Funding</div><div class="value">' + esc(JSON.stringify(c.funding)) + '</div></div>';
      h += '</div>';
      
      if (c.description) {
        h += '<div style="margin-top:15px;padding:15px;background:rgba(0,0,0,0.2);border-radius:8px;color:#8892b0">' + esc(c.description) + '</div>';
      }
      
      if (d.techStack?.length) {
        h += '<h4 style="margin:20px 0 10px;color:#8892b0">💻 Tech Stack</h4>';
        h += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
        d.techStack.slice(0, 20).forEach(t => {
          h += '<span class="badge badge-source">' + esc(t) + '</span>';
        });
        h += '</div>';
      }
      
      if (d.jobs?.length) {
        h += '<h4 style="margin:20px 0 10px;color:#8892b0">💼 Open Positions (' + d.jobs.length + ')</h4>';
        h += '<div class="result-grid">';
        d.jobs.forEach(j => {
          h += '<div class="result-item"><div class="label">' + esc(j.location || 'Remote') + '</div><div class="value">' + esc(j.title) + '</div></div>';
        });
        h += '</div>';
      }
      
      h += '<div class="sources">';
      Object.entries(d.sources || {}).forEach(([name, s]) => {
        h += '<div class="source ' + s.status + '">' + (s.status === 'success' ? '✓' : '✗') + ' ' + name + '</div>';
      });
      h += '</div>';
      h += '<div class="duration">Completed in ' + d.duration + 'ms</div></div>';
      
      document.getElementById('c-results').innerHTML = h;
    }
    
    // LinkedIn Lookup
    async function linkedinLookup() {
      const url = document.getElementById('l-url').value.trim();
      if (!url) { showError('l-error', 'LinkedIn URL required'); return; }
      
      showLoading('l-loading', true);
      hideError('l-error');
      document.getElementById('l-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/linkedin?url=' + encodeURIComponent(url));
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        renderLinkedInResults(data);
      } catch (e) { showError('l-error', e.message); }
      finally { showLoading('l-loading', false); }
    }
    
    function renderLinkedInResults(d) {
      let h = '<div class="result-card">';
      if (d.person) {
        h += '<h3>👤 ' + esc((d.person.firstName || '') + ' ' + (d.person.lastName || '')) + '</h3>';
        if (d.person.title) h += '<p style="color:#8892b0">' + esc(d.person.title) + (d.person.company ? ' @ ' + esc(d.person.company) : '') + '</p>';
      } else {
        h += '<h3>🔗 LinkedIn Enrichment</h3>';
      }
      
      h += '<h4 style="margin: 20px 0 10px; color: #8892b0;">📧 Emails</h4>';
      if (d.emails?.length) {
        d.emails.forEach(e => {
          h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><div>';
          h += '<span class="badge badge-source">' + esc(e.source) + '</span>';
          if (e.type) h += '<span class="badge badge-confidence">' + esc(e.type) + '</span>';
          h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(e.email) + '\\')">Copy</button></div></div>';
        });
      } else { h += '<div style="color:#5a6a8a">No emails found</div>'; }
      
      h += '<h4 style="margin: 20px 0 10px; color: #8892b0;">📱 Phones</h4>';
      if (d.phones?.length) {
        d.phones.forEach(p => {
          h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><div>';
          h += '<span class="badge badge-source">' + esc(p.source) + '</span>';
          if (p.type) h += '<span class="badge badge-confidence">' + esc(p.type) + '</span>';
          h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(p.number) + '\\')">Copy</button></div></div>';
        });
      } else { h += '<div style="color:#5a6a8a">No phones found</div>'; }
      
      h += '<div class="sources">';
      Object.entries(d.sources || {}).forEach(([name, s]) => {
        h += '<div class="source ' + s.status + '">' + (s.status === 'success' ? '✓' : '✗') + ' ' + name + '</div>';
      });
      h += '</div>';
      h += '<div class="duration">Completed in ' + d.duration + 'ms</div></div>';
      
      document.getElementById('l-results').innerHTML = h;
    }
    
    function showLoading(id, show) { document.getElementById(id).classList.toggle('show', show); }
    function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.add('show'); }
    function hideError(id) { document.getElementById(id).classList.remove('show'); }
  </script>
</body>
</html>`;

// ============================================================================
// SLACK FORMATTING
// ============================================================================

function formatSlackDiscover(d) {
  let text = `🔍 *${d.firstName} ${d.lastName}*${d.company ? ` @ ${d.company}` : ''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (d.linkedin) text += `🔗 *LinkedIn:* <${d.linkedin}|View Profile>\n`;
  if (d.emails?.length) {
    d.emails.slice(0, 3).forEach(e => {
      text += `📧 \`${e.email}\`${e.verified ? ' ✓' : ''} _${e.source}_\n`;
    });
  } else { text += `📧 _No emails found_\n`; }
  if (d.phones?.length) {
    d.phones.slice(0, 2).forEach(p => text += `📱 \`${p.number}\` _${p.source}_\n`);
  }
  if (d.companyInfo) {
    text += `\n🏢 *${d.companyInfo.name}*`;
    if (d.companyInfo.employees) text += ` • ${d.companyInfo.employees} AU employees`;
    text += '\n';
  }
  text += `\n_${d.duration}ms_`;
  return { response_type: 'in_channel', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function formatSlackProspect(d) {
  let text = `🎯 *Found ${d.total} prospects*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  d.prospects.slice(0, 5).forEach(p => {
    text += `• *${p.name}* - ${p.title || 'N/A'}\n  _${p.company || 'Unknown'}_ ${p.linkedin ? `<${p.linkedin}|LinkedIn>` : ''}\n`;
  });
  if (d.total > 5) text += `\n_...and ${d.total - 5} more_\n`;
  text += `\n_${d.duration}ms | FREE - no credits used_`;
  return { response_type: 'in_channel', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function formatSlackCompany(d) {
  if (!d.company) return { response_type: 'ephemeral', text: '❌ Company not found' };
  const c = d.company;
  let text = `🏢 *${c.name}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (c.domain) text += `🌐 <https://${c.domain}|${c.domain}>\n`;
  if (c.employees?.au) text += `👥 ${c.employees.au} AU employees\n`;
  if (c.employees?.global) text += `🌍 ${c.employees.global} global employees\n`;
  if (c.founded) text += `📅 Founded ${c.founded}\n`;
  if (c.abn) text += `🔢 ABN: ${c.abn}\n`;
  if (c.phone) text += `📞 ${c.phone}\n`;
  if (c.industries?.length) text += `🏷️ ${c.industries.slice(0, 3).join(', ')}\n`;
  if (d.techStack?.length) text += `\n💻 *Tech:* ${d.techStack.slice(0, 5).join(', ')}\n`;
  if (d.jobs?.length) text += `\n💼 *Hiring:* ${d.jobs.length} open positions\n`;
  text += `\n_${d.duration}ms_`;
  return { response_type: 'in_channel', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function formatSlackLinkedIn(d) {
  let text = '🔗 *LinkedIn Enrichment*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  if (d.person) {
    text = `🔗 *${d.person.firstName || ''} ${d.person.lastName || ''}*`;
    if (d.person.title) text += `\n${d.person.title}${d.person.company ? ` @ ${d.person.company}` : ''}`;
    text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  }
  if (d.emails?.length) {
    d.emails.forEach(e => text += `📧 \`${e.email}\` _${e.source}${e.type ? ' / ' + e.type : ''}_\n`);
  } else { text += `📧 _No emails found_\n`; }
  if (d.phones?.length) {
    d.phones.forEach(p => text += `📱 \`${p.number}\` _${p.source}${p.type ? ' / ' + p.type : ''}_\n`);
  } else { text += `📱 _No phones found_\n`; }
  text += `\n_${d.duration}ms_`;
  return { response_type: 'in_channel', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

// ============================================================================
// SLACK SIGNATURE VERIFICATION
// ============================================================================

function verifySlackSignature(signature, timestamp, body) {
  if (!config.slack.signingSecret) return true;
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto.createHmac('sha256', config.slack.signingSecret).update(sigBasestring).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '4.0.0', apis: ['serp', 'apollo', 'firmable', 'lusha'] }));
    return;
  }

  // Web UI
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // API: Discover Person
  if (parsed.pathname === '/api/discover') {
    const { firstName, lastName, company, domain, linkedin } = parsed.query;
    if (!firstName || !lastName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'firstName and lastName required' }));
      return;
    }
    console.log(`\n\x1b[36m🔍 Discover: ${firstName} ${lastName} @ ${company || 'Unknown'}\x1b[0m`);
    const results = discoverPerson(firstName, lastName, company || '', domain || '', linkedin || '');
    console.log(`\x1b[32m✅ Found: ${results.emails.length} emails, ${results.phones.length} phones (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: Prospect
  if (parsed.pathname === '/api/prospect' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const filters = JSON.parse(body);
        console.log(`\n\x1b[36m🎯 Prospect: ${JSON.stringify(filters)}\x1b[0m`);
        const results = prospectPeople(filters);
        console.log(`\x1b[32m✅ Found: ${results.total} prospects (${results.duration}ms)\x1b[0m`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Company Intel
  if (parsed.pathname === '/api/company') {
    const { domain } = parsed.query;
    if (!domain) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'domain required' }));
      return;
    }
    console.log(`\n\x1b[36m🏢 Company: ${domain}\x1b[0m`);
    const results = getCompanyIntel(domain);
    console.log(`\x1b[32m✅ Found: ${results.company?.name || 'Not found'} (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: LinkedIn Lookup
  if (parsed.pathname === '/api/linkedin') {
    const { url: liUrl } = parsed.query;
    if (!liUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url required' }));
      return;
    }
    console.log(`\n\x1b[36m🔗 LinkedIn: ${liUrl}\x1b[0m`);
    const results = enrichLinkedIn(liUrl);
    console.log(`\x1b[32m✅ Found: ${results.emails?.length || 0} emails, ${results.phones?.length || 0} phones (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // Slack: /discover command
  if (parsed.pathname === '/slack/discover' && req.method === 'POST') {
    handleSlackCommand(req, res, 'discover');
    return;
  }

  // Slack: /prospect command
  if (parsed.pathname === '/slack/prospect' && req.method === 'POST') {
    handleSlackCommand(req, res, 'prospect');
    return;
  }

  // Slack: /company command
  if (parsed.pathname === '/slack/company' && req.method === 'POST') {
    handleSlackCommand(req, res, 'company');
    return;
  }

  // Slack: /linkedin command
  if (parsed.pathname === '/slack/linkedin' && req.method === 'POST') {
    handleSlackCommand(req, res, 'linkedin');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function handleSlackCommand(req, res, command) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const signature = req.headers['x-slack-signature'] || '';
    const timestamp = req.headers['x-slack-request-timestamp'] || '';
    
    if (config.slack.signingSecret && !verifySlackSignature(signature, timestamp, body)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }
    
    const params = querystring.parse(body);
    const { text, user_name, response_url } = params;
    
    console.log(`\n\x1b[35m📱 Slack /${command} from @${user_name}: ${text}\x1b[0m`);
    
    // Respond immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response_type: 'in_channel', text: `🔍 Processing /${command} ${text}...` }));
    
    // Process async
    setImmediate(() => {
      let results, response;
      
      try {
        switch (command) {
          case 'discover':
            const dp = parseDiscoverInput(text);
            results = discoverPerson(dp.firstName, dp.lastName, dp.company, dp.domain, '');
            response = formatSlackDiscover(results);
            break;
          
          case 'prospect':
            const pp = parseProspectInput(text);
            results = prospectPeople(pp);
            response = formatSlackProspect(results);
            break;
          
          case 'company':
            results = getCompanyIntel(text.trim());
            response = formatSlackCompany(results);
            break;
          
          case 'linkedin':
            results = enrichLinkedIn(text.trim());
            response = formatSlackLinkedIn(results);
            break;
        }
        
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, response);
        }
      } catch (err) {
        console.error('Slack error:', err);
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'ephemeral', text: `❌ Error: ${err.message}` });
        }
      }
    });
  });
}

function parseDiscoverInput(text) {
  let firstName = '', lastName = '', company = '', domain = '';
  const domainMatch = text.match(/(\S+\.(com|com\.au|io|co|net|org))/i);
  if (domainMatch) { domain = domainMatch[1]; text = text.replace(domain, '').trim(); }
  
  let parts;
  if (text.includes(',')) parts = text.split(',').map(s => s.trim());
  else if (text.includes(' @ ')) parts = text.split(' @ ').map(s => s.trim());
  else if (text.toLowerCase().includes(' at ')) parts = text.split(/\s+at\s+/i).map(s => s.trim());
  else {
    const words = text.split(/\s+/);
    firstName = words[0] || '';
    lastName = words[1] || '';
    company = words.slice(2).join(' ');
    return { firstName, lastName, company, domain };
  }
  
  if (parts[0]) {
    const nameParts = parts[0].split(/\s+/);
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
  }
  company = parts[1] || '';
  return { firstName, lastName, company, domain };
}

function parseProspectInput(text) {
  // Format: "CEO, CFO Sydney 10" or "CFO Sydney, Melbourne" or "Director fintech"
  const words = text.split(/\s+/);
  const titles = [];
  const locations = [];
  let limit = 10;
  
  // Parse - look for common patterns
  const titleKeywords = ['ceo', 'cfo', 'cto', 'coo', 'cmo', 'director', 'manager', 'vp', 'head', 'chief', 'founder', 'partner', 'president'];
  const locationKeywords = ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'australia', 'auckland', 'wellington', 'nz'];
  
  words.forEach(w => {
    const wl = w.toLowerCase().replace(/,/g, '');
    if (titleKeywords.some(t => wl.includes(t))) titles.push(w.replace(/,/g, ''));
    else if (locationKeywords.some(l => wl.includes(l))) locations.push(w.replace(/,/g, ''));
    else if (!isNaN(parseInt(w))) limit = Math.min(parseInt(w), 25);
  });
  
  if (!titles.length) titles.push(text.split(',')[0]?.trim() || text);
  
  return { titles, locations, limit };
}

server.listen(PORT, () => {
  console.log(`
\x1b[1m┌─────────────────────────────────────────────────────────┐
│                                                         │
│   🔍 Contact Discovery v4                               │
│                                                         │
│   Web:     http://localhost:${PORT}                         │
│                                                         │
│   Slack Commands:                                       │
│     /discover  → POST /slack/discover                   │
│     /prospect  → POST /slack/prospect                   │
│     /company   → POST /slack/company                    │
│     /linkedin  → POST /slack/linkedin                   │
│                                                         │
│   APIs: SerpAPI ✓  Apollo ✓  Firmable ✓  Lusha ✓        │
│                                                         │
└─────────────────────────────────────────────────────────┘\x1b[0m
  `);
});
