#!/usr/bin/env node
/**
 * Contact Discovery Web App v5
 * 
 * Features:
 *   1. /discover - Person lookup
 *   2. /prospect - Find new leads by criteria (Apollo FREE)
 *   3. /company - Full company intelligence
 *   4. /linkedin - LinkedIn URL → contact info
 *   5. /bulk - Bulk CSV upload with compliance workflow
 * 
 * APIs: SerpAPI, Apollo.io, Firmable, Lusha
 */

const http = require('http');
const { execSync } = require('child_process');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const config = {
  serp: { apiKey: process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '' },
  apollo: { apiKey: process.env.APOLLO_API_KEY || process.env.APOLLO_API_KEY || '' },
  firmable: { apiKey: process.env.FIRMABLE_API_KEY || process.env.FIRMABLE_API_KEY || '' },
  lusha: { apiKey: process.env.LUSHA_API_KEY || process.env.LUSHA_API_KEY || '' },
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
// COMPLIANCE CHECKS
// ============================================================================

function checkCompliance(contacts) {
  const issues = [];
  const validContacts = [];
  
  contacts.forEach((contact, idx) => {
    const row = idx + 2; // Account for header row
    const contactIssues = [];
    
    // 1. Required fields check
    if (!contact.firstName?.trim()) {
      contactIssues.push('Missing first name');
    }
    if (!contact.lastName?.trim()) {
      contactIssues.push('Missing last name');
    }
    if (!contact.company?.trim() && !contact.domain?.trim() && !contact.linkedin?.trim()) {
      contactIssues.push('Need at least one of: company, domain, or LinkedIn URL');
    }
    
    // 2. Data quality checks
    if (contact.email && !isValidEmail(contact.email)) {
      contactIssues.push(`Invalid email format: ${contact.email}`);
    }
    if (contact.linkedin && !contact.linkedin.includes('linkedin.com')) {
      contactIssues.push(`Invalid LinkedIn URL: ${contact.linkedin}`);
    }
    
    // 3. Privacy/consent indicators
    if (contact.doNotContact?.toLowerCase() === 'true' || contact.doNotContact === '1') {
      contactIssues.push('Marked as Do Not Contact');
    }
    if (contact.optedOut?.toLowerCase() === 'true' || contact.optedOut === '1') {
      contactIssues.push('Previously opted out');
    }
    
    // 4. Duplicate check (basic - same name + company)
    const isDupe = validContacts.find(c => 
      c.firstName?.toLowerCase() === contact.firstName?.toLowerCase() &&
      c.lastName?.toLowerCase() === contact.lastName?.toLowerCase() &&
      c.company?.toLowerCase() === contact.company?.toLowerCase()
    );
    if (isDupe) {
      contactIssues.push('Duplicate entry');
    }
    
    if (contactIssues.length > 0) {
      issues.push({ row, contact: `${contact.firstName} ${contact.lastName}`, issues: contactIssues });
    } else {
      validContacts.push(contact);
    }
  });
  
  return { validContacts, issues, totalRows: contacts.length };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================================
// BULK ENRICHMENT
// ============================================================================

async function enrichContactsBulk(contacts, onProgress) {
  const results = [];
  const batchSize = 10; // Lusha allows up to 100, Apollo up to 10
  
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const enriched = {
      ...contact,
      _enriched: true,
      _timestamp: new Date().toISOString(),
      emails: [],
      phones: [],
      linkedin: contact.linkedin || null,
      companyInfo: {},
      sources: [],
    };
    
    try {
      // Try Apollo first (most reliable for emails)
      const apolloData = curlPost(
        'https://api.apollo.io/v1/people/match',
        { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
        { 
          first_name: contact.firstName, 
          last_name: contact.lastName, 
          organization_name: contact.company,
          domain: contact.domain,
          reveal_personal_emails: true,
          reveal_phone_number: true
        }
      );
      
      if (apolloData.person) {
        if (apolloData.person.email) {
          enriched.emails.push({
            email: apolloData.person.email,
            type: 'work',
            source: 'Apollo',
            verified: apolloData.person.email_status === 'verified'
          });
        }
        if (apolloData.person.personal_emails?.length) {
          apolloData.person.personal_emails.forEach(e => {
            enriched.emails.push({ email: e, type: 'personal', source: 'Apollo' });
          });
        }
        if (apolloData.person.phone_numbers?.length) {
          apolloData.person.phone_numbers.forEach(p => {
            enriched.phones.push({ 
              number: p.sanitized_number || p.raw_number, 
              type: p.type, 
              source: 'Apollo' 
            });
          });
        }
        if (!enriched.linkedin && apolloData.person.linkedin_url) {
          enriched.linkedin = apolloData.person.linkedin_url;
        }
        if (apolloData.person.title) enriched.title = apolloData.person.title;
        enriched.sources.push('Apollo');
      }
      
      // Try Firmable for AU/NZ contacts
      if (contact.domain || contact.company) {
        let searchDomain = contact.domain;
        if (!searchDomain && contact.company) {
          searchDomain = contact.company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au';
        }
        
        const firmData = curlGet(
          `https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`,
          { 'Authorization': `Bearer ${config.firmable.apiKey}` }
        );
        
        if (firmData.id) {
          enriched.companyInfo = {
            name: firmData.name,
            domain: firmData.fqdn,
            auEmployees: firmData.au_employee_count,
            abn: firmData.abn,
            phone: firmData.phone,
          };
          if (firmData.phone && !enriched.phones.find(p => p.number === firmData.phone)) {
            enriched.phones.push({ number: firmData.phone, type: 'company', source: 'Firmable' });
          }
          enriched.sources.push('Firmable');
        }
      }
      
      // DNC check for Australian numbers
      enriched.phones = enriched.phones.map(p => {
        if (p.number?.startsWith('+61') || p.number?.startsWith('04') || p.number?.startsWith('61')) {
          // Note: Real DNC check would require ACMA API
          p.dncChecked = false; // Flag that DNC check is pending
          p.dncNote = 'Verify against ACMA Do Not Call Register before calling';
        }
        return p;
      });
      
    } catch (err) {
      enriched._error = err.message;
    }
    
    results.push(enriched);
    
    if (onProgress) {
      onProgress(i + 1, contacts.length, enriched);
    }
    
    // Rate limiting - small delay between requests
    if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return results;
}

// ============================================================================
// CSV PARSING AND GENERATION
// ============================================================================

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { error: 'CSV must have header row and at least one data row' };
  
  // Parse header - normalize column names
  const headerRaw = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  const headerMap = {};
  
  // Map various column name formats to standard fields
  const fieldMappings = {
    firstName: ['firstname', 'first_name', 'first name', 'given name', 'givenname', 'name_first'],
    lastName: ['lastname', 'last_name', 'last name', 'surname', 'family name', 'familyname', 'name_last'],
    company: ['company', 'company name', 'companyname', 'organisation', 'organization', 'org', 'employer'],
    domain: ['domain', 'website', 'company domain', 'companydomain', 'url', 'company_domain'],
    email: ['email', 'email address', 'emailaddress', 'e-mail', 'work email', 'workemail'],
    linkedin: ['linkedin', 'linkedin url', 'linkedinurl', 'linkedin_url', 'li_url', 'profile'],
    title: ['title', 'job title', 'jobtitle', 'position', 'role', 'job_title'],
    location: ['location', 'city', 'country', 'region', 'address'],
    phone: ['phone', 'mobile', 'telephone', 'phone number', 'phonenumber', 'cell'],
    doNotContact: ['donotcontact', 'do_not_contact', 'dnc', 'do not contact', 'blocked'],
    optedOut: ['optedout', 'opted_out', 'opted out', 'unsubscribed', 'opt_out'],
  };
  
  headerRaw.forEach((h, idx) => {
    const hLower = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [field, variants] of Object.entries(fieldMappings)) {
      if (variants.some(v => v.replace(/[^a-z0-9]/g, '') === hLower)) {
        headerMap[idx] = field;
        break;
      }
    }
    if (!headerMap[idx]) {
      headerMap[idx] = h; // Keep original if not mapped
    }
  });
  
  // Check required columns
  const mappedFields = Object.values(headerMap);
  if (!mappedFields.includes('firstName') || !mappedFields.includes('lastName')) {
    return { 
      error: 'CSV must contain firstName and lastName columns (or variants like first_name, First Name, etc.)',
      detectedColumns: headerRaw
    };
  }
  
  // Parse data rows
  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0 || values.every(v => !v.trim())) continue; // Skip empty rows
    
    const contact = {};
    values.forEach((val, idx) => {
      if (headerMap[idx]) {
        contact[headerMap[idx]] = val.trim().replace(/^["']|["']$/g, '');
      }
    });
    contacts.push(contact);
  }
  
  return { contacts, headers: headerRaw, mappedHeaders: headerMap };
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function generateCSV(enrichedContacts) {
  const headers = [
    'firstName', 'lastName', 'company', 'title', 'domain',
    'email_1', 'email_1_type', 'email_1_source', 'email_1_verified',
    'email_2', 'email_2_type', 'email_2_source',
    'phone_1', 'phone_1_type', 'phone_1_source', 'phone_1_dnc_note',
    'phone_2', 'phone_2_type', 'phone_2_source',
    'linkedin', 'company_abn', 'company_au_employees', 'company_phone',
    'sources', 'enriched_at', 'errors'
  ];
  
  const rows = [headers.join(',')];
  
  enrichedContacts.forEach(c => {
    const row = [
      escapeCSV(c.firstName),
      escapeCSV(c.lastName),
      escapeCSV(c.company),
      escapeCSV(c.title),
      escapeCSV(c.domain || c.companyInfo?.domain),
      escapeCSV(c.emails?.[0]?.email),
      escapeCSV(c.emails?.[0]?.type),
      escapeCSV(c.emails?.[0]?.source),
      c.emails?.[0]?.verified ? 'Yes' : '',
      escapeCSV(c.emails?.[1]?.email),
      escapeCSV(c.emails?.[1]?.type),
      escapeCSV(c.emails?.[1]?.source),
      escapeCSV(c.phones?.[0]?.number),
      escapeCSV(c.phones?.[0]?.type),
      escapeCSV(c.phones?.[0]?.source),
      escapeCSV(c.phones?.[0]?.dncNote),
      escapeCSV(c.phones?.[1]?.number),
      escapeCSV(c.phones?.[1]?.type),
      escapeCSV(c.phones?.[1]?.source),
      escapeCSV(c.linkedin),
      escapeCSV(c.companyInfo?.abn),
      c.companyInfo?.auEmployees || '',
      escapeCSV(c.companyInfo?.phone),
      escapeCSV(c.sources?.join(', ')),
      escapeCSV(c._timestamp),
      escapeCSV(c._error),
    ];
    rows.push(row.join(','));
  });
  
  return rows.join('\n');
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ============================================================================
// PERSON DISCOVERY (from v4)
// ============================================================================

function discoverPerson(firstName, lastName, company, domain, linkedinUrl) {
  const start = Date.now();
  const results = {
    firstName, lastName, company,
    linkedin: linkedinUrl || null,
    emails: [],
    phones: [],
    companyInfo: null,
    sources: {},
  };

  // SerpAPI LinkedIn search
  if (!results.linkedin) {
    try {
      const query = `${firstName} ${lastName} ${company} site:linkedin.com`;
      const serpUrl = `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(query)}&num=5&gl=au`;
      const serpData = curlGet(serpUrl);
      if (serpData.organic_results?.length) {
        const li = serpData.organic_results.find(r => r.link?.includes('linkedin.com/in/'));
        if (li) results.linkedin = li.link;
      }
      results.sources.serp = { status: 'success' };
    } catch (e) { results.sources.serp = { status: 'error' }; }
  }

  // Apollo enrichment
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/v1/people/match',
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { first_name: firstName, last_name: lastName, organization_name: company, domain, reveal_personal_emails: true, reveal_phone_number: true }
    );
    if (apolloData.person) {
      if (apolloData.person.email) results.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified' });
      if (apolloData.person.personal_emails?.length) apolloData.person.personal_emails.forEach(e => results.emails.push({ email: e, source: 'Apollo', type: 'personal' }));
      if (apolloData.person.phone_numbers?.length) apolloData.person.phone_numbers.forEach(p => results.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo' }));
      if (!results.linkedin && apolloData.person.linkedin_url) results.linkedin = apolloData.person.linkedin_url;
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error' }; }

  // Firmable
  try {
    let searchDomain = domain || (company ? company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au' : null);
    if (searchDomain) {
      const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
      if (firmData.id) {
        results.companyInfo = { name: firmData.name, employees: firmData.au_employee_count, abn: firmData.abn, phone: firmData.phone };
        if (firmData.phone) results.phones.push({ number: firmData.phone, source: 'Firmable', type: 'company' });
      }
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error' }; }

  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// PROSPECT SEARCH (from v4)
// ============================================================================

function prospectPeople(filters) {
  const start = Date.now();
  const { titles, locations, seniorities, limit = 10 } = filters;
  const params = new URLSearchParams();
  if (titles?.length) titles.forEach(t => params.append('person_titles[]', t));
  if (locations?.length) locations.forEach(l => params.append('person_locations[]', l));
  if (seniorities?.length) seniorities.forEach(s => params.append('person_seniorities[]', s));
  params.append('per_page', Math.min(limit, 25).toString());

  const results = { prospects: [], total: 0, duration: 0 };
  try {
    const apolloData = curlPost(`https://api.apollo.io/api/v1/mixed_people/api_search?${params}`, { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey }, {});
    if (apolloData.people?.length) {
      results.total = apolloData.pagination?.total_entries || apolloData.people.length;
      results.prospects = apolloData.people.slice(0, limit).map(p => ({
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        firstName: p.first_name, lastName: p.last_name,
        title: p.title, company: p.organization?.name,
        companyDomain: p.organization?.primary_domain,
        linkedin: p.linkedin_url,
        location: p.city ? `${p.city}, ${p.state || p.country}` : p.country,
      }));
    }
  } catch (e) { results.error = e.message; }
  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// COMPANY INTEL (from v4)
// ============================================================================

function getCompanyIntel(domainOrName) {
  const start = Date.now();
  const results = { company: null, techStack: [], jobs: [], sources: {} };
  let domain = domainOrName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) domain = domainOrName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';

  try {
    const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(domain)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
    if (firmData.id) {
      results.company = {
        name: firmData.name, domain: firmData.fqdn, website: firmData.website, description: firmData.description,
        founded: firmData.year_founded, employees: { au: firmData.au_employee_count },
        abn: firmData.abn, acn: firmData.acn, phone: firmData.phone,
        linkedin: firmData.linkedin ? `https://linkedin.com/company/${firmData.linkedin}` : null,
      };
      if (firmData.technologies?.length) results.techStack = firmData.technologies;
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error' }; }

  try {
    const apolloData = curlGet(`https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`, { 'x-api-key': config.apollo.apiKey });
    if (apolloData.organization) {
      if (!results.company) results.company = { name: apolloData.organization.name, domain: apolloData.organization.primary_domain };
      results.company.employees = { ...results.company.employees, global: apolloData.organization.estimated_num_employees };
      if (!results.company.description) results.company.description = apolloData.organization.short_description;
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error' }; }

  results.duration = Date.now() - start;
  return results;
}

// ============================================================================
// LINKEDIN ENRICHMENT (from v4)
// ============================================================================

function enrichLinkedIn(linkedinUrl) {
  const start = Date.now();
  const results = { person: null, emails: [], phones: [], sources: {} };
  let liUrl = linkedinUrl.trim();
  if (!liUrl.startsWith('http')) liUrl = 'https://' + liUrl;

  try {
    const lushaData = curlGet(`https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(liUrl)}&revealEmails=true&revealPhones=true`, { 'api_key': config.lusha.apiKey });
    if (lushaData.data || lushaData.contact?.data) {
      const d = lushaData.data || lushaData.contact?.data;
      results.person = { firstName: d.firstName, lastName: d.lastName, title: d.currentJobTitle, company: d.company?.name };
      if (d.emailAddresses?.length) d.emailAddresses.forEach(e => results.emails.push({ email: e.email, source: 'Lusha', type: e.emailType }));
      if (d.phoneNumbers?.length) d.phoneNumbers.forEach(p => results.phones.push({ number: p.internationalNumber || p.localizedNumber, source: 'Lusha', type: p.type }));
    }
    results.sources.lusha = { status: 'success' };
  } catch (e) { results.sources.lusha = { status: 'error' }; }

  try {
    const apolloData = curlPost('https://api.apollo.io/v1/people/match', { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey }, { linkedin_url: liUrl, reveal_personal_emails: true, reveal_phone_number: true });
    if (apolloData.person) {
      if (!results.person) results.person = { firstName: apolloData.person.first_name, lastName: apolloData.person.last_name, title: apolloData.person.title };
      if (apolloData.person.email && !results.emails.find(e => e.email === apolloData.person.email)) results.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified' });
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error' }; }

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
  <title>Contact Discovery v5</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; }
    .container { max-width: 1000px; margin: 0 auto; padding: 30px 20px; }
    h1 { text-align: center; margin-bottom: 10px; font-size: 2em; }
    .subtitle { text-align: center; color: #8892b0; margin-bottom: 30px; }
    
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 12px 20px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.2s; font-weight: 500; font-size: 0.9em; }
    .tab:hover { background: rgba(255,255,255,0.1); }
    .tab.active { background: #4ecdc4; color: #1a1a2e; border-color: #4ecdc4; }
    
    .panel { display: none; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 25px; border: 1px solid rgba(255,255,255,0.1); }
    .panel.active { display: block; }
    
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 15px; }
    .form-group { display: flex; flex-direction: column; }
    label { font-size: 0.85em; color: #8892b0; margin-bottom: 5px; }
    input, select, textarea { padding: 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; background: rgba(255,255,255,0.05); color: #fff; font-size: 1em; font-family: inherit; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #4ecdc4; }
    input::placeholder, textarea::placeholder { color: #5a6a8a; }
    
    .btn { padding: 14px 28px; background: linear-gradient(135deg, #4ecdc4, #44a08d); border: none; border-radius: 8px; color: #fff; font-size: 1em; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(78, 205, 196, 0.3); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .btn-secondary { background: rgba(255,255,255,0.1); }
    .btn-secondary:hover { background: rgba(255,255,255,0.2); box-shadow: none; }
    
    .results { margin-top: 25px; }
    .result-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1); }
    .result-card h3 { color: #4ecdc4; margin-bottom: 15px; }
    .result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
    .result-item { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; }
    .result-item .label { font-size: 0.8em; color: #8892b0; margin-bottom: 4px; }
    .result-item .value { font-size: 1em; word-break: break-all; }
    .result-item .value a { color: #4ecdc4; text-decoration: none; }
    
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.75em; margin-left: 5px; }
    .badge-verified { background: #28a745; }
    .badge-source { background: rgba(78, 205, 196, 0.2); color: #4ecdc4; }
    .badge-warning { background: rgba(255, 193, 7, 0.2); color: #ffc107; }
    .badge-error { background: rgba(220, 53, 69, 0.2); color: #dc3545; }
    
    .contact-row { display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
    .contact-value { font-family: monospace; font-size: 0.95em; }
    .copy-btn { padding: 5px 10px; background: #4ecdc4; border: none; border-radius: 4px; color: #1a1a2e; cursor: pointer; font-size: 0.8em; }
    
    .loading { display: none; text-align: center; padding: 40px; }
    .loading.show { display: block; }
    .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #4ecdc4; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .error { background: rgba(220, 53, 69, 0.2); border: 1px solid #dc3545; color: #ff6b6b; padding: 15px; border-radius: 8px; margin-top: 15px; display: none; }
    .error.show { display: block; }
    
    .success { background: rgba(40, 167, 69, 0.2); border: 1px solid #28a745; color: #28a745; padding: 15px; border-radius: 8px; margin-top: 15px; display: none; }
    .success.show { display: block; }
    
    .warning { background: rgba(255, 193, 7, 0.2); border: 1px solid #ffc107; color: #ffc107; padding: 15px; border-radius: 8px; margin-top: 15px; }
    
    .duration { text-align: right; color: #5a6a8a; font-size: 0.85em; margin-top: 10px; }
    .sources { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
    .source { padding: 5px 10px; border-radius: 4px; font-size: 0.8em; display: flex; align-items: center; gap: 5px; }
    .source.success { background: rgba(40, 167, 69, 0.2); color: #28a745; }
    .source.error { background: rgba(220, 53, 69, 0.2); color: #dc3545; }
    
    /* Bulk upload specific */
    .upload-zone { border: 2px dashed rgba(255,255,255,0.2); border-radius: 12px; padding: 40px; text-align: center; cursor: pointer; transition: all 0.2s; margin-bottom: 20px; }
    .upload-zone:hover, .upload-zone.dragover { border-color: #4ecdc4; background: rgba(78, 205, 196, 0.1); }
    .upload-zone input { display: none; }
    .upload-zone h3 { margin-bottom: 10px; }
    .upload-zone p { color: #8892b0; font-size: 0.9em; }
    
    .file-info { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .file-info h4 { color: #4ecdc4; margin-bottom: 10px; }
    
    .compliance-report { margin-top: 20px; }
    .compliance-item { padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; }
    .compliance-item.error { border-left: 3px solid #dc3545; }
    .compliance-item.warning { border-left: 3px solid #ffc107; }
    .compliance-item.success { border-left: 3px solid #28a745; }
    
    .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin: 15px 0; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #4ecdc4, #44a08d); transition: width 0.3s; }
    
    .step { display: none; }
    .step.active { display: block; }
    
    .step-indicator { display: flex; justify-content: center; gap: 10px; margin-bottom: 30px; }
    .step-dot { width: 12px; height: 12px; border-radius: 50%; background: rgba(255,255,255,0.2); }
    .step-dot.active { background: #4ecdc4; }
    .step-dot.completed { background: #28a745; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 0.85em; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { color: #8892b0; font-weight: 500; }
    
    .instructions { background: rgba(78, 205, 196, 0.1); border: 1px solid rgba(78, 205, 196, 0.3); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .instructions h4 { color: #4ecdc4; margin-bottom: 10px; }
    .instructions ul { margin-left: 20px; color: #8892b0; }
    .instructions li { margin-bottom: 5px; }
    .instructions code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    
    .template-btn { display: inline-block; margin-top: 10px; padding: 8px 16px; background: rgba(255,255,255,0.1); border-radius: 6px; color: #4ecdc4; text-decoration: none; font-size: 0.85em; }
    .template-btn:hover { background: rgba(255,255,255,0.2); }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 Contact Discovery</h1>
    <p class="subtitle">Find emails, phones, and company intel for AU/NZ business contacts</p>
    
    <div class="tabs">
      <div class="tab active" data-tab="discover">👤 Discover</div>
      <div class="tab" data-tab="prospect">🎯 Prospect</div>
      <div class="tab" data-tab="company">🏢 Company</div>
      <div class="tab" data-tab="linkedin">🔗 LinkedIn</div>
      <div class="tab" data-tab="bulk">📋 Bulk Upload</div>
    </div>
    
    <!-- Discover Panel -->
    <div class="panel active" id="panel-discover">
      <div class="form-row">
        <div class="form-group"><label>First Name *</label><input type="text" id="d-firstName" placeholder="Tom"></div>
        <div class="form-group"><label>Last Name *</label><input type="text" id="d-lastName" placeholder="Cowan"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Company</label><input type="text" id="d-company" placeholder="TDM Growth Partners"></div>
        <div class="form-group"><label>Domain</label><input type="text" id="d-domain" placeholder="tdmgrowthpartners.com"></div>
      </div>
      <button class="btn" onclick="discover()">🔍 Discover Contact</button>
      <div class="loading" id="d-loading"><div class="spinner"></div><div>Searching...</div></div>
      <div class="error" id="d-error"></div>
      <div class="results" id="d-results"></div>
    </div>
    
    <!-- Prospect Panel -->
    <div class="panel" id="panel-prospect">
      <div class="form-row">
        <div class="form-group"><label>Job Titles</label><input type="text" id="p-titles" placeholder="CEO, CFO, Director"></div>
        <div class="form-group"><label>Locations</label><input type="text" id="p-locations" placeholder="Sydney, Melbourne"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Seniority</label>
          <select id="p-seniority"><option value="">Any</option><option value="c_suite">C-Suite</option><option value="vp">VP</option><option value="director">Director</option><option value="manager">Manager</option></select>
        </div>
        <div class="form-group"><label>Results</label><input type="number" id="p-limit" value="10" min="1" max="25"></div>
      </div>
      <button class="btn" onclick="prospect()">🎯 Find Prospects</button>
      <div class="loading" id="p-loading"><div class="spinner"></div><div>Searching (FREE)...</div></div>
      <div class="error" id="p-error"></div>
      <div class="results" id="p-results"></div>
    </div>
    
    <!-- Company Panel -->
    <div class="panel" id="panel-company">
      <div class="form-row">
        <div class="form-group" style="flex:1"><label>Company Domain or Name *</label><input type="text" id="c-domain" placeholder="atlassian.com"></div>
      </div>
      <button class="btn" onclick="companyIntel()">🏢 Get Intel</button>
      <div class="loading" id="c-loading"><div class="spinner"></div><div>Gathering intel...</div></div>
      <div class="error" id="c-error"></div>
      <div class="results" id="c-results"></div>
    </div>
    
    <!-- LinkedIn Panel -->
    <div class="panel" id="panel-linkedin">
      <div class="form-row">
        <div class="form-group" style="flex:1"><label>LinkedIn URL *</label><input type="text" id="l-url" placeholder="https://linkedin.com/in/..."></div>
      </div>
      <button class="btn" onclick="linkedinLookup()">🔗 Enrich</button>
      <div class="loading" id="l-loading"><div class="spinner"></div><div>Enriching...</div></div>
      <div class="error" id="l-error"></div>
      <div class="results" id="l-results"></div>
    </div>
    
    <!-- Bulk Upload Panel -->
    <div class="panel" id="panel-bulk">
      <div class="step-indicator">
        <div class="step-dot active" id="dot-1"></div>
        <div class="step-dot" id="dot-2"></div>
        <div class="step-dot" id="dot-3"></div>
        <div class="step-dot" id="dot-4"></div>
      </div>
      
      <!-- Step 1: Upload -->
      <div class="step active" id="step-1">
        <div class="instructions">
          <h4>📋 CSV File Requirements</h4>
          <ul>
            <li><strong>Required columns:</strong> <code>firstName</code>, <code>lastName</code></li>
            <li><strong>Recommended:</strong> <code>company</code>, <code>domain</code>, <code>linkedin</code></li>
            <li><strong>Optional:</strong> <code>email</code>, <code>phone</code>, <code>title</code>, <code>location</code></li>
            <li><strong>Compliance:</strong> <code>doNotContact</code>, <code>optedOut</code> (set to "true" to skip)</li>
            <li>Column names are flexible (e.g., "First Name", "first_name", "firstName" all work)</li>
            <li>Maximum 100 contacts per batch</li>
          </ul>
          <a href="/api/bulk/template" class="template-btn" download="contact_template.csv">⬇️ Download Template CSV</a>
        </div>
        
        <div class="upload-zone" id="upload-zone">
          <input type="file" id="csv-file" accept=".csv">
          <h3>📁 Drop CSV file here or click to browse</h3>
          <p>Supports .csv files up to 100 contacts</p>
        </div>
        
        <div class="file-info" id="file-info" style="display:none">
          <h4>📄 <span id="file-name"></span></h4>
          <p><span id="row-count"></span> contacts detected</p>
          <p>Columns: <span id="columns-detected"></span></p>
        </div>
        
        <button class="btn" id="btn-validate" onclick="validateCSV()" style="display:none">Next: Validate Data →</button>
      </div>
      
      <!-- Step 2: Compliance Check -->
      <div class="step" id="step-2">
        <h3 style="margin-bottom:20px">✅ Compliance Validation</h3>
        
        <div class="warning" style="display:block;margin-bottom:20px">
          <strong>⚠️ Important Compliance Notice:</strong><br>
          Before enriching contacts, ensure you have a lawful basis for processing their data under applicable privacy laws (GDPR, Australian Privacy Act, etc.). This typically means:
          <ul style="margin:10px 0 0 20px">
            <li>Legitimate business interest with existing relationship</li>
            <li>Consent for marketing communications</li>
            <li>Compliance with Do Not Call registers</li>
          </ul>
        </div>
        
        <div id="compliance-summary"></div>
        
        <div class="compliance-report" id="compliance-report"></div>
        
        <div style="margin-top:20px;display:flex;gap:10px">
          <button class="btn btn-secondary" onclick="goToStep(1)">← Back</button>
          <button class="btn" id="btn-enrich" onclick="startEnrichment()">I Confirm Compliance - Start Enrichment →</button>
        </div>
      </div>
      
      <!-- Step 3: Enrichment Progress -->
      <div class="step" id="step-3">
        <h3 style="margin-bottom:20px">⚙️ Enriching Contacts...</h3>
        
        <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
        <p style="text-align:center;color:#8892b0"><span id="progress-text">0</span> of <span id="progress-total">0</span> contacts processed</p>
        
        <div id="enrichment-log" style="max-height:300px;overflow-y:auto;margin-top:20px"></div>
      </div>
      
      <!-- Step 4: Results -->
      <div class="step" id="step-4">
        <h3 style="margin-bottom:20px">✅ Enrichment Complete!</h3>
        
        <div class="result-grid" id="bulk-summary"></div>
        
        <div class="warning" style="display:block;margin:20px 0">
          <strong>📞 Australian Phone Numbers:</strong> Before calling any Australian mobile numbers, verify against the <a href="https://www.donotcall.gov.au/" target="_blank" style="color:#ffc107">ACMA Do Not Call Register</a>. Numbers flagged in the export require DNC verification.
        </div>
        
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="downloadResults()">⬇️ Download Enriched CSV</button>
          <button class="btn btn-secondary" onclick="resetBulk()">🔄 Upload Another File</button>
        </div>
        
        <div id="bulk-results" style="margin-top:20px"></div>
      </div>
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
    function showLoading(id, show) { document.getElementById(id).classList.toggle('show', show); }
    function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.add('show'); }
    function hideError(id) { document.getElementById(id).classList.remove('show'); }
    
    // ============ DISCOVER ============
    async function discover() {
      const firstName = document.getElementById('d-firstName').value.trim();
      const lastName = document.getElementById('d-lastName').value.trim();
      if (!firstName || !lastName) { showError('d-error', 'First and last name required'); return; }
      showLoading('d-loading', true); hideError('d-error'); document.getElementById('d-results').innerHTML = '';
      try {
        const params = new URLSearchParams({ firstName, lastName, company: document.getElementById('d-company').value, domain: document.getElementById('d-domain').value });
        const resp = await fetch('/api/discover?' + params);
        const data = await resp.json();
        renderDiscoverResults(data);
      } catch (e) { showError('d-error', e.message); }
      finally { showLoading('d-loading', false); }
    }
    
    function renderDiscoverResults(d) {
      let h = '<div class="result-card"><h3>👤 ' + esc(d.firstName + ' ' + d.lastName) + '</h3>';
      if (d.linkedin) h += '<p><a href="' + esc(d.linkedin) + '" target="_blank">' + esc(d.linkedin) + '</a></p>';
      h += '<h4 style="margin:15px 0 10px;color:#8892b0">📧 Emails</h4>';
      if (d.emails?.length) d.emails.forEach(e => { h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><span class="badge badge-source">' + esc(e.source) + '</span></div>'; });
      else h += '<p style="color:#5a6a8a">No emails found</p>';
      h += '<h4 style="margin:15px 0 10px;color:#8892b0">📱 Phones</h4>';
      if (d.phones?.length) d.phones.forEach(p => { h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><span class="badge badge-source">' + esc(p.source) + '</span></div>'; });
      else h += '<p style="color:#5a6a8a">No phones found</p>';
      h += '<div class="duration">' + d.duration + 'ms</div></div>';
      document.getElementById('d-results').innerHTML = h;
    }
    
    // ============ PROSPECT ============
    async function prospect() {
      const titles = document.getElementById('p-titles').value.split(',').map(s => s.trim()).filter(Boolean);
      const locations = document.getElementById('p-locations').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!titles.length && !locations.length) { showError('p-error', 'Enter titles or locations'); return; }
      showLoading('p-loading', true); hideError('p-error'); document.getElementById('p-results').innerHTML = '';
      try {
        const resp = await fetch('/api/prospect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ titles, locations, seniorities: document.getElementById('p-seniority').value ? [document.getElementById('p-seniority').value] : [], limit: parseInt(document.getElementById('p-limit').value) }) });
        const data = await resp.json();
        let h = '<div class="result-card"><h3>🎯 Found ' + data.total + ' prospects</h3><div class="result-grid">';
        data.prospects?.forEach(p => { h += '<div class="result-item"><div class="label">' + esc(p.title) + '</div><div class="value">' + esc(p.name) + '</div><div style="color:#8892b0;font-size:0.85em">' + esc(p.company) + '</div></div>'; });
        h += '</div><div class="duration">' + data.duration + 'ms</div></div>';
        document.getElementById('p-results').innerHTML = h;
      } catch (e) { showError('p-error', e.message); }
      finally { showLoading('p-loading', false); }
    }
    
    // ============ COMPANY ============
    async function companyIntel() {
      const domain = document.getElementById('c-domain').value.trim();
      if (!domain) { showError('c-error', 'Domain required'); return; }
      showLoading('c-loading', true); hideError('c-error'); document.getElementById('c-results').innerHTML = '';
      try {
        const resp = await fetch('/api/company?domain=' + encodeURIComponent(domain));
        const data = await resp.json();
        const c = data.company;
        let h = '<div class="result-card"><h3>🏢 ' + esc(c?.name || 'Not found') + '</h3>';
        if (c) {
          h += '<div class="result-grid">';
          if (c.domain) h += '<div class="result-item"><div class="label">Domain</div><div class="value">' + esc(c.domain) + '</div></div>';
          if (c.employees?.au) h += '<div class="result-item"><div class="label">AU Employees</div><div class="value">' + c.employees.au + '</div></div>';
          if (c.employees?.global) h += '<div class="result-item"><div class="label">Global</div><div class="value">' + c.employees.global + '</div></div>';
          if (c.abn) h += '<div class="result-item"><div class="label">ABN</div><div class="value">' + esc(c.abn) + '</div></div>';
          if (c.phone) h += '<div class="result-item"><div class="label">Phone</div><div class="value">' + esc(c.phone) + '</div></div>';
          h += '</div>';
          if (c.description) h += '<p style="margin-top:15px;color:#8892b0">' + esc(c.description.substring(0, 300)) + '</p>';
        }
        h += '<div class="duration">' + data.duration + 'ms</div></div>';
        document.getElementById('c-results').innerHTML = h;
      } catch (e) { showError('c-error', e.message); }
      finally { showLoading('c-loading', false); }
    }
    
    // ============ LINKEDIN ============
    async function linkedinLookup() {
      const url = document.getElementById('l-url').value.trim();
      if (!url) { showError('l-error', 'URL required'); return; }
      showLoading('l-loading', true); hideError('l-error'); document.getElementById('l-results').innerHTML = '';
      try {
        const resp = await fetch('/api/linkedin?url=' + encodeURIComponent(url));
        const data = await resp.json();
        let h = '<div class="result-card"><h3>🔗 ' + esc((data.person?.firstName || '') + ' ' + (data.person?.lastName || '')) + '</h3>';
        if (data.person?.title) h += '<p style="color:#8892b0">' + esc(data.person.title) + '</p>';
        h += '<h4 style="margin:15px 0 10px;color:#8892b0">📧 Emails</h4>';
        if (data.emails?.length) data.emails.forEach(e => { h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><span class="badge badge-source">' + esc(e.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a">No emails found</p>';
        h += '<h4 style="margin:15px 0 10px;color:#8892b0">📱 Phones</h4>';
        if (data.phones?.length) data.phones.forEach(p => { h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><span class="badge badge-source">' + esc(p.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a">No phones found</p>';
        h += '<div class="duration">' + data.duration + 'ms</div></div>';
        document.getElementById('l-results').innerHTML = h;
      } catch (e) { showError('l-error', e.message); }
      finally { showLoading('l-loading', false); }
    }
    
    // ============ BULK UPLOAD ============
    let bulkData = { csv: null, contacts: [], validated: [], enriched: [] };
    
    // File upload handling
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('csv-file');
    
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
    
    function handleFile(file) {
      if (!file || !file.name.endsWith('.csv')) { alert('Please upload a CSV file'); return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        bulkData.csv = e.target.result;
        document.getElementById('file-name').textContent = file.name;
        
        // Quick parse to show info
        const lines = bulkData.csv.trim().split('\\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
        document.getElementById('row-count').textContent = lines.length - 1;
        document.getElementById('columns-detected').textContent = headers.slice(0, 5).join(', ') + (headers.length > 5 ? '...' : '');
        
        document.getElementById('file-info').style.display = 'block';
        document.getElementById('btn-validate').style.display = 'inline-block';
      };
      reader.readAsText(file);
    }
    
    async function validateCSV() {
      try {
        const resp = await fetch('/api/bulk/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: bulkData.csv })
        });
        const data = await resp.json();
        
        if (data.error) { alert(data.error); return; }
        
        bulkData.contacts = data.validContacts;
        bulkData.issues = data.issues;
        
        // Show compliance summary
        let summary = '<div class="result-grid">';
        summary += '<div class="result-item ' + (data.validContacts.length > 0 ? 'success' : '') + '"><div class="label">Valid Contacts</div><div class="value" style="font-size:1.5em;color:#28a745">' + data.validContacts.length + '</div></div>';
        summary += '<div class="result-item ' + (data.issues.length > 0 ? 'error' : '') + '"><div class="label">Issues Found</div><div class="value" style="font-size:1.5em;color:' + (data.issues.length > 0 ? '#dc3545' : '#28a745') + '">' + data.issues.length + '</div></div>';
        summary += '<div class="result-item"><div class="label">Total Rows</div><div class="value" style="font-size:1.5em">' + data.totalRows + '</div></div>';
        summary += '</div>';
        document.getElementById('compliance-summary').innerHTML = summary;
        
        // Show issues
        let issues = '';
        if (data.issues.length > 0) {
          issues = '<h4 style="margin-bottom:10px;color:#dc3545">⚠️ Issues to Review</h4>';
          data.issues.forEach(i => {
            issues += '<div class="compliance-item error"><strong>Row ' + i.row + ':</strong> ' + esc(i.contact) + '<br><span style="color:#8892b0">' + i.issues.join(', ') + '</span></div>';
          });
        }
        document.getElementById('compliance-report').innerHTML = issues;
        
        document.getElementById('btn-enrich').disabled = data.validContacts.length === 0;
        
        goToStep(2);
      } catch (e) {
        alert('Validation error: ' + e.message);
      }
    }
    
    async function startEnrichment() {
      goToStep(3);
      
      document.getElementById('progress-total').textContent = bulkData.contacts.length;
      document.getElementById('enrichment-log').innerHTML = '';
      
      try {
        const resp = await fetch('/api/bulk/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: bulkData.contacts })
        });
        
        const data = await resp.json();
        bulkData.enriched = data.results;
        
        // Update progress to 100%
        document.getElementById('progress-fill').style.width = '100%';
        document.getElementById('progress-text').textContent = bulkData.contacts.length;
        
        // Show summary
        const emailsFound = data.results.filter(r => r.emails?.length > 0).length;
        const phonesFound = data.results.filter(r => r.phones?.length > 0).length;
        const linkedinFound = data.results.filter(r => r.linkedin).length;
        
        let summary = '<div class="result-item"><div class="label">Contacts Enriched</div><div class="value" style="font-size:1.5em">' + data.results.length + '</div></div>';
        summary += '<div class="result-item"><div class="label">Emails Found</div><div class="value" style="font-size:1.5em;color:#28a745">' + emailsFound + '</div></div>';
        summary += '<div class="result-item"><div class="label">Phones Found</div><div class="value" style="font-size:1.5em;color:#4ecdc4">' + phonesFound + '</div></div>';
        summary += '<div class="result-item"><div class="label">LinkedIn Found</div><div class="value" style="font-size:1.5em;color:#0077b5">' + linkedinFound + '</div></div>';
        document.getElementById('bulk-summary').innerHTML = summary;
        
        // Show preview table
        let table = '<table><thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Sources</th></tr></thead><tbody>';
        data.results.slice(0, 10).forEach(r => {
          table += '<tr><td>' + esc(r.firstName + ' ' + r.lastName) + '</td><td>' + esc(r.company) + '</td><td>' + esc(r.emails?.[0]?.email || '-') + '</td><td>' + esc(r.phones?.[0]?.number || '-') + '</td><td>' + esc(r.sources?.join(', ')) + '</td></tr>';
        });
        if (data.results.length > 10) table += '<tr><td colspan="5" style="text-align:center;color:#8892b0">...and ' + (data.results.length - 10) + ' more</td></tr>';
        table += '</tbody></table>';
        document.getElementById('bulk-results').innerHTML = table;
        
        goToStep(4);
      } catch (e) {
        alert('Enrichment error: ' + e.message);
      }
    }
    
    function downloadResults() {
      fetch('/api/bulk/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: bulkData.enriched })
      })
      .then(resp => resp.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'enriched_contacts_' + new Date().toISOString().slice(0,10) + '.csv';
        a.click();
      });
    }
    
    function resetBulk() {
      bulkData = { csv: null, contacts: [], validated: [], enriched: [] };
      document.getElementById('file-info').style.display = 'none';
      document.getElementById('btn-validate').style.display = 'none';
      fileInput.value = '';
      goToStep(1);
    }
    
    function goToStep(n) {
      document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
      document.getElementById('step-' + n).classList.add('active');
      for (let i = 1; i <= 4; i++) {
        const dot = document.getElementById('dot-' + i);
        dot.classList.remove('active', 'completed');
        if (i < n) dot.classList.add('completed');
        if (i === n) dot.classList.add('active');
      }
    }
  </script>
</body>
</html>`;

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '5.0.0' }));
    return;
  }

  // Web UI
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // Template CSV download
  if (parsed.pathname === '/api/bulk/template') {
    const template = `firstName,lastName,company,domain,linkedin,title,location,email,phone,doNotContact,optedOut
John,Smith,Acme Corp,acme.com,https://linkedin.com/in/johnsmith,CEO,Sydney,,,,
Jane,Doe,Tech Startup,techstartup.io,,CTO,Melbourne,,,,
Tom,Cowan,TDM Growth Partners,tdmgrowthpartners.com,,,Sydney,,,,`;
    res.writeHead(200, { 
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="contact_template.csv"'
    });
    res.end(template);
    return;
  }

  // API: Discover
  if (parsed.pathname === '/api/discover') {
    const { firstName, lastName, company, domain, linkedin } = parsed.query;
    if (!firstName || !lastName) { res.writeHead(400); res.end(JSON.stringify({ error: 'firstName and lastName required' })); return; }
    console.log(`\x1b[36m🔍 Discover: ${firstName} ${lastName}\x1b[0m`);
    const results = discoverPerson(firstName, lastName, company || '', domain || '', linkedin || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: Prospect
  if (parsed.pathname === '/api/prospect' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const filters = JSON.parse(body);
      console.log(`\x1b[36m🎯 Prospect: ${JSON.stringify(filters)}\x1b[0m`);
      const results = prospectPeople(filters);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    });
    return;
  }

  // API: Company
  if (parsed.pathname === '/api/company') {
    const { domain } = parsed.query;
    if (!domain) { res.writeHead(400); res.end(JSON.stringify({ error: 'domain required' })); return; }
    console.log(`\x1b[36m🏢 Company: ${domain}\x1b[0m`);
    const results = getCompanyIntel(domain);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: LinkedIn
  if (parsed.pathname === '/api/linkedin') {
    const { url: liUrl } = parsed.query;
    if (!liUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'url required' })); return; }
    console.log(`\x1b[36m🔗 LinkedIn: ${liUrl}\x1b[0m`);
    const results = enrichLinkedIn(liUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: Bulk Validate
  if (parsed.pathname === '/api/bulk/validate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { csv } = JSON.parse(body);
        const parsed = parseCSV(csv);
        if (parsed.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: parsed.error, detectedColumns: parsed.detectedColumns }));
          return;
        }
        
        if (parsed.contacts.length > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Maximum 100 contacts per batch. Please split your file.' }));
          return;
        }
        
        const compliance = checkCompliance(parsed.contacts);
        console.log(`\x1b[36m📋 Bulk Validate: ${compliance.validContacts.length} valid, ${compliance.issues.length} issues\x1b[0m`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(compliance));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Bulk Enrich
  if (parsed.pathname === '/api/bulk/enrich' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { contacts } = JSON.parse(body);
        console.log(`\x1b[36m📋 Bulk Enrich: ${contacts.length} contacts\x1b[0m`);
        
        const results = await enrichContactsBulk(contacts, (current, total, contact) => {
          console.log(`  [${current}/${total}] ${contact.firstName} ${contact.lastName}: ${contact.emails?.length || 0} emails, ${contact.phones?.length || 0} phones`);
        });
        
        console.log(`\x1b[32m✅ Bulk complete: ${results.length} enriched\x1b[0m`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Bulk Download
  if (parsed.pathname === '/api/bulk/download' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { results } = JSON.parse(body);
        const csv = generateCSV(results);
        
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="enriched_contacts.csv"'
        });
        res.end(csv);
      } catch (e) {
        res.writeHead(500);
        res.end('Error generating CSV');
      }
    });
    return;
  }

  // Slack commands (same endpoints as v4)
  if (parsed.pathname.startsWith('/slack/')) {
    // ... (Slack handling - abbreviated for space)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'Slack endpoint - use /api/ for direct access' }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`
\x1b[1m┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   🔍 Contact Discovery v5                                     │
│                                                               │
│   Web:     http://localhost:${PORT}                               │
│                                                               │
│   Features:                                                   │
│     • Discover Person    • Prospect Search (FREE)             │
│     • Company Intel      • LinkedIn Enrichment                │
│     • 📋 BULK UPLOAD (NEW!) - CSV with compliance workflow    │
│                                                               │
│   APIs: SerpAPI ✓  Apollo ✓  Firmable ✓  Lusha ✓              │
│                                                               │
└───────────────────────────────────────────────────────────────┘\x1b[0m
  `);
});
