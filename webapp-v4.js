#!/usr/bin/env node
/**
 * Contact Discovery Web App v6
 * 
 * Features:
 *   1. /discover - Person lookup
 *   2. /prospect - Find new leads by criteria (Apollo FREE)
 *   3. /company - Full company intelligence
 *   4. /linkedin - LinkedIn URL → contact info
 *   5. /bulk - Bulk CSV upload with compliance workflow
 *   6. /colleagues - Find specific roles at a company (NEW)
 * 
 * APIs: SerpAPI, Apollo.io, Firmable, Lusha
 */

const http = require('http');
const { execSync } = require('child_process');
const watchlist = require('./watchlist.js');
const stats = require('./stats.js');
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
// 6. COLLEAGUES - Find specific roles at a company (NEW)
// ============================================================================


// Safe JSON parse - returns empty object on failure
function safeJsonParse(str, fallback = {}) {
  try {
    return JSON.parse(str || '{}');
  } catch (e) {
    console.error('JSON parse error:', e.message);
    return fallback;
  }
}

// Safe POST handler wrapper
function handlePost(req, res, handler) {
  let body = '';
  req.on('data', c => body += c);
  req.on('error', e => {
    console.error('Request error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request error: ' + e.message }));
  });
  req.on('end', () => {
    try {
      const data = safeJsonParse(body);
      handler(data, (status, result) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    } catch (e) {
      console.error('Handler error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
    }
  });
}

function findColleagues(companyDomain, filters = {}) {
  const start = Date.now();
  const { roles, seniority, department, limit = 10 } = filters;
  
  const results = {
    company: null,
    colleagues: [],
    total: 0,
    duration: 0,
    sources: {},
  };
  
  // Normalize domain
  let domain = companyDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) {
    domain = companyDomain.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  // Get company info from Firmable first
  try {
    const firmData = curlGet(
      `https://api.firmable.com/company?website=${encodeURIComponent(domain)}`,
      { 'Authorization': `Bearer ${config.firmable.apiKey}` }
    );
    if (firmData.id) {
      results.company = {
        id: firmData.id,
        name: firmData.name,
        domain: firmData.fqdn || domain,
        employees: firmData.au_employee_count,
        website: firmData.website,
      };
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) {
    results.sources.firmable = { status: 'error', error: e.message };
  }
  
  // Use Apollo People Search to find colleagues (FREE - no credits)
  try {
    const params = new URLSearchParams();
    params.append('organization_domains[]', domain);
    
    // Add role/title filters
    if (roles?.length) {
      // Expand common role abbreviations
      const expandedRoles = [];
      roles.forEach(r => {
        expandedRoles.push(r);
        const rLower = r.toLowerCase();
        if (rLower === 'ceo') expandedRoles.push('Chief Executive Officer');
        if (rLower === 'cfo') expandedRoles.push('Chief Financial Officer');
        if (rLower === 'cto') expandedRoles.push('Chief Technology Officer');
        if (rLower === 'coo') expandedRoles.push('Chief Operating Officer');
        if (rLower === 'cmo') expandedRoles.push('Chief Marketing Officer');
        if (rLower === 'cpo') expandedRoles.push('Chief Product Officer');
        if (rLower === 'chro') expandedRoles.push('Chief Human Resources Officer');
        if (rLower === 'ciso') expandedRoles.push('Chief Information Security Officer');
        if (rLower === 'vp') expandedRoles.push('Vice President');
        if (rLower === 'md') expandedRoles.push('Managing Director');
        if (rLower === 'gm') expandedRoles.push('General Manager');
      });
      [...new Set(expandedRoles)].forEach(t => params.append('person_titles[]', t));
    }
    
    // Add seniority filter
    if (seniority) {
      const seniorityMap = {
        'c-suite': 'c_suite',
        'csuite': 'c_suite',
        'executive': 'c_suite',
        'vp': 'vp',
        'director': 'director',
        'manager': 'manager',
        'senior': 'senior',
        'entry': 'entry',
      };
      const mappedSeniority = seniorityMap[seniority.toLowerCase()] || seniority;
      params.append('person_seniorities[]', mappedSeniority);
    }
    
    // Add department filter
    if (department) {
      const deptMap = {
        'finance': 'finance',
        'engineering': 'engineering',
        'sales': 'sales',
        'marketing': 'marketing',
        'hr': 'human_resources',
        'human resources': 'human_resources',
        'operations': 'operations',
        'legal': 'legal',
        'it': 'information_technology',
        'product': 'product_management',
      };
      const mappedDept = deptMap[department.toLowerCase()] || department;
      params.append('organization_departments[]', mappedDept);
    }
    
    params.append('per_page', Math.min(limit, 25).toString());
    params.append('page', '1');
    
    const apolloData = curlPost(
      `https://api.apollo.io/api/v1/mixed_people/api_search?${params}`,
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      {}
    );
    
    if (apolloData.people?.length) {
      results.total = apolloData.pagination?.total_entries || apolloData.people.length;
      results.colleagues = apolloData.people.slice(0, limit).map(p => ({
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        title: p.title,
        seniority: p.seniority,
        department: p.departments?.[0],
        linkedin: p.linkedin_url,
        location: p.city ? `${p.city}, ${p.state || p.country}` : p.country,
        email: null, // Need to enrich separately
        phone: null,
      }));
      
      // If company info wasn't found via Firmable, use Apollo
      if (!results.company && apolloData.people[0]?.organization) {
        const org = apolloData.people[0].organization;
        results.company = {
          name: org.name,
          domain: org.primary_domain,
          employees: org.estimated_num_employees,
          website: org.website_url,
        };
      }
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) {
    results.sources.apollo = { status: 'error', error: e.message };
  }
  
  results.duration = Date.now() - start;
  return results;
}

// Enrich a single colleague with contact info
function enrichColleague(colleague) {
  const results = {
    ...colleague,
    emails: [],
    phones: [],
    enriched: true,
  };
  
  // Apollo enrichment
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/v1/people/match',
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { 
        first_name: colleague.firstName, 
        last_name: colleague.lastName,
        linkedin_url: colleague.linkedin,
        reveal_personal_emails: true
      }
    );
    
    if (apolloData.person) {
      if (apolloData.person.email) {
        results.emails.push({ 
          email: apolloData.person.email, 
          source: 'Apollo',
          verified: apolloData.person.email_status === 'verified'
        });
      }
      if (apolloData.person.personal_emails?.length) {
        apolloData.person.personal_emails.forEach(e => {
          results.emails.push({ email: e, source: 'Apollo', type: 'personal' });
        });
      }
      if (apolloData.person.phone_numbers?.length) {
        apolloData.person.phone_numbers.forEach(p => {
          results.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo' });
        });
      }
    }
  } catch (e) { /* continue */ }
  
  // Lusha enrichment if we have LinkedIn
  if (colleague.linkedin) {
    try {
      const lushaData = curlGet(
        `https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(colleague.linkedin)}&revealEmails=true&revealPhones=true`,
        { 'api_key': config.lusha.apiKey }
      );
      const d = lushaData.data || lushaData.contact?.data;
      if (d) {
        if (d.emailAddresses?.length) {
          d.emailAddresses.forEach(e => {
            if (!results.emails.find(x => x.email === e.email)) {
              results.emails.push({ email: e.email, source: 'Lusha', type: e.emailType });
            }
          });
        }
        if (d.phoneNumbers?.length) {
          d.phoneNumbers.forEach(p => {
            const num = p.internationalNumber || p.localizedNumber;
            if (!results.phones.find(x => x.number === num)) {
              results.phones.push({ number: num, source: 'Lusha', type: p.type });
            }
          });
        }
      }
    } catch (e) { /* continue */ }
  }
  
  return results;
}

// ============================================================================
// EXISTING FUNCTIONS (abbreviated - same as v5)
// ============================================================================

function discoverPerson(firstName, lastName, company, domain, linkedinUrl) {
  const start = Date.now();
  const results = { firstName, lastName, company, linkedin: linkedinUrl || null, emails: [], phones: [], companyInfo: null, sources: {} };

  // 1. Find LinkedIn URL if not provided (SerpAPI)
  if (!results.linkedin) {
    try {
      const query = `${firstName} ${lastName} ${company} site:linkedin.com`;
      const serpData = curlGet(`https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(query)}&num=5&gl=au`);
      const li = serpData.organic_results?.find(r => r.link?.includes('linkedin.com/in/'));
      if (li) results.linkedin = li.link;
      results.sources.serp = { status: 'success' };
    } catch (e) { results.sources.serp = { status: 'error', message: e.message }; }
  }

  // 2. Apollo - Get work email
  try {
    const apolloData = curlPost('https://api.apollo.io/v1/people/match', { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { first_name: firstName, last_name: lastName, organization_name: company, domain, reveal_personal_emails: true });
    if (apolloData.person) {
      if (apolloData.person.email) results.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified' });
      if (apolloData.person.personal_emails?.length) apolloData.person.personal_emails.forEach(e => results.emails.push({ email: e, source: 'Apollo', type: 'personal' }));
      if (apolloData.person.phone_numbers?.length) apolloData.person.phone_numbers.forEach(p => results.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo' }));
      if (!results.linkedin && apolloData.person.linkedin_url) results.linkedin = apolloData.person.linkedin_url;
    }
    results.sources.apollo = { status: 'success' };
  } catch (e) { results.sources.apollo = { status: 'error', message: e.message }; }

  // 3. Lusha - Get emails and phones via LinkedIn URL
  if (results.linkedin) {
    try {
      const lushaData = curlGet(`https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(results.linkedin)}&revealEmails=true&revealPhones=true`, { 'api_key': config.lusha.apiKey });
      const d = lushaData.data || lushaData.contact?.data;
      if (d) {
        if (d.emailAddresses?.length) {
          d.emailAddresses.forEach(e => {
            if (!results.emails.find(x => x.email === e.email)) {
              results.emails.push({ email: e.email, source: 'Lusha', type: e.emailType });
            }
          });
        }
        if (d.phoneNumbers?.length) {
          d.phoneNumbers.forEach(p => {
            const num = p.internationalNumber || p.localizedNumber;
            if (num && !results.phones.find(x => x.number === num)) {
              results.phones.push({ number: num, source: 'Lusha', type: p.type });
            }
          });
        }
      }
      results.sources.lusha = { status: 'success' };
    } catch (e) { results.sources.lusha = { status: 'error', message: e.message }; }
  }

  // 4. Firmable - Get company info and AU data
  try {
    let searchDomain = domain || (company ? company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au' : null);
    if (searchDomain) {
      const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(searchDomain)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
      if (firmData.id) {
        results.companyInfo = { name: firmData.name, domain: firmData.fqdn, employees: firmData.au_employee_count, abn: firmData.abn, phone: firmData.phone };
        if (firmData.phone && !results.phones.find(x => x.number === firmData.phone)) {
          results.phones.push({ number: firmData.phone, source: 'Firmable', type: 'company' });
        }
      }
    }
    results.sources.firmable = { status: 'success' };
  } catch (e) { results.sources.firmable = { status: 'error', message: e.message }; }

  results.duration = Date.now() - start;
  return results;
}


function prospectPeople(filters) {
  const start = Date.now();
  const { titles, locations, seniorities, limit = 10 } = filters;
  
  // Build request body for new api_search endpoint
  const requestBody = {
    per_page: Math.min(limit, 25)
  };
  
  if (titles?.length) requestBody.person_titles = titles;
  if (locations?.length) requestBody.person_locations = locations;
  if (seniorities?.length) requestBody.person_seniorities = seniorities;

  const results = { prospects: [], total: 0, duration: 0 };
  try {
    const apolloData = curlPost(
      'https://api.apollo.io/api/v1/mixed_people/api_search', 
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey }, 
      requestBody
    );
    if (apolloData.people?.length) {
      results.total = apolloData.total_entries || apolloData.people.length;
      results.prospects = apolloData.people.slice(0, limit).map(p => ({
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), 
        firstName: p.first_name, 
        lastName: p.last_name,
        title: p.title, 
        company: p.organization?.name, 
        companyDomain: p.organization?.primary_domain, 
        linkedin: p.linkedin_url,
        location: p.city ? `${p.city}, ${p.state || p.country}` : p.country,
      }));
    }
  } catch (e) { results.error = e.message; }
  results.duration = Date.now() - start;
  return results;
}

function getCompanyIntel(domainOrName) {
  const start = Date.now();
  const results = { company: null, techStack: [], jobs: [], sources: {} };
  let domain = domainOrName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) domain = domainOrName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';

  try {
    const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(domain)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
    if (firmData.id) {
      results.company = { name: firmData.name, domain: firmData.fqdn, website: firmData.website, description: firmData.description,
        founded: firmData.year_founded, employees: { au: firmData.au_employee_count }, abn: firmData.abn, acn: firmData.acn, phone: firmData.phone,
        linkedin: firmData.linkedin ? `https://linkedin.com/company/${firmData.linkedin}` : null };
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
// ABN LOOKUP - Australian Business Number verification
// ============================================================================

function lookupABN(query) {
  const start = Date.now();
  const results = {
    query: query,
    matches: [],
    duration: 0,
  };
  
  // Clean the query - could be ABN number or company name
  const cleanQuery = query.trim().replace(/\s+/g, ' ');
  const isABNNumber = /^\d[\d\s]{9,}$/.test(cleanQuery.replace(/\s/g, ''));
  
  try {
    let searchQuery;
    if (isABNNumber) {
      // Direct ABN lookup
      const abnClean = cleanQuery.replace(/\s/g, '');
      searchQuery = `ABN ${abnClean} site:abr.business.gov.au`;
    } else {
      // Company name search
      searchQuery = `${cleanQuery} ABN site:abr.business.gov.au`;
    }
    
    const serpUrl = `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(searchQuery)}&num=5&gl=au`;
    const serpData = curlGet(serpUrl);
    
    if (serpData.organic_results?.length) {
      serpData.organic_results.forEach(r => {
        // Extract ABN from URL or title
        const abnMatch = r.link?.match(/(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})/);
        const titleAbnMatch = r.title?.match(/ABN\s*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})/i);
        
        if (abnMatch || titleAbnMatch) {
          const abn = (abnMatch?.[1] || titleAbnMatch?.[1]).replace(/\s/g, '');
          const formattedABN = abn.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4');
          
          // Extract entity name from title
          let entityName = r.snippet?.match(/Entity name:s*([^.]+)/i)?.[1]?.trim() || r.title?.replace(/Current details for ABN.*$/i, '').trim();
          entityName = entityName?.replace(/ABN\s*\d+/gi, '').trim();
          
          // Extract status from snippet
          const statusMatch = r.snippet?.match(/(Active|Cancelled|Suspended)\s+from\s+(\d{1,2}\s+\w+\s+\d{4})/i);
          const entityTypeMatch = r.snippet?.match(/Entity type:\s*([^.]+)/i);
          
          // Avoid duplicates
          if (!results.matches.find(m => m.abn === formattedABN)) {
            results.matches.push({
              abn: formattedABN,
              abnRaw: abn,
              entityName: entityName || r.snippet?.match(/Entity name:\s*([^.]+)/i)?.[1]?.trim(),
              status: statusMatch?.[1] || 'Unknown',
              statusDate: statusMatch?.[2],
              entityType: entityTypeMatch?.[1]?.trim(),
              url: r.link,
              snippet: r.snippet?.substring(0, 200),
            });
          }
        }
      });
    }
  } catch (e) {
    results.error = e.message;
  }
  
  results.duration = Date.now() - start;
  return results;
}

// Validate ABN checksum (Australian Business Number validation)
function validateABN(abn) {
  const abnClean = abn.replace(/\s/g, '');
  if (!/^\d{11}$/.test(abnClean)) return { valid: false, error: 'ABN must be 11 digits' };
  
  // ABN validation algorithm
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = 0;
  
  for (let i = 0; i < 11; i++) {
    let digit = parseInt(abnClean[i]);
    if (i === 0) digit -= 1; // Subtract 1 from first digit
    sum += digit * weights[i];
  }
  
  const valid = sum % 89 === 0;
  return {
    valid,
    formatted: abnClean.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4'),
    error: valid ? null : 'Invalid ABN checksum',
  };
}


// ============================================================================
// HIRING SIGNALS - Company job postings and growth indicators
// ============================================================================

function getHiringSignals(companyOrDomain) {
  const start = Date.now();
  const results = {
    company: null,
    jobCount: null,
    jobSources: [],
    careerPages: [],
    growthIndicators: [],
    duration: 0,
  };
  
  // Normalize input
  let domain = companyOrDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  let companyName = companyOrDomain;
  if (domain.includes('.')) {
    companyName = domain.split('.')[0];
  } else {
    domain = companyOrDomain.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  // 1. Get company info from Apollo
  try {
    const orgData = curlGet(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { 'x-api-key': config.apollo.apiKey }
    );
    
    if (orgData.organization) {
      const org = orgData.organization;
      results.company = {
        name: org.name,
        domain: org.primary_domain,
        employees: org.estimated_num_employees,
        industry: org.industry,
        founded: org.founded_year,
        linkedin: org.linkedin_url,
      };
      companyName = org.name;
      
      // Growth indicator based on employee count
      if (org.estimated_num_employees > 1000) {
        results.growthIndicators.push({ type: 'large', label: 'Enterprise (1000+ employees)' });
      } else if (org.estimated_num_employees > 200) {
        results.growthIndicators.push({ type: 'growth', label: 'Scale-up (200-1000 employees)' });
      } else if (org.estimated_num_employees > 50) {
        results.growthIndicators.push({ type: 'growth', label: 'Growth stage (50-200 employees)' });
      }
    }
  } catch (e) { /* continue */ }
  
  // 2. Search for job count from LinkedIn
  try {
    const liSearch = curlGet(
      `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(companyName + ' jobs site:linkedin.com/company')}&num=5&gl=au`
    );
    
    if (liSearch.organic_results) {
      liSearch.organic_results.forEach(r => {
        if (r.link?.includes('linkedin.com/company')) {
          const jobMatch = r.snippet?.match(/(\d[\d,]*)\s*(?:job|open|position)/i);
          if (jobMatch && !results.jobCount) {
            results.jobCount = parseInt(jobMatch[1].replace(/,/g, ''));
            results.jobSources.push({
              source: 'LinkedIn',
              count: results.jobCount,
              url: r.link,
            });
          }
        }
      });
    }
  } catch (e) { /* continue */ }
  
  // 3. Search for career pages and job boards
  try {
    const careerSearch = curlGet(
      `https://serpapi.com/search.json?api_key=${config.serp.apiKey}&engine=google&q=${encodeURIComponent(companyName + ' careers jobs Australia')}&num=8&gl=au`
    );
    
    if (careerSearch.organic_results) {
      careerSearch.organic_results.forEach(r => {
        const url = r.link?.toLowerCase() || '';
        const isCareerPage = url.includes('career') || url.includes('jobs') || url.includes('hiring') || 
                           url.includes('seek.com') || url.includes('indeed.com') || url.includes('glassdoor');
        
        if (isCareerPage && results.careerPages.length < 5) {
          // Try to extract job count
          const countMatch = r.snippet?.match(/(\d[\d,]*)\s*(?:job|position|opening|role)/i);
          
          results.careerPages.push({
            title: r.title?.substring(0, 60),
            url: r.link,
            snippet: r.snippet?.substring(0, 120),
            jobCount: countMatch ? parseInt(countMatch[1].replace(/,/g, '')) : null,
            source: url.includes('seek.com') ? 'SEEK' : 
                   url.includes('indeed.com') ? 'Indeed' :
                   url.includes('linkedin.com') ? 'LinkedIn' :
                   url.includes('glassdoor') ? 'Glassdoor' : 'Careers Page',
          });
        }
      });
    }
  } catch (e) { /* continue */ }
  
  // 4. Add growth indicators based on hiring activity
  if (results.jobCount) {
    if (results.jobCount > 100) {
      results.growthIndicators.push({ type: 'hot', label: 'Aggressive hiring (100+ open roles)' });
    } else if (results.jobCount > 30) {
      results.growthIndicators.push({ type: 'active', label: 'Active hiring (30+ open roles)' });
    } else if (results.jobCount > 10) {
      results.growthIndicators.push({ type: 'moderate', label: 'Moderate hiring (10+ open roles)' });
    }
  }
  
  results.duration = Date.now() - start;
  return results;
}


// ============================================================================
// TECH STACK - Company technology lookup
// ============================================================================

function getTechStack(companyOrDomain) {
  const start = Date.now();
  const results = {
    company: null,
    technologies: [],
    byCategory: {},
    totalCount: 0,
    duration: 0,
  };
  
  // Normalize domain
  let domain = companyOrDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) {
    domain = companyOrDomain.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  try {
    const orgData = curlGet(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { 'x-api-key': config.apollo.apiKey }
    );
    
    if (orgData.organization) {
      const org = orgData.organization;
      results.company = {
        name: org.name,
        domain: org.primary_domain,
        employees: org.estimated_num_employees,
        industry: org.industry,
      };
      
      if (org.current_technologies?.length) {
        results.technologies = org.current_technologies.map(t => ({
          name: t.name,
          category: t.category || 'Other',
          uid: t.uid,
        }));
        results.totalCount = results.technologies.length;
        
        // Group by category
        results.technologies.forEach(t => {
          if (!results.byCategory[t.category]) {
            results.byCategory[t.category] = [];
          }
          results.byCategory[t.category].push(t.name);
        });
      }
    }
  } catch (e) {
    results.error = e.message;
  }
  
  results.duration = Date.now() - start;
  return results;
}

// Search for companies using a specific technology
function searchByTech(techName, location, limit = 10) {
  const start = Date.now();
  const results = {
    technology: techName,
    companies: [],
    total: 0,
    duration: 0,
  };
  
  try {
    // Use Apollo organization search with technology filter
    const params = new URLSearchParams();
    params.append('organization_technology_names[]', techName);
    if (location) {
      params.append('organization_locations[]', location);
    }
    params.append('per_page', Math.min(limit, 25).toString());
    
    // Search via people to get organizations
    const apolloData = curlPost(
      `https://api.apollo.io/api/v1/mixed_people/api_search?${params}`,
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      {}
    );
    
    if (apolloData.people?.length) {
      // Extract unique companies
      const seen = new Set();
      apolloData.people.forEach(p => {
        if (p.organization && !seen.has(p.organization.id)) {
          seen.add(p.organization.id);
          results.companies.push({
            name: p.organization.name,
            domain: p.organization.primary_domain,
            employees: p.organization.estimated_num_employees,
            industry: p.organization.industry,
            linkedin: p.organization.linkedin_url,
          });
        }
      });
      results.total = results.companies.length;
    }
  } catch (e) {
    results.error = e.message;
  }
  
  results.duration = Date.now() - start;
  return results;
}


// ============================================================================
// LOOKALIKE COMPANIES - Find similar companies
// ============================================================================

function findLookalikes(seedCompany, filters = {}) {
  const start = Date.now();
  const { limit = 10, location, minEmployees, maxEmployees } = filters;
  
  const results = {
    seed: null,
    lookalikes: [],
    criteria: {},
    duration: 0,
  };
  
  // Normalize domain
  let domain = seedCompany.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain.includes('.')) {
    domain = seedCompany.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  }
  
  // Get seed company details
  try {
    const seedData = curlGet(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { 'x-api-key': config.apollo.apiKey }
    );
    
    if (seedData.organization) {
      const org = seedData.organization;
      results.seed = {
        name: org.name,
        domain: org.primary_domain,
        industry: org.industry,
        industryTagId: org.industry_tag_id,
        employees: org.estimated_num_employees,
        founded: org.founded_year,
        keywords: org.keywords?.slice(0, 5),
      };
      
      // Build search criteria based on seed
      results.criteria = {
        industry: org.industry,
        employeeRange: getEmployeeRange(org.estimated_num_employees),
      };
    }
  } catch (e) {
    results.error = 'Could not find seed company: ' + e.message;
    results.duration = Date.now() - start;
    return results;
  }
  
  if (!results.seed) {
    results.error = 'Seed company not found';
    results.duration = Date.now() - start;
    return results;
  }
  
  // Search for similar companies
  try {
    const params = new URLSearchParams();
    
    // Industry filter
    if (results.seed.industryTagId) {
      params.append('organization_industry_tag_ids[]', results.seed.industryTagId);
    }
    
    // Employee range filter
    const empRange = minEmployees && maxEmployees 
      ? `${minEmployees},${maxEmployees}`
      : results.criteria.employeeRange;
    if (empRange) {
      params.append('organization_num_employees_ranges[]', empRange);
    }
    
    // Location filter
    if (location) {
      params.append('organization_locations[]', location);
    }
    
    // Get C-suite to ensure we get real companies
    params.append('person_seniorities[]', 'c_suite');
    params.append('per_page', '25');
    
    const searchData = curlPost(
      `https://api.apollo.io/api/v1/mixed_people/api_search?${params}`,
      { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      {}
    );
    
    if (searchData.people?.length) {
      const seen = new Set();
      seen.add(results.seed.domain); // Exclude seed company
      
      searchData.people.forEach(p => {
        if (p.organization && !seen.has(p.organization.primary_domain)) {
          seen.add(p.organization.primary_domain);
          
          if (results.lookalikes.length < limit) {
            results.lookalikes.push({
              name: p.organization.name,
              domain: p.organization.primary_domain,
              employees: p.organization.estimated_num_employees,
              industry: p.organization.industry,
              linkedin: p.organization.linkedin_url,
              founded: p.organization.founded_year,
              // Similarity score (simple version)
              similarity: calculateSimilarity(results.seed, p.organization),
            });
          }
        }
      });
      
      // Sort by similarity
      results.lookalikes.sort((a, b) => b.similarity - a.similarity);
    }
  } catch (e) {
    results.error = 'Search failed: ' + e.message;
  }
  
  results.duration = Date.now() - start;
  return results;
}

function getEmployeeRange(count) {
  if (!count) return null;
  if (count < 50) return '1,50';
  if (count < 200) return '51,200';
  if (count < 500) return '201,500';
  if (count < 1000) return '501,1000';
  if (count < 5000) return '1001,5000';
  if (count < 10000) return '5001,10000';
  return '10001,1000000';
}

function calculateSimilarity(seed, company) {
  let score = 0;
  
  // Industry match (40 points)
  if (seed.industry && company.industry && 
      seed.industry.toLowerCase() === company.industry?.toLowerCase()) {
    score += 40;
  }
  
  // Employee size similarity (30 points)
  if (seed.employees && company.estimated_num_employees) {
    const ratio = Math.min(seed.employees, company.estimated_num_employees) / 
                  Math.max(seed.employees, company.estimated_num_employees);
    score += Math.round(ratio * 30);
  }
  
  // Founded year similarity (20 points)
  if (seed.founded && company.founded_year) {
    const yearDiff = Math.abs(seed.founded - company.founded_year);
    if (yearDiff <= 2) score += 20;
    else if (yearDiff <= 5) score += 15;
    else if (yearDiff <= 10) score += 10;
    else if (yearDiff <= 20) score += 5;
  }
  
  // Base score for being in results (10 points)
  score += 10;
  
  return score;
}

function enrichLinkedIn(linkedinUrl) {
  const start = Date.now();
  const results = { person: null, emails: [], phones: [], sources: {} };
  let liUrl = linkedinUrl.trim();
  if (!liUrl.startsWith('http')) liUrl = 'https://' + liUrl;

  try {
    const lushaData = curlGet(`https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(liUrl)}&revealEmails=true&revealPhones=true`, { 'api_key': config.lusha.apiKey });
    const d = lushaData.data || lushaData.contact?.data;
    if (d) {
      results.person = { firstName: d.firstName, lastName: d.lastName, title: d.currentJobTitle, company: d.company?.name };
      if (d.emailAddresses?.length) d.emailAddresses.forEach(e => results.emails.push({ email: e.email, source: 'Lusha', type: e.emailType }));
      if (d.phoneNumbers?.length) d.phoneNumbers.forEach(p => results.phones.push({ number: p.internationalNumber || p.localizedNumber, source: 'Lusha', type: p.type }));
    }
    results.sources.lusha = { status: 'success' };
  } catch (e) { results.sources.lusha = { status: 'error' }; }

  try {
    const apolloData = curlPost('https://api.apollo.io/v1/people/match', { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
      { linkedin_url: liUrl, reveal_personal_emails: true });
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

// Compliance & CSV functions (same as v5)
function checkCompliance(contacts) {
  const issues = [], validContacts = [];
  contacts.forEach((c, idx) => {
    const row = idx + 2, contactIssues = [];
    if (!c.firstName?.trim()) contactIssues.push('Missing first name');
    if (!c.lastName?.trim()) contactIssues.push('Missing last name');
    if (!c.company?.trim() && !c.domain?.trim() && !c.linkedin?.trim()) contactIssues.push('Need company, domain, or LinkedIn');
    if (c.doNotContact?.toLowerCase() === 'true') contactIssues.push('Do Not Contact');
    if (c.optedOut?.toLowerCase() === 'true') contactIssues.push('Opted out');
    const isDupe = validContacts.find(x => x.firstName?.toLowerCase() === c.firstName?.toLowerCase() && x.lastName?.toLowerCase() === c.lastName?.toLowerCase() && x.company?.toLowerCase() === c.company?.toLowerCase());
    if (isDupe) contactIssues.push('Duplicate');
    if (contactIssues.length > 0) issues.push({ row, contact: `${c.firstName} ${c.lastName}`, issues: contactIssues });
    else validContacts.push(c);
  });
  return { validContacts, issues, totalRows: contacts.length };
}

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { error: 'Need header + data' };
  const headerRaw = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  const headerMap = {};
  const fieldMappings = { firstName: ['firstname','first_name','first name'], lastName: ['lastname','last_name','last name','surname'],
    company: ['company','company name','organisation'], domain: ['domain','website'], email: ['email'], linkedin: ['linkedin','linkedin url'],
    title: ['title','job title'], doNotContact: ['donotcontact','dnc'], optedOut: ['optedout','opted out'] };
  headerRaw.forEach((h, idx) => {
    const hLower = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [field, variants] of Object.entries(fieldMappings)) {
      if (variants.some(v => v.replace(/[^a-z0-9]/g, '') === hLower)) { headerMap[idx] = field; break; }
    }
  });
  if (!Object.values(headerMap).includes('firstName') || !Object.values(headerMap).includes('lastName')) return { error: 'Need firstName and lastName columns' };
  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.every(v => !v.trim())) continue;
    const contact = {};
    values.forEach((val, idx) => { if (headerMap[idx]) contact[headerMap[idx]] = val.trim().replace(/^["']|["']$/g, ''); });
    contacts.push(contact);
  }
  return { contacts, headers: headerRaw };
}

async function enrichContactsBulk(contacts) {
  const results = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const enriched = { ...c, _enriched: true, _timestamp: new Date().toISOString(), emails: [], phones: [], sources: [] };
    try {
      const apolloData = curlPost('https://api.apollo.io/v1/people/match', { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
        { first_name: c.firstName, last_name: c.lastName, organization_name: c.company, domain: c.domain, reveal_personal_emails: true });
      if (apolloData.person) {
        if (apolloData.person.email) enriched.emails.push({ email: apolloData.person.email, source: 'Apollo', verified: apolloData.person.email_status === 'verified' });
        if (apolloData.person.personal_emails?.length) apolloData.person.personal_emails.forEach(e => enriched.emails.push({ email: e, source: 'Apollo', type: 'personal' }));
        if (apolloData.person.phone_numbers?.length) apolloData.person.phone_numbers.forEach(p => enriched.phones.push({ number: p.sanitized_number || p.raw_number, source: 'Apollo' }));
        if (apolloData.person.linkedin_url) enriched.linkedin = apolloData.person.linkedin_url;
        if (apolloData.person.title) enriched.title = apolloData.person.title;
        enriched.sources.push('Apollo');
      }
    } catch (e) { enriched._error = e.message; }
    
    if (c.domain || c.company) {
      try {
        let d = c.domain || c.company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com.au';
        const firmData = curlGet(`https://api.firmable.com/company?website=${encodeURIComponent(d)}`, { 'Authorization': `Bearer ${config.firmable.apiKey}` });
        if (firmData.id) {
          enriched.companyInfo = { name: firmData.name, domain: firmData.fqdn, auEmployees: firmData.au_employee_count, abn: firmData.abn, phone: firmData.phone };
          if (firmData.phone && !enriched.phones.find(p => p.number === firmData.phone)) enriched.phones.push({ number: firmData.phone, source: 'Firmable', type: 'company' });
          enriched.sources.push('Firmable');
        }
      } catch (e) {}
    }
    
    enriched.phones = enriched.phones.map(p => {
      if (p.number?.startsWith('+61') || p.number?.startsWith('04')) p.dncNote = 'Verify DNC';
      return p;
    });
    results.push(enriched);
    if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

function generateCSV(enrichedContacts) {
  const esc = v => { if (!v) return ''; const s = String(v); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const headers = ['firstName','lastName','company','title','domain','email_1','email_1_source','email_1_verified','phone_1','phone_1_source','phone_1_dnc','linkedin','company_abn','company_au_employees','sources','enriched_at'];
  const rows = [headers.join(',')];
  enrichedContacts.forEach(c => {
    rows.push([esc(c.firstName),esc(c.lastName),esc(c.company),esc(c.title),esc(c.domain||c.companyInfo?.domain),esc(c.emails?.[0]?.email),esc(c.emails?.[0]?.source),c.emails?.[0]?.verified?'Yes':'',esc(c.phones?.[0]?.number),esc(c.phones?.[0]?.source),esc(c.phones?.[0]?.dncNote),esc(c.linkedin),esc(c.companyInfo?.abn),c.companyInfo?.auEmployees||'',esc(c.sources?.join(', ')),esc(c._timestamp)].join(','));
  });
  return rows.join('\n');
}

// ============================================================================
// CRM EXPORT - HubSpot and Salesforce formats
// ============================================================================

function generateHubSpotCSV(contacts) {
  const esc = v => { if (!v) return ''; const s = String(v); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
  
  // HubSpot contact import columns
  const headers = [
    'First Name', 'Last Name', 'Email', 'Phone Number', 'Job Title',
    'Company Name', 'Company Domain', 'LinkedIn URL', 'Lead Status',
    'Contact Owner', 'Lifecycle Stage', 'Notes'
  ];
  
  const rows = [headers.join(',')];
  
  contacts.forEach(c => {
    const email = c.emails?.[0]?.email || c.email || '';
    const phone = c.phones?.[0]?.number || c.phone || '';
    const notes = [
      c.sources?.length ? 'Sources: ' + c.sources.join(', ') : '',
      c.companyInfo?.abn ? 'ABN: ' + c.companyInfo.abn : '',
      c._timestamp ? 'Enriched: ' + c._timestamp : '',
    ].filter(Boolean).join(' | ');
    
    rows.push([
      esc(c.firstName),
      esc(c.lastName),
      esc(email),
      esc(phone),
      esc(c.title || c.lastTitle),
      esc(c.company || c.lastCompany || c.companyInfo?.name),
      esc(c.domain || c.companyInfo?.domain),
      esc(c.linkedin),
      'New',  // Lead Status
      '',     // Contact Owner (leave blank)
      'lead', // Lifecycle Stage
      esc(notes),
    ].join(','));
  });
  
  return rows.join('\n');
}

function generateSalesforceCSV(contacts) {
  const esc = v => { if (!v) return ''; const s = String(v); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
  
  // Salesforce Lead import columns
  const headers = [
    'FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone', 'Title',
    'Company', 'Website', 'LinkedIn__c', 'LeadSource', 'Status',
    'Industry', 'NumberOfEmployees', 'Description'
  ];
  
  const rows = [headers.join(',')];
  
  contacts.forEach(c => {
    const workEmail = c.emails?.find(e => e.type !== 'personal')?.email || c.emails?.[0]?.email || c.email || '';
    const workPhone = c.phones?.find(p => p.type === 'work' || p.type === 'company')?.number || '';
    const mobile = c.phones?.find(p => p.type === 'mobile')?.number || c.phones?.[0]?.number || c.phone || '';
    
    const description = [
      c.sources?.length ? 'Data sources: ' + c.sources.join(', ') : '',
      c.companyInfo?.abn ? 'ABN: ' + c.companyInfo.abn : '',
      c.emails?.length > 1 ? 'Alt emails: ' + c.emails.slice(1).map(e => e.email).join(', ') : '',
    ].filter(Boolean).join('\n');
    
    rows.push([
      esc(c.firstName),
      esc(c.lastName),
      esc(workEmail),
      esc(workPhone),
      esc(mobile),
      esc(c.title || c.lastTitle),
      esc(c.company || c.lastCompany || c.companyInfo?.name),
      esc(c.domain || c.companyInfo?.domain),
      esc(c.linkedin),
      'Contact Discovery Bot',  // LeadSource
      'Open - Not Contacted',   // Status
      esc(c.companyInfo?.industry || ''),
      c.companyInfo?.auEmployees || c.companyInfo?.employees || '',
      esc(description),
    ].join(','));
  });
  
  return rows.join('\n');
}

// Convert various result formats to contact array for export
function normalizeForExport(data, type) {
  const contacts = [];
  
  if (type === 'colleagues' && data.colleagues) {
    data.colleagues.forEach(c => {
      contacts.push({
        firstName: c.firstName,
        lastName: c.lastName,
        title: c.title,
        company: data.company?.name,
        domain: data.company?.domain,
        linkedin: c.linkedin,
        emails: c.emails || [],
        phones: c.phones || [],
        sources: ['Apollo'],
      });
    });
  } else if (type === 'prospects' && data.prospects) {
    data.prospects.forEach(p => {
      contacts.push({
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        company: p.company,
        domain: p.companyDomain,
        linkedin: p.linkedin,
        sources: ['Apollo'],
      });
    });
  } else if (type === 'lookalikes' && data.lookalikes) {
    // For lookalikes, we export company data (no individual contacts)
    data.lookalikes.forEach(c => {
      contacts.push({
        firstName: '',
        lastName: '',
        company: c.name,
        domain: c.domain,
        linkedin: c.linkedin,
        companyInfo: {
          employees: c.employees,
          industry: c.industry,
        },
        sources: ['Apollo'],
      });
    });
  } else if (type === 'discover' && data.firstName) {
    contacts.push({
      firstName: data.firstName,
      lastName: data.lastName,
      company: data.company,
      linkedin: data.linkedin,
      emails: data.emails || [],
      phones: data.phones || [],
      companyInfo: data.companyInfo,
      sources: Object.keys(data.sources || {}),
    });
  } else if (type === 'watchlist' && data.contacts) {
    data.contacts.forEach(c => {
      contacts.push({
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.lastCompany,
        title: c.lastTitle,
        linkedin: c.linkedin,
        email: c.email,
        sources: ['Watchlist'],
      });
    });
  } else if (Array.isArray(data)) {
    return data; // Already an array of contacts
  }
  
  return contacts;
}


// ============================================================================
// HTML UI
// ============================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contact Discovery v6</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; }
    .container { max-width: 1000px; margin: 0 auto; padding: 30px 20px; }
    h1 { text-align: center; margin-bottom: 10px; font-size: 2em; }
    .subtitle { text-align: center; color: #8892b0; margin-bottom: 30px; }
    
    .tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 10px 16px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.2s; font-weight: 500; font-size: 0.85em; }
    .tab:hover { background: rgba(255,255,255,0.1); }
    .tab.active { background: #4ecdc4; color: #1a1a2e; border-color: #4ecdc4; }
    .tab.new { position: relative; }
    .tab.new::after { content: 'NEW'; position: absolute; top: -8px; right: -8px; background: #ff6b6b; color: #fff; font-size: 0.6em; padding: 2px 5px; border-radius: 4px; }
    
    .panel { display: none; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 25px; border: 1px solid rgba(255,255,255,0.1); }
    .panel.active { display: block; }
    
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 15px; }
    .form-group { display: flex; flex-direction: column; }
    label { font-size: 0.85em; color: #8892b0; margin-bottom: 5px; }
    input, select { padding: 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; background: rgba(255,255,255,0.05); color: #fff; font-size: 1em; }
    input:focus, select:focus { outline: none; border-color: #4ecdc4; }
    input::placeholder { color: #5a6a8a; }
    
    .btn { padding: 12px 24px; background: linear-gradient(135deg, #4ecdc4, #44a08d); border: none; border-radius: 8px; color: #fff; font-size: 0.95em; font-weight: 600; cursor: pointer; transition: transform 0.2s; }
    .btn:hover { transform: translateY(-2px); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .btn-sm { padding: 6px 12px; font-size: 0.8em; }
    .btn-secondary { background: rgba(255,255,255,0.1); }
    
    .results { margin-top: 25px; }
    .result-card { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1); }
    .result-card h3 { color: #4ecdc4; margin-bottom: 15px; }
    .result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .result-item { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; }
    .result-item .label { font-size: 0.75em; color: #8892b0; margin-bottom: 4px; text-transform: uppercase; }
    .result-item .value { font-size: 0.95em; word-break: break-all; }
    .result-item .value a { color: #4ecdc4; text-decoration: none; }
    
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7em; margin-left: 4px; }
    .badge-source { background: rgba(78, 205, 196, 0.2); color: #4ecdc4; }
    .badge-verified { background: #28a745; color: #fff; }
    
    .contact-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 6px; flex-wrap: wrap; gap: 6px; }
    .contact-value { font-family: monospace; font-size: 0.9em; }
    .copy-btn { padding: 4px 8px; background: #4ecdc4; border: none; border-radius: 4px; color: #1a1a2e; cursor: pointer; font-size: 0.75em; }
    
    .colleague-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 15px; transition: all 0.2s; }
    .colleague-card:hover { border-color: #4ecdc4; background: rgba(78,205,196,0.05); }
    .colleague-name { font-weight: 600; color: #fff; margin-bottom: 4px; }
    .colleague-title { color: #8892b0; font-size: 0.85em; margin-bottom: 8px; }
    .colleague-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 0.8em; color: #5a6a8a; }
    .colleague-actions { margin-top: 10px; display: flex; gap: 8px; }
    .colleague-enriched { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
    
    .loading { display: none; text-align: center; padding: 30px; }
    .loading.show { display: block; }
    .spinner { width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #4ecdc4; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 10px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .error { background: rgba(220, 53, 69, 0.2); border: 1px solid #dc3545; color: #ff6b6b; padding: 12px; border-radius: 8px; margin-top: 15px; display: none; }
    .error.show { display: block; }
    
    .duration { text-align: right; color: #5a6a8a; font-size: 0.8em; margin-top: 10px; }
    
    .quick-roles { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px; }
    .quick-role { padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; cursor: pointer; font-size: 0.8em; transition: all 0.2s; }
    .quick-role:hover { background: rgba(78,205,196,0.2); border-color: #4ecdc4; }
    .quick-role.active { background: #4ecdc4; color: #1a1a2e; }
    
    /* Bulk upload styles */
    .upload-zone { border: 2px dashed rgba(255,255,255,0.2); border-radius: 12px; padding: 30px; text-align: center; cursor: pointer; transition: all 0.2s; margin-bottom: 15px; }
    .upload-zone:hover { border-color: #4ecdc4; background: rgba(78,205,196,0.1); }
    .upload-zone input { display: none; }
    .file-info { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-bottom: 15px; }
    .step { display: none; }
    .step.active { display: block; }
    .step-indicator { display: flex; justify-content: center; gap: 8px; margin-bottom: 20px; }
    .step-dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,0.2); }
    .step-dot.active { background: #4ecdc4; }
    .step-dot.completed { background: #28a745; }
    .progress-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin: 12px 0; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #4ecdc4, #44a08d); transition: width 0.3s; }
    .warning { background: rgba(255,193,7,0.2); border: 1px solid #ffc107; color: #ffc107; padding: 12px; border-radius: 8px; margin: 15px 0; }
    .compliance-item { padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 6px; border-left: 3px solid #dc3545; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8em; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { color: #8892b0; }
    .instructions { background: rgba(78,205,196,0.1); border: 1px solid rgba(78,205,196,0.3); border-radius: 8px; padding: 15px; margin-bottom: 15px; font-size: 0.85em; }
    .instructions h4 { color: #4ecdc4; margin-bottom: 8px; }
    .instructions code { background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 Contact Discovery</h1>
    <p class="subtitle">Find emails, phones, and company intel for AU/NZ business contacts</p>
    
    <div class="tabs">
      <div class="tab active" data-tab="discover">👤 Discover</div>
      <div class="tab" data-tab="prospect">🎯 Prospect</div>
      <div class="tab new" data-tab="colleagues">👥 Colleagues</div>
      <div class="tab" data-tab="company">🏢 Company</div>
      <div class="tab" data-tab="abn">🔢 ABN</div>
      <div class="tab" data-tab="hiring">💼 Hiring</div>
      <div class="tab" data-tab="tech">🔧 Tech Stack</div>
      <div class="tab" data-tab="lookalike">🔄 Lookalikes</div>
      <div class="tab" data-tab="dashboard">📊 Dashboard</div>
      <div class="tab" data-tab="linkedin">🔗 LinkedIn</div>
      <div class="tab" data-tab="bulk">📋 Bulk</div>
      <div class="tab new" data-tab="watchlist">👁️ Watchlist</div>
    
    <!-- Discover Panel -->
    <div class="panel active" id="panel-discover">
      <div class="form-row">
        <div class="form-group"><label>First Name *</label><input type="text" id="d-firstName" placeholder="Tom"></div>
        <div class="form-group"><label>Last Name *</label><input type="text" id="d-lastName" placeholder="Cowan"></div>
        <div class="form-group"><label>Company</label><input type="text" id="d-company" placeholder="TDM Growth Partners"></div>
        <div class="form-group"><label>Domain</label><input type="text" id="d-domain" placeholder="tdmgrowthpartners.com"></div>
      </div>
      <button class="btn" onclick="discover()">🔍 Discover</button>
      <div class="loading" id="d-loading"><div class="spinner"></div>Searching...</div>
      <div class="error" id="d-error"></div>
      <div class="results" id="d-results"></div>
    </div>
    
    <!-- Prospect Panel -->
    <div class="panel" id="panel-prospect">
      <div class="form-row">
        <div class="form-group"><label>Job Titles</label><input type="text" id="p-titles" placeholder="CEO, CFO, Director"></div>
        <div class="form-group"><label>Locations</label><input type="text" id="p-locations" placeholder="Sydney, Melbourne"></div>
        <div class="form-group"><label>Seniority</label>
          <select id="p-seniority"><option value="">Any</option><option value="c_suite">C-Suite</option><option value="vp">VP</option><option value="director">Director</option><option value="manager">Manager</option></select>
        </div>
        <div class="form-group"><label>Limit</label><input type="number" id="p-limit" value="10" min="1" max="25"></div>
      </div>
      <button class="btn" onclick="prospect()">🎯 Find Prospects (FREE)</button>
      <div class="loading" id="p-loading"><div class="spinner"></div>Searching...</div>
      <div class="error" id="p-error"></div>
      <div class="results" id="p-results"></div>
    </div>
    
    <!-- Colleagues Panel (NEW) -->
    <div class="panel" id="panel-colleagues">
      <div class="instructions">
        <h4>👥 Find Colleagues at a Company</h4>
        <p>Search for specific roles (CEO, CFO, etc.) at any company. Uses Apollo's FREE People Search - no credits consumed!</p>
      </div>
      
      <div class="form-row">
        <div class="form-group" style="flex:2"><label>Company Domain *</label><input type="text" id="col-domain" placeholder="atlassian.com or Atlassian"></div>
        <div class="form-group"><label>Limit</label><input type="number" id="col-limit" value="10" min="1" max="25"></div>
      </div>
      
      <div class="form-group" style="margin-bottom:15px">
        <label>Quick Roles (click to add)</label>
        <div class="quick-roles">
          <span class="quick-role" data-role="CEO">CEO</span>
          <span class="quick-role" data-role="CFO">CFO</span>
          <span class="quick-role" data-role="CTO">CTO</span>
          <span class="quick-role" data-role="COO">COO</span>
          <span class="quick-role" data-role="CMO">CMO</span>
          <span class="quick-role" data-role="VP">VP</span>
          <span class="quick-role" data-role="Director">Director</span>
          <span class="quick-role" data-role="Managing Director">MD</span>
          <span class="quick-role" data-role="Head of Sales">Sales</span>
          <span class="quick-role" data-role="Head of Marketing">Marketing</span>
          <span class="quick-role" data-role="Head of Engineering">Engineering</span>
          <span class="quick-role" data-role="Head of Finance">Finance</span>
        </div>
      </div>
      
      <div class="form-row">
        <div class="form-group" style="flex:2"><label>Roles/Titles (comma-separated)</label><input type="text" id="col-roles" placeholder="CFO, Chief Financial Officer, Finance Director"></div>
        <div class="form-group"><label>Seniority</label>
          <select id="col-seniority"><option value="">Any</option><option value="c-suite">C-Suite</option><option value="vp">VP</option><option value="director">Director</option><option value="manager">Manager</option></select>
        </div>
      </div>
      
      <button class="btn" onclick="findColleagues()">👥 Find Colleagues (FREE)</button>
      <div class="loading" id="col-loading"><div class="spinner"></div>Searching company...</div>
      <div class="error" id="col-error"></div>
      <div class="results" id="col-results"></div>
    </div>
    
    <!-- Company Panel -->
    <div class="panel" id="panel-company">
      <div class="form-row">
        <div class="form-group" style="flex:1"><label>Company Domain or Name *</label><input type="text" id="c-domain" placeholder="atlassian.com"></div>
      </div>
      <button class="btn" onclick="companyIntel()">🏢 Get Intel</button>
      <div class="loading" id="c-loading"><div class="spinner"></div>Gathering intel...</div>
      <div class="error" id="c-error"></div>
      <div class="results" id="c-results"></div>
    </div>
    
    <!-- LinkedIn Panel -->
    
    <!-- ABN Panel -->
    <div class="panel" id="panel-abn">
      <div class="instructions">
        <h4>🔢 Australian Business Number Lookup</h4>
        <p>Search by ABN number or company name. Validates against the Australian Business Register (ABR).</p>
      </div>
      
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>ABN Number or Company Name *</label>
          <input type="text" id="abn-query" placeholder="53 102 443 916 or Atlassian">
        </div>
        <div class="form-group" style="flex:0">
          <label>&nbsp;</label>
          <button class="btn" onclick="lookupABN()">🔍 Search</button>
        </div>
      </div>
      
      <div class="loading" id="abn-loading"><div class="spinner"></div>Searching ABR...</div>
      <div class="error" id="abn-error"></div>
      <div class="results" id="abn-results"></div>
    </div>
    
    
    <!-- Hiring Panel -->
    <div class="panel" id="panel-hiring">
      <div class="instructions">
        <h4>💼 Hiring Signals</h4>
        <p>See which companies are actively hiring. High hiring activity often indicates growth, budget, and openness to partnerships.</p>
      </div>
      
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>Company Name or Domain *</label>
          <input type="text" id="hiring-company" placeholder="Canva or canva.com">
        </div>
        <div class="form-group" style="flex:0">
          <label>&nbsp;</label>
          <button class="btn" onclick="getHiring()">💼 Check Hiring</button>
        </div>
      </div>
      
      <div class="loading" id="hiring-loading"><div class="spinner"></div>Checking job boards...</div>
      <div class="error" id="hiring-error"></div>
      <div class="results" id="hiring-results"></div>
    </div>
    
    
    <!-- Tech Stack Panel -->
    <div class="panel" id="panel-tech">
      <div class="instructions">
        <h4>🔧 Tech Stack Lookup</h4>
        <p>See what technologies a company uses, or find companies using specific software.</p>
      </div>
      
      <div style="display:flex;gap:20px;margin-bottom:20px">
        <button class="btn btn-sm" onclick="showTechMode('lookup')" id="tech-mode-lookup" style="opacity:1">Company Lookup</button>
        <button class="btn btn-sm btn-secondary" onclick="showTechMode('search')" id="tech-mode-search">Find by Tech</button>
      </div>
      
      <!-- Lookup Mode -->
      <div id="tech-lookup-form">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Company Name or Domain *</label>
            <input type="text" id="tech-company" placeholder="atlassian.com">
          </div>
          <div class="form-group" style="flex:0">
            <label>&nbsp;</label>
            <button class="btn" onclick="getTechStack()">🔧 Get Tech Stack</button>
          </div>
        </div>
      </div>
      
      <!-- Search Mode -->
      <div id="tech-search-form" style="display:none">
        <div class="form-row">
          <div class="form-group">
            <label>Technology *</label>
            <input type="text" id="tech-name" placeholder="Salesforce, HubSpot, React...">
          </div>
          <div class="form-group">
            <label>Location (optional)</label>
            <input type="text" id="tech-location" placeholder="Sydney, Australia">
          </div>
          <div class="form-group" style="flex:0">
            <label>&nbsp;</label>
            <button class="btn" onclick="searchByTech()">🔍 Find Companies</button>
          </div>
        </div>
        <div class="quick-roles" style="margin-top:10px">
          <span class="quick-role" onclick="setTech('Salesforce')">Salesforce</span>
          <span class="quick-role" onclick="setTech('HubSpot')">HubSpot</span>
          <span class="quick-role" onclick="setTech('AWS')">AWS</span>
          <span class="quick-role" onclick="setTech('Google Cloud')">GCP</span>
          <span class="quick-role" onclick="setTech('Microsoft Azure')">Azure</span>
          <span class="quick-role" onclick="setTech('Slack')">Slack</span>
          <span class="quick-role" onclick="setTech('Jira')">Jira</span>
          <span class="quick-role" onclick="setTech('React')">React</span>
        </div>
      </div>
      
      <div class="loading" id="tech-loading"><div class="spinner"></div>Loading tech data...</div>
      <div class="error" id="tech-error"></div>
      <div class="results" id="tech-results"></div>
    </div>
    
    
    <!-- Lookalike Panel -->
    <div class="panel" id="panel-lookalike">
      <div class="instructions">
        <h4>🔄 Find Lookalike Companies</h4>
        <p>Enter a company you like, and we'll find similar companies based on industry, size, and other characteristics.</p>
      </div>
      
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>Seed Company *</label>
          <input type="text" id="look-seed" placeholder="atlassian.com or Atlassian">
        </div>
        <div class="form-group">
          <label>Location (optional)</label>
          <input type="text" id="look-location" placeholder="Sydney, Australia">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Min Employees</label>
          <input type="number" id="look-min-emp" placeholder="100">
        </div>
        <div class="form-group">
          <label>Max Employees</label>
          <input type="number" id="look-max-emp" placeholder="5000">
        </div>
        <div class="form-group">
          <label>Results</label>
          <input type="number" id="look-limit" value="10" min="1" max="25">
        </div>
        <div class="form-group" style="flex:0">
          <label>&nbsp;</label>
          <button class="btn" onclick="findLookalikes()">🔄 Find Similar</button>
        </div>
      </div>
      
      <div class="loading" id="look-loading"><div class="spinner"></div>Finding similar companies...</div>
      <div class="error" id="look-error"></div>
      <div class="results" id="look-results"></div>
    </div>
    
    <div class="panel" id="panel-linkedin">
      <div class="form-row">
        <div class="form-group" style="flex:1"><label>LinkedIn URL *</label><input type="text" id="l-url" placeholder="https://linkedin.com/in/..."></div>
      </div>
      <button class="btn" onclick="linkedinLookup()">🔗 Enrich</button>
      <div class="loading" id="l-loading"><div class="spinner"></div>Enriching...</div>
      <div class="error" id="l-error"></div>
      <div class="results" id="l-results"></div>
    </div>
    
    <!-- Bulk Panel -->
    
    <!-- Dashboard Panel -->
    <div class="panel" id="panel-dashboard">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="color:#4ecdc4">📊 Usage Dashboard</h3>
        <button class="btn btn-sm btn-secondary" onclick="loadDashboard()">🔄 Refresh</button>
      </div>
      
      <div id="dashboard-content">
        <p style="color:#8892b0;text-align:center;padding:30px">Loading stats...</p>
      </div>
    </div>
    
    <div class="panel" id="panel-bulk">
      <div class="step-indicator"><div class="step-dot active" id="dot-1"></div><div class="step-dot" id="dot-2"></div><div class="step-dot" id="dot-3"></div><div class="step-dot" id="dot-4"></div></div>
      <div class="step active" id="step-1">
        <div class="instructions"><h4>📋 CSV Requirements</h4><p><strong>Required:</strong> <code>firstName</code>, <code>lastName</code> | <strong>Recommended:</strong> <code>company</code>, <code>domain</code>, <code>linkedin</code> | Max 100 rows</p></div>
        <div class="upload-zone" id="upload-zone"><input type="file" id="csv-file" accept=".csv"><h3>📁 Drop CSV or click to browse</h3></div>
        <div class="file-info" id="file-info" style="display:none"><strong id="file-name"></strong> - <span id="row-count"></span> contacts</div>
        <button class="btn" id="btn-validate" onclick="validateCSV()" style="display:none">Next →</button>
      </div>
      <div class="step" id="step-2">
        <h3>✅ Compliance Check</h3>
        <div class="warning">Ensure you have lawful basis for processing (legitimate interest, consent, etc.)</div>
        <div id="compliance-summary"></div>
        <div id="compliance-report"></div>
        <div style="margin-top:15px;display:flex;gap:10px"><button class="btn btn-secondary" onclick="goToStep(1)">← Back</button><button class="btn" onclick="startEnrichment()">Confirm & Enrich →</button></div>
      </div>
      <div class="step" id="step-3">
        <h3>⚙️ Enriching...</h3>
        <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
        <p style="text-align:center;color:#8892b0"><span id="progress-text">0</span> / <span id="progress-total">0</span></p>
      </div>
      <div class="step" id="step-4">
        <h3>✅ Complete!</h3>
        <div class="result-grid" id="bulk-summary"></div>
        <div class="warning">📞 Australian numbers require DNC verification before calling</div>
        <div style="display:flex;gap:10px"><button class="btn" onclick="downloadResults()">⬇️ Download CSV</button><button class="btn btn-secondary" onclick="resetBulk()">🔄 New Upload</button></div>
        <div id="bulk-results" style="margin-top:15px"></div>
      </div>
    </div>
    </div>
    
    <!-- Watchlist Panel (NEW) -->
    <div class="panel" id="panel-watchlist">
      <div class="instructions">
        <h4>👁️ Job Change Alerts</h4>
        <p>Track contacts and get notified when they change roles or companies. Add contacts from other tabs or manually below.</p>
      </div>
      
      <div class="form-row">
        <div class="form-group"><label>First Name</label><input type="text" id="w-firstName" placeholder="Tom"></div>
        <div class="form-group"><label>Last Name</label><input type="text" id="w-lastName" placeholder="Cowan"></div>
        <div class="form-group"><label>Company</label><input type="text" id="w-company" placeholder="TDM Growth Partners"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Title</label><input type="text" id="w-title" placeholder="Managing Director"></div>
        <div class="form-group" style="flex:2"><label>LinkedIn URL</label><input type="text" id="w-linkedin" placeholder="https://linkedin.com/in/..."></div>
      </div>
      <button class="btn" onclick="addToWatchlist()">➕ Add to Watchlist</button>
      
      <div style="margin-top:25px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
          <h3 style="color:#4ecdc4">📋 Watched Contacts</h3>
          <div style="display:flex;gap:10px">
            <button class="btn btn-sm btn-secondary" onclick="loadWatchlist()">🔄 Refresh</button>
            <button class="btn btn-sm" onclick="checkWatchlist()">🔍 Check for Changes</button>
          </div>
        </div>
        
        <div class="loading" id="w-loading"><div class="spinner"></div>Checking contacts...</div>
        <div class="error" id="w-error"></div>
        <div id="w-changes" style="margin-bottom:15px"></div>
        <div id="w-list"></div>
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
    
    // Quick role buttons
    document.querySelectorAll('.quick-role').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        updateRolesInput();
      });
    });
    
    function updateRolesInput() {
      const active = [...document.querySelectorAll('.quick-role.active')].map(b => b.dataset.role);
      document.getElementById('col-roles').value = active.join(', ');
    }
    
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function copyVal(text) { navigator.clipboard.writeText(text); }
    function showLoading(id, show) { document.getElementById(id).classList.toggle('show', show); }
    function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.add('show'); }
    function hideError(id) { document.getElementById(id).classList.remove('show'); }
    
    // CRM Export functions
    let lastResultData = null;
    let lastResultType = null;
    
    function storeForExport(data, type) {
      lastResultData = data;
      lastResultType = type;
    }
    
    function exportToCRM(format) {
      if (!lastResultData) {
        alert('No data to export. Run a search first.');
        return;
      }
      
      const endpoint = format === 'hubspot' ? '/api/export/hubspot' : '/api/export/salesforce';
      
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: lastResultData, type: lastResultType })
      })
      .then(resp => resp.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = format === 'hubspot' ? 'hubspot_import.csv' : 'salesforce_leads.csv';
        a.click();
      });
    }
    
    function renderExportButtons() {
      return '<div style="margin-top:15px;padding-top:15px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:10px;flex-wrap:wrap">' +
        '<span style="color:#8892b0;font-size:0.85em;padding:8px 0">Export to CRM:</span>' +
        '<button class="btn btn-sm btn-secondary" onclick="exportToCRM(\\'hubspot\\')">📤 HubSpot</button>' +
        '<button class="btn btn-sm btn-secondary" onclick="exportToCRM(\\'salesforce\\')">📤 Salesforce</button>' +
        '</div>';
    }

    
    // ============ DISCOVER ============
    async function discover() {
      const firstName = document.getElementById('d-firstName').value.trim();
      const lastName = document.getElementById('d-lastName').value.trim();
      if (!firstName || !lastName) { showError('d-error', 'Name required'); return; }
      showLoading('d-loading', true); hideError('d-error'); document.getElementById('d-results').innerHTML = '';
      try {
        const params = new URLSearchParams({ firstName, lastName, company: document.getElementById('d-company').value, domain: document.getElementById('d-domain').value });
        const resp = await fetch('/api/discover?' + params);
        const d = await resp.json();
        let h = '<div class="result-card"><h3>👤 ' + esc(d.firstName + ' ' + d.lastName) + '</h3>';
        if (d.linkedin) h += '<p><a href="' + esc(d.linkedin) + '" target="_blank">LinkedIn →</a></p>';
        h += '<h4 style="margin:15px 0 8px;color:#8892b0;font-size:0.9em">📧 EMAILS</h4>';
        if (d.emails?.length) d.emails.forEach(e => { h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><span class="badge badge-source">' + esc(e.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a;font-size:0.9em">None found</p>';
        h += '<h4 style="margin:15px 0 8px;color:#8892b0;font-size:0.9em">📱 PHONES</h4>';
        if (d.phones?.length) d.phones.forEach(p => { h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><span class="badge badge-source">' + esc(p.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a;font-size:0.9em">None found</p>';
        h += '<div class="duration">' + d.duration + 'ms</div></div>';
        document.getElementById('d-results').innerHTML = h;
      } catch (e) { showError('d-error', e.message); }
      finally { showLoading('d-loading', false); }
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
        const d = await resp.json();
        let h = '<div class="result-card"><h3>🎯 ' + d.total + ' prospects found</h3><div class="result-grid">';
        d.prospects?.forEach(p => { h += '<div class="result-item"><div class="label">' + esc(p.title) + '</div><div class="value">' + esc(p.name) + '</div><div style="color:#8892b0;font-size:0.8em">' + esc(p.company) + '</div></div>'; });
        h += '</div>' + renderExportButtons() + '<div class="duration">' + d.duration + 'ms</div></div>';
        storeForExport(d, 'prospects');
        document.getElementById('p-results').innerHTML = h;
      } catch (e) { showError('p-error', e.message); }
      finally { showLoading('p-loading', false); }
    }
    
    // ============ COLLEAGUES (NEW) ============
    let colleagueData = [];
    
    async function findColleagues() {
      const domain = document.getElementById('col-domain').value.trim();
      if (!domain) { showError('col-error', 'Company domain required'); return; }
      
      const roles = document.getElementById('col-roles').value.split(',').map(s => s.trim()).filter(Boolean);
      const seniority = document.getElementById('col-seniority').value;
      const limit = parseInt(document.getElementById('col-limit').value) || 10;
      
      showLoading('col-loading', true); hideError('col-error'); document.getElementById('col-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/colleagues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, roles, seniority, limit })
        });
        const d = await resp.json();
        colleagueData = d.colleagues || [];
        
        let h = '<div class="result-card">';
        h += '<h3>👥 ' + (d.company?.name || domain) + '</h3>';
        if (d.company) {
          h += '<p style="color:#8892b0;margin-bottom:15px">';
          if (d.company.employees) h += d.company.employees + ' AU employees';
          if (d.company.domain) h += ' • ' + d.company.domain;
          h += '</p>';
        }
        h += '<p style="margin-bottom:15px">Found <strong>' + d.total + '</strong> colleagues' + (roles.length ? ' matching: ' + roles.join(', ') : '') + '</p>';
        
        if (d.colleagues?.length) {
          h += '<div class="result-grid">';
          d.colleagues.forEach((c, idx) => {
            h += '<div class="colleague-card" id="colleague-' + idx + '">';
            h += '<div class="colleague-name">' + esc(c.name) + '</div>';
            h += '<div class="colleague-title">' + esc(c.title || 'Unknown role') + '</div>';
            h += '<div class="colleague-meta">';
            if (c.location) h += '<span>📍 ' + esc(c.location) + '</span>';
            if (c.seniority) h += '<span>🏷️ ' + esc(c.seniority) + '</span>';
            h += '</div>';
            h += '<div class="colleague-actions">';
            if (c.linkedin) h += '<a href="' + esc(c.linkedin) + '" target="_blank" class="btn btn-sm btn-secondary">LinkedIn →</a>';
            h += '<button class="btn btn-sm" onclick="enrichColleague(' + idx + ')">📧 Get Contact</button>';
            h += '</div>';
            h += '<div class="colleague-enriched" id="enriched-' + idx + '" style="display:none"></div>';
            h += '</div>';
          });
          h += '</div>';
        } else {
          h += '<p style="color:#5a6a8a">No colleagues found. Try different roles or remove filters.</p>';
        }
        
        h += renderExportButtons();
        h += '<div class="duration">' + d.duration + 'ms | FREE - no credits used</div></div>';
        storeForExport(d, 'colleagues');
        document.getElementById('col-results').innerHTML = h;
      } catch (e) { showError('col-error', e.message); }
      finally { showLoading('col-loading', false); }
    }
    
    async function enrichColleague(idx) {
      const colleague = colleagueData[idx];
      if (!colleague) return;
      
      const enrichedDiv = document.getElementById('enriched-' + idx);
      enrichedDiv.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:10px auto"></div>';
      enrichedDiv.style.display = 'block';
      
      try {
        const resp = await fetch('/api/colleagues/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(colleague)
        });
        const d = await resp.json();
        
        let h = '';
        if (d.emails?.length) {
          d.emails.forEach(e => {
            h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span>';
            h += '<span class="badge badge-source">' + esc(e.source) + '</span>';
            if (e.verified) h += '<span class="badge badge-verified">✓</span>';
            h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(e.email) + '\\')">Copy</button></div>';
          });
        }
        if (d.phones?.length) {
          d.phones.forEach(p => {
            h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span>';
            h += '<span class="badge badge-source">' + esc(p.source) + '</span>';
            h += '<button class="copy-btn" onclick="copyVal(\\'' + esc(p.number) + '\\')">Copy</button></div>';
          });
        }
        if (!d.emails?.length && !d.phones?.length) {
          h = '<p style="color:#5a6a8a;font-size:0.85em">No contact info found</p>';
        }
        enrichedDiv.innerHTML = h;
        
        // Update the stored data
        colleagueData[idx] = d;
      } catch (e) {
        enrichedDiv.innerHTML = '<p style="color:#dc3545;font-size:0.85em">Error: ' + e.message + '</p>';
      }
    }
    
    // ============ COMPANY ============
    async function companyIntel() {
      const domain = document.getElementById('c-domain').value.trim();
      if (!domain) { showError('c-error', 'Domain required'); return; }
      showLoading('c-loading', true); hideError('c-error'); document.getElementById('c-results').innerHTML = '';
      try {
        const resp = await fetch('/api/company?domain=' + encodeURIComponent(domain));
        const d = await resp.json();
        const c = d.company;
        let h = '<div class="result-card"><h3>🏢 ' + esc(c?.name || 'Not found') + '</h3>';
        if (c) {
          h += '<div class="result-grid">';
          if (c.domain) h += '<div class="result-item"><div class="label">Domain</div><div class="value">' + esc(c.domain) + '</div></div>';
          if (c.employees?.au) h += '<div class="result-item"><div class="label">AU Employees</div><div class="value">' + c.employees.au + '</div></div>';
          if (c.employees?.global) h += '<div class="result-item"><div class="label">Global</div><div class="value">' + c.employees.global + '</div></div>';
          if (c.abn) h += '<div class="result-item"><div class="label">ABN</div><div class="value">' + esc(c.abn) + '</div></div>';
          h += '</div>';
          if (c.description) h += '<p style="margin-top:15px;color:#8892b0;font-size:0.9em">' + esc(c.description.substring(0,250)) + '</p>';
        }
        h += '<div class="duration">' + d.duration + 'ms</div></div>';
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
        const d = await resp.json();
        let h = '<div class="result-card"><h3>🔗 ' + esc((d.person?.firstName||'') + ' ' + (d.person?.lastName||'')) + '</h3>';
        if (d.person?.title) h += '<p style="color:#8892b0">' + esc(d.person.title) + '</p>';
        h += '<h4 style="margin:15px 0 8px;color:#8892b0;font-size:0.9em">📧 EMAILS</h4>';
        if (d.emails?.length) d.emails.forEach(e => { h += '<div class="contact-row"><span class="contact-value">' + esc(e.email) + '</span><span class="badge badge-source">' + esc(e.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a;font-size:0.9em">None found</p>';
        h += '<h4 style="margin:15px 0 8px;color:#8892b0;font-size:0.9em">📱 PHONES</h4>';
        if (d.phones?.length) d.phones.forEach(p => { h += '<div class="contact-row"><span class="contact-value">' + esc(p.number) + '</span><span class="badge badge-source">' + esc(p.source) + '</span></div>'; });
        else h += '<p style="color:#5a6a8a;font-size:0.9em">None found</p>';
        h += '<div class="duration">' + d.duration + 'ms</div></div>';
        document.getElementById('l-results').innerHTML = h;
      } catch (e) { showError('l-error', e.message); }
      finally { showLoading('l-loading', false); }
    }
    
    // ============ BULK ============
    let bulkData = { csv: null, contacts: [], enriched: [] };
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('csv-file');
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', e => { e.preventDefault(); });
    uploadZone.addEventListener('drop', e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
    
    function handleFile(file) {
      if (!file?.name.endsWith('.csv')) { alert('CSV required'); return; }
      const reader = new FileReader();
      reader.onload = e => {
        bulkData.csv = e.target.result;
        document.getElementById('file-name').textContent = file.name;
        document.getElementById('row-count').textContent = bulkData.csv.trim().split('\\n').length - 1;
        document.getElementById('file-info').style.display = 'block';
        document.getElementById('btn-validate').style.display = 'inline-block';
      };
      reader.readAsText(file);
    }
    
    async function validateCSV() {
      const resp = await fetch('/api/bulk/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: bulkData.csv }) });
      const d = await resp.json();
      if (d.error) { alert(d.error); return; }
      bulkData.contacts = d.validContacts;
      document.getElementById('compliance-summary').innerHTML = '<div class="result-grid"><div class="result-item"><div class="label">Valid</div><div class="value" style="color:#28a745">' + d.validContacts.length + '</div></div><div class="result-item"><div class="label">Issues</div><div class="value" style="color:' + (d.issues.length ? '#dc3545' : '#28a745') + '">' + d.issues.length + '</div></div></div>';
      let issues = '';
      d.issues.forEach(i => { issues += '<div class="compliance-item">Row ' + i.row + ': ' + esc(i.contact) + ' - ' + i.issues.join(', ') + '</div>'; });
      document.getElementById('compliance-report').innerHTML = issues;
      goToStep(2);
    }
    
    async function startEnrichment() {
      goToStep(3);
      document.getElementById('progress-total').textContent = bulkData.contacts.length;
      const resp = await fetch('/api/bulk/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contacts: bulkData.contacts }) });
      const d = await resp.json();
      bulkData.enriched = d.results;
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('progress-text').textContent = bulkData.contacts.length;
      const emails = d.results.filter(r => r.emails?.length).length;
      const phones = d.results.filter(r => r.phones?.length).length;
      document.getElementById('bulk-summary').innerHTML = '<div class="result-item"><div class="label">Enriched</div><div class="value">' + d.results.length + '</div></div><div class="result-item"><div class="label">Emails</div><div class="value" style="color:#28a745">' + emails + '</div></div><div class="result-item"><div class="label">Phones</div><div class="value" style="color:#4ecdc4">' + phones + '</div></div>';
      let table = '<table><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th></tr>';
      d.results.slice(0,10).forEach(r => { table += '<tr><td>' + esc(r.firstName + ' ' + r.lastName) + '</td><td>' + esc(r.company) + '</td><td>' + esc(r.emails?.[0]?.email||'-') + '</td><td>' + esc(r.phones?.[0]?.number||'-') + '</td></tr>'; });
      table += '</table>';
      document.getElementById('bulk-results').innerHTML = table;
      goToStep(4);
    }
    
    function downloadResults() {
      fetch('/api/bulk/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results: bulkData.enriched }) })
        .then(r => r.blob()).then(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'enriched_' + Date.now() + '.csv'; a.click(); });
    }
    
    function resetBulk() { bulkData = { csv: null, contacts: [], enriched: [] }; document.getElementById('file-info').style.display = 'none'; document.getElementById('btn-validate').style.display = 'none'; fileInput.value = ''; goToStep(1); }
    function goToStep(n) { document.querySelectorAll('.step').forEach(s => s.classList.remove('active')); document.getElementById('step-' + n).classList.add('active'); for (let i = 1; i <= 4; i++) { const d = document.getElementById('dot-' + i); d.classList.remove('active', 'completed'); if (i < n) d.classList.add('completed'); if (i === n) d.classList.add('active'); } }
    
    
    // ============ ABN LOOKUP ============
    async function lookupABN() {
      const query = document.getElementById('abn-query').value.trim();
      if (!query) { showError('abn-error', 'Enter ABN or company name'); return; }
      
      showLoading('abn-loading', true);
      hideError('abn-error');
      document.getElementById('abn-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/abn?q=' + encodeURIComponent(query));
        const data = await resp.json();
        
        if (data.error) throw new Error(data.error);
        
        let h = '<div class="result-card">';
        h += '<h3>🔢 ABN Results for "' + esc(query) + '"</h3>';
        
        if (data.matches?.length) {
          h += '<div class="result-grid">';
          data.matches.forEach(m => {
            h += '<div class="colleague-card">';
            h += '<div style="font-family:monospace;font-size:1.2em;color:#4ecdc4;margin-bottom:8px">' + esc(m.abn) + '</div>';
            h += '<div class="colleague-name">' + esc(m.entityName || 'Unknown Entity') + '</div>';
            h += '<div class="colleague-meta" style="margin:8px 0">';
            h += '<span class="badge ' + (m.status === 'Active' ? 'badge-verified' : 'badge-source') + '">' + esc(m.status) + '</span>';
            if (m.entityType) h += '<span class="badge badge-source">' + esc(m.entityType) + '</span>';
            h += '</div>';
            if (m.statusDate) h += '<div style="color:#8892b0;font-size:0.85em">Since: ' + esc(m.statusDate) + '</div>';
            h += '<div style="margin-top:10px;display:flex;gap:8px">';
            h += '<button class="btn btn-sm" onclick="copyVal(\\'' + m.abnRaw + '\\')">Copy ABN</button>';
            h += '<a href="' + esc(m.url) + '" target="_blank" class="btn btn-sm btn-secondary">View on ABR →</a>';
            h += '</div>';
            h += '</div>';
          });
          h += '</div>';
        } else {
          h += '<p style="color:#5a6a8a;text-align:center;padding:20px">No ABN records found. Try a different search term.</p>';
        }
        
        h += '<div class="duration">' + data.duration + 'ms</div>';
        h += '</div>';
        
        document.getElementById('abn-results').innerHTML = h;
      } catch (e) { showError('abn-error', e.message); }
      finally { showLoading('abn-loading', false); }
    }
    
    // Allow Enter key to search
    document.getElementById('abn-query')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') lookupABN();
    });

    
    // ============ HIRING SIGNALS ============
    async function getHiring() {
      const company = document.getElementById('hiring-company').value.trim();
      if (!company) { showError('hiring-error', 'Enter company name or domain'); return; }
      
      showLoading('hiring-loading', true);
      hideError('hiring-error');
      document.getElementById('hiring-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/hiring?company=' + encodeURIComponent(company));
        const data = await resp.json();
        
        if (data.error) throw new Error(data.error);
        
        let h = '<div class="result-card">';
        h += '<h3>💼 ' + esc(data.company?.name || company) + '</h3>';
        
        // Company overview
        if (data.company) {
          h += '<div class="result-grid" style="margin-bottom:20px">';
          if (data.company.employees) h += '<div class="result-item"><div class="label">Employees</div><div class="value">' + data.company.employees.toLocaleString() + '</div></div>';
          if (data.company.industry) h += '<div class="result-item"><div class="label">Industry</div><div class="value">' + esc(data.company.industry) + '</div></div>';
          if (data.company.founded) h += '<div class="result-item"><div class="label">Founded</div><div class="value">' + data.company.founded + '</div></div>';
          if (data.jobCount) h += '<div class="result-item"><div class="label">Open Jobs</div><div class="value" style="font-size:1.5em;color:#4ecdc4">' + data.jobCount + '</div></div>';
          h += '</div>';
        }
        
        // Growth indicators
        if (data.growthIndicators?.length) {
          h += '<div style="margin-bottom:20px">';
          data.growthIndicators.forEach(g => {
            const color = g.type === 'hot' ? '#ff6b6b' : g.type === 'active' ? '#ffc107' : '#4ecdc4';
            h += '<span class="badge" style="background:' + color + '20;color:' + color + ';margin-right:8px;padding:6px 12px">' + esc(g.label) + '</span>';
          });
          h += '</div>';
        }
        
        // Career pages
        if (data.careerPages?.length) {
          h += '<h4 style="color:#8892b0;margin:15px 0 10px">📍 Job Sources</h4>';
          h += '<div class="result-grid">';
          data.careerPages.forEach(p => {
            h += '<div class="result-item">';
            h += '<div class="label">' + esc(p.source) + (p.jobCount ? ' (' + p.jobCount + ' jobs)' : '') + '</div>';
            h += '<div class="value"><a href="' + esc(p.url) + '" target="_blank">' + esc(p.title || 'View Jobs') + '</a></div>';
            h += '</div>';
          });
          h += '</div>';
        }
        
        // LinkedIn link
        if (data.company?.linkedin) {
          h += '<div style="margin-top:20px"><a href="' + esc(data.company.linkedin) + '/jobs" target="_blank" class="btn btn-secondary">View all jobs on LinkedIn →</a></div>';
        }
        
        h += '<div class="duration">' + data.duration + 'ms</div>';
        h += '</div>';
        
        document.getElementById('hiring-results').innerHTML = h;
      } catch (e) { showError('hiring-error', e.message); }
      finally { showLoading('hiring-loading', false); }
    }
    
    document.getElementById('hiring-company')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') getHiring();
    });


    // ============ TECH STACK ============
    function showTechMode(mode) {
      document.getElementById('tech-lookup-form').style.display = mode === 'lookup' ? 'block' : 'none';
      document.getElementById('tech-search-form').style.display = mode === 'search' ? 'block' : 'none';
      document.getElementById('tech-mode-lookup').classList.toggle('btn-secondary', mode !== 'lookup');
      document.getElementById('tech-mode-lookup').style.opacity = mode === 'lookup' ? '1' : '0.7';
      document.getElementById('tech-mode-search').classList.toggle('btn-secondary', mode !== 'search');
      document.getElementById('tech-mode-search').style.opacity = mode === 'search' ? '1' : '0.7';
      document.getElementById('tech-results').innerHTML = '';
    }
    
    function setTech(name) {
      document.getElementById('tech-name').value = name;
    }
    
    async function getTechStack() {
      const company = document.getElementById('tech-company').value.trim();
      if (!company) { showError('tech-error', 'Enter company name or domain'); return; }
      
      showLoading('tech-loading', true);
      hideError('tech-error');
      document.getElementById('tech-results').innerHTML = '';
      
      try {
        const resp = await fetch('/api/tech?company=' + encodeURIComponent(company));
        const data = await resp.json();
        
        if (data.error) throw new Error(data.error);
        
        let h = '<div class="result-card">';
        h += '<h3>🔧 ' + esc(data.company?.name || company) + '</h3>';
        
        if (data.company) {
          h += '<p style="color:#8892b0;margin-bottom:15px">';
          if (data.company.employees) h += data.company.employees.toLocaleString() + ' employees';
          if (data.company.industry) h += ' • ' + data.company.industry;
          h += '</p>';
        }
        
        h += '<p style="margin-bottom:20px"><strong>' + data.totalCount + '</strong> technologies detected</p>';
        
        if (Object.keys(data.byCategory).length) {
          // Sort categories by count
          const sorted = Object.entries(data.byCategory).sort((a,b) => b[1].length - a[1].length);
          
          h += '<div class="result-grid">';
          sorted.slice(0, 12).forEach(([cat, techs]) => {
            h += '<div class="result-item">';
            h += '<div class="label">' + esc(cat) + ' (' + techs.length + ')</div>';
            h += '<div class="value" style="font-size:0.85em">' + techs.slice(0, 6).map(t => esc(t)).join(', ');
            if (techs.length > 6) h += '...';
            h += '</div>';
            h += '</div>';
          });
          h += '</div>';
        } else {
          h += '<p style="color:#5a6a8a">No technology data available for this company.</p>';
        }
        
        h += '<div class="duration">' + data.duration + 'ms</div>';
        h += '</div>';
        
        document.getElementById('tech-results').innerHTML = h;
      } catch (e) { showError('tech-error', e.message); }
      finally { showLoading('tech-loading', false); }
    }
    
    async function searchByTech() {
      const tech = document.getElementById('tech-name').value.trim();
      const location = document.getElementById('tech-location').value.trim();
      if (!tech) { showError('tech-error', 'Enter technology name'); return; }
      
      showLoading('tech-loading', true);
      hideError('tech-error');
      document.getElementById('tech-results').innerHTML = '';
      
      try {
        let url = '/api/tech/search?tech=' + encodeURIComponent(tech);
        if (location) url += '&location=' + encodeURIComponent(location);
        
        const resp = await fetch(url);
        const data = await resp.json();
        
        if (data.error) throw new Error(data.error);
        
        let h = '<div class="result-card">';
        h += '<h3>🔍 Companies using ' + esc(tech) + '</h3>';
        if (location) h += '<p style="color:#8892b0">Location: ' + esc(location) + '</p>';
        h += '<p style="margin:15px 0">Found <strong>' + data.companies.length + '</strong> companies</p>';
        
        if (data.companies.length) {
          h += '<div class="result-grid">';
          data.companies.forEach(c => {
            h += '<div class="colleague-card">';
            h += '<div class="colleague-name">' + esc(c.name) + '</div>';
            if (c.industry) h += '<div class="colleague-title">' + esc(c.industry) + '</div>';
            h += '<div class="colleague-meta">';
            if (c.employees) h += '<span>👥 ' + c.employees.toLocaleString() + '</span>';
            if (c.domain) h += '<span>🌐 ' + esc(c.domain) + '</span>';
            h += '</div>';
            if (c.linkedin) h += '<a href="' + esc(c.linkedin) + '" target="_blank" class="btn btn-sm btn-secondary" style="margin-top:8px">LinkedIn →</a>';
            h += '</div>';
          });
          h += '</div>';
        } else {
          h += '<p style="color:#5a6a8a">No companies found. Try a different technology or remove location filter.</p>';
        }
        
        h += '<div class="duration">' + data.duration + 'ms</div>';
        h += '</div>';
        
        document.getElementById('tech-results').innerHTML = h;
      } catch (e) { showError('tech-error', e.message); }
      finally { showLoading('tech-loading', false); }
    }
    
    document.getElementById('tech-company')?.addEventListener('keypress', e => { if (e.key === 'Enter') getTechStack(); });
    document.getElementById('tech-name')?.addEventListener('keypress', e => { if (e.key === 'Enter') searchByTech(); });


    // ============ LOOKALIKE COMPANIES ============
    async function findLookalikes() {
      const seed = document.getElementById('look-seed').value.trim();
      if (!seed) { showError('look-error', 'Enter a seed company'); return; }
      
      const location = document.getElementById('look-location').value.trim();
      const minEmp = document.getElementById('look-min-emp').value;
      const maxEmp = document.getElementById('look-max-emp').value;
      const limit = document.getElementById('look-limit').value || 10;
      
      showLoading('look-loading', true);
      hideError('look-error');
      document.getElementById('look-results').innerHTML = '';
      
      try {
        let url = '/api/lookalike?company=' + encodeURIComponent(seed) + '&limit=' + limit;
        if (location) url += '&location=' + encodeURIComponent(location);
        if (minEmp) url += '&minEmployees=' + minEmp;
        if (maxEmp) url += '&maxEmployees=' + maxEmp;
        
        const resp = await fetch(url);
        const data = await resp.json();
        
        if (data.error) throw new Error(data.error);
        
        let h = '<div class="result-card">';
        
        // Seed company info
        if (data.seed) {
          h += '<div style="background:rgba(78,205,196,0.1);padding:15px;border-radius:8px;margin-bottom:20px">';
          h += '<h4 style="color:#4ecdc4;margin-bottom:10px">📌 Seed Company</h4>';
          h += '<div class="colleague-name">' + esc(data.seed.name) + '</div>';
          h += '<div class="colleague-meta" style="margin-top:8px">';
          if (data.seed.industry) h += '<span>🏷️ ' + esc(data.seed.industry) + '</span>';
          if (data.seed.employees) h += '<span>👥 ' + data.seed.employees.toLocaleString() + '</span>';
          if (data.seed.founded) h += '<span>📅 ' + data.seed.founded + '</span>';
          h += '</div></div>';
        }
        
        h += '<h3>🔄 ' + data.lookalikes.length + ' Similar Companies</h3>';
        
        if (data.criteria) {
          h += '<p style="color:#8892b0;margin:10px 0">Matching: ' + esc(data.criteria.industry || 'any industry');
          if (data.criteria.employeeRange) h += ' • ' + data.criteria.employeeRange.replace(',', '-') + ' employees';
          h += '</p>';
        }
        
        if (data.lookalikes.length) {
          h += '<div class="result-grid">';
          data.lookalikes.forEach(c => {
            h += '<div class="colleague-card">';
            h += '<div style="display:flex;justify-content:space-between;align-items:start">';
            h += '<div class="colleague-name">' + esc(c.name) + '</div>';
            h += '<span class="badge badge-source">' + c.similarity + '% match</span>';
            h += '</div>';
            if (c.industry) h += '<div class="colleague-title">' + esc(c.industry) + '</div>';
            h += '<div class="colleague-meta" style="margin-top:8px">';
            if (c.employees) h += '<span>👥 ' + c.employees.toLocaleString() + '</span>';
            if (c.domain) h += '<span>🌐 ' + esc(c.domain) + '</span>';
            if (c.founded) h += '<span>📅 ' + c.founded + '</span>';
            h += '</div>';
            h += '<div style="margin-top:10px;display:flex;gap:8px">';
            if (c.linkedin) h += '<a href="' + esc(c.linkedin) + '" target="_blank" class="btn btn-sm btn-secondary">LinkedIn</a>';
            h += '<button class="btn btn-sm" onclick="document.getElementById(\\'col-domain\\').value=\\'' + esc(c.domain) + '\\';document.querySelector(\\'[data-tab=colleagues]\\').click();">Find People</button>';
            h += '</div>';
            h += '</div>';
          });
          h += '</div>';
        } else {
          h += '<p style="color:#5a6a8a">No similar companies found. Try adjusting filters.</p>';
        }
        
        h += renderExportButtons();
        h += '<div class="duration">' + data.duration + 'ms</div>';
        h += '</div>';
        storeForExport(data, 'lookalikes');
        document.getElementById('look-results').innerHTML = h;
      } catch (e) { showError('look-error', e.message); }
      finally { showLoading('look-loading', false); }
    }
    
    document.getElementById('look-seed')?.addEventListener('keypress', e => { if (e.key === 'Enter') findLookalikes(); });

    // ============ DASHBOARD ============
    async function loadDashboard() {
      const content = document.getElementById('dashboard-content');
      content.innerHTML = '<p style="color:#8892b0;text-align:center;padding:30px"><div class="spinner"></div>Loading...</p>';
      
      try {
        const resp = await fetch('/api/stats');
        const data = await resp.json();
        
        let h = '';
        
        // Summary cards
        h += '<div class="result-grid" style="margin-bottom:25px">';
        h += '<div class="result-item" style="text-align:center"><div class="label">Total Requests</div><div class="value" style="font-size:2em;color:#4ecdc4">' + (data.totalRequests || 0).toLocaleString() + '</div></div>';
        h += '<div class="result-item" style="text-align:center"><div class="label">Contacts Enriched</div><div class="value" style="font-size:2em;color:#28a745">' + (data.enrichmentStats?.total || 0).toLocaleString() + '</div></div>';
        h += '<div class="result-item" style="text-align:center"><div class="label">Email Success</div><div class="value" style="font-size:2em;color:#ffc107">' + (data.derived?.emailSuccessRate || 0) + '%</div></div>';
        h += '<div class="result-item" style="text-align:center"><div class="label">Uptime</div><div class="value" style="font-size:1.5em">' + (data.derived?.uptime || 'N/A') + '</div></div>';
        h += '</div>';
        
        // Enrichment breakdown
        h += '<div class="result-card" style="margin-bottom:20px">';
        h += '<h4 style="color:#8892b0;margin-bottom:15px">📧 Enrichment Success Rates</h4>';
        h += '<div class="result-grid">';
        const es = data.enrichmentStats || {};
        const total = es.total || 1;
        h += '<div class="result-item"><div class="label">With Email</div><div class="value">' + (es.withEmail || 0) + ' (' + Math.round((es.withEmail || 0) / total * 100) + '%)</div></div>';
        h += '<div class="result-item"><div class="label">With Phone</div><div class="value">' + (es.withPhone || 0) + ' (' + Math.round((es.withPhone || 0) / total * 100) + '%)</div></div>';
        h += '<div class="result-item"><div class="label">With LinkedIn</div><div class="value">' + (es.withLinkedIn || 0) + ' (' + Math.round((es.withLinkedIn || 0) / total * 100) + '%)</div></div>';
        h += '</div></div>';
        
        // Last 7 days chart (simple bar)
        if (data.derived?.last7Days?.length) {
          h += '<div class="result-card" style="margin-bottom:20px">';
          h += '<h4 style="color:#8892b0;margin-bottom:15px">📈 Last 7 Days</h4>';
          h += '<div style="display:flex;align-items:flex-end;gap:8px;height:100px">';
          const max = Math.max(...data.derived.last7Days.map(d => d.requests), 1);
          data.derived.last7Days.forEach(d => {
            const height = Math.max(5, (d.requests / max) * 80);
            const day = new Date(d.date).toLocaleDateString('en-AU', { weekday: 'short' });
            h += '<div style="flex:1;text-align:center">';
            h += '<div style="background:linear-gradient(180deg,#4ecdc4,#44a08d);height:' + height + 'px;border-radius:4px 4px 0 0;margin-bottom:4px"></div>';
            h += '<div style="font-size:0.7em;color:#8892b0">' + day + '</div>';
            h += '<div style="font-size:0.75em">' + d.requests + '</div>';
            h += '</div>';
          });
          h += '</div></div>';
        }
        
        // Top endpoints
        if (data.derived?.topEndpoints?.length) {
          h += '<div class="result-card" style="margin-bottom:20px">';
          h += '<h4 style="color:#8892b0;margin-bottom:15px">🔝 Top Endpoints</h4>';
          data.derived.topEndpoints.slice(0, 8).forEach(e => {
            const pct = Math.round((e.count / data.totalRequests) * 100);
            h += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">';
            h += '<span style="font-family:monospace;font-size:0.85em">' + esc(e.endpoint) + '</span>';
            h += '<span>' + e.count + ' <span style="color:#8892b0">(' + pct + '%)</span></span>';
            h += '</div>';
          });
          h += '</div>';
        }
        
        // API health
        h += '<div class="result-card">';
        h += '<h4 style="color:#8892b0;margin-bottom:15px">🔌 API Health</h4>';
        h += '<div class="result-grid">';
        Object.entries(data.apiCalls || {}).forEach(([api, info]) => {
          const errorRate = info.calls > 0 ? Math.round((info.errors / info.calls) * 100) : 0;
          const color = errorRate > 20 ? '#dc3545' : errorRate > 5 ? '#ffc107' : '#28a745';
          h += '<div class="result-item">';
          h += '<div class="label">' + api.toUpperCase() + '</div>';
          h += '<div class="value">' + info.calls + ' calls <span style="color:' + color + '">(' + errorRate + '% errors)</span></div>';
          h += '</div>';
        });
        h += '</div></div>';
        
        // Footer
        h += '<p style="text-align:center;color:#5a6a8a;margin-top:20px;font-size:0.8em">';
        h += 'Started: ' + new Date(data.startedAt).toLocaleString() + ' | Last updated: ' + new Date(data.lastUpdated).toLocaleString();
        h += '</p>';
        
        content.innerHTML = h;
      } catch (e) {
        content.innerHTML = '<p style="color:#dc3545;text-align:center;padding:30px">Error loading stats: ' + e.message + '</p>';
      }
    }
    
    // Load dashboard when tab is clicked
    document.querySelector('[data-tab="dashboard"]')?.addEventListener('click', loadDashboard);


    // ============ WATCHLIST ============
    async function loadWatchlist() {
      try {
        const resp = await fetch('/api/watchlist');
        const data = await resp.json();
        renderWatchlist(data);
      } catch (e) { showError('w-error', e.message); }
    }
    
    function renderWatchlist(data) {
      const list = document.getElementById('w-list');
      if (!data.contacts?.length) {
        list.innerHTML = '<p style="color:#5a6a8a;text-align:center;padding:30px">No contacts in watchlist. Add contacts to track job changes.</p>';
        return;
      }
      
      let h = '<div class="result-grid">';
      data.contacts.forEach(c => {
        const hasChanges = c.changeHistory?.length > 0;
        h += '<div class="colleague-card' + (hasChanges ? ' style="border-color:#ffc107"' : '') + '">';
        h += '<div class="colleague-name">' + esc(c.firstName + ' ' + c.lastName) + '</div>';
        h += '<div class="colleague-title">' + esc(c.lastTitle || 'Unknown') + '</div>';
        h += '<div style="color:#5a6a8a;font-size:0.8em">' + esc(c.lastCompany || 'Unknown company') + '</div>';
        if (hasChanges) {
          const lastChange = c.changeHistory[c.changeHistory.length - 1];
          h += '<div style="margin-top:8px;padding:8px;background:rgba(255,193,7,0.1);border-radius:4px;font-size:0.8em">';
          h += '🔔 <strong>Changed:</strong> ';
          lastChange.changes.forEach(ch => {
            h += ch.type + ': ' + esc(ch.from) + ' → ' + esc(ch.to) + ' ';
          });
          h += '</div>';
        }
        h += '<div class="colleague-meta" style="margin-top:8px">';
        if (c.linkedin) h += '<a href="' + esc(c.linkedin) + '" target="_blank" style="color:#4ecdc4;font-size:0.8em">LinkedIn →</a>';
        if (c.lastChecked) h += '<span style="font-size:0.75em">Checked: ' + new Date(c.lastChecked).toLocaleDateString() + '</span>';
        h += '</div>';
        h += '<button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="removeFromWatchlist(\\''+c.id+'\\')">Remove</button>';
        h += '</div>';
      });
      h += '</div>';
      h += '<p style="text-align:center;color:#5a6a8a;margin-top:15px;font-size:0.85em">' + data.total + ' contacts tracked' + (data.lastChecked ? ' • Last checked: ' + new Date(data.lastChecked).toLocaleString() : '') + '</p>';
      list.innerHTML = h;
    }
    
    async function addToWatchlist() {
      const contact = {
        firstName: document.getElementById('w-firstName').value.trim(),
        lastName: document.getElementById('w-lastName').value.trim(),
        company: document.getElementById('w-company').value.trim(),
        title: document.getElementById('w-title').value.trim(),
        linkedin: document.getElementById('w-linkedin').value.trim(),
      };
      
      if (!contact.firstName || !contact.lastName) {
        showError('w-error', 'First and last name required');
        return;
      }
      
      try {
        const resp = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(contact)
        });
        const data = await resp.json();
        
        if (data.success) {
          document.getElementById('w-firstName').value = '';
          document.getElementById('w-lastName').value = '';
          document.getElementById('w-company').value = '';
          document.getElementById('w-title').value = '';
          document.getElementById('w-linkedin').value = '';
          loadWatchlist();
        } else {
          showError('w-error', data.error || 'Failed to add');
        }
      } catch (e) { showError('w-error', e.message); }
    }
    
    async function removeFromWatchlist(id) {
      if (!confirm('Remove this contact from watchlist?')) return;
      try {
        await fetch('/api/watchlist?id=' + id, { method: 'DELETE' });
        loadWatchlist();
      } catch (e) { showError('w-error', e.message); }
    }
    
    async function checkWatchlist() {
      showLoading('w-loading', true);
      hideError('w-error');
      document.getElementById('w-changes').innerHTML = '';
      
      try {
        const resp = await fetch('/api/watchlist/check', { method: 'POST' });
        const data = await resp.json();
        
        if (data.changes?.length > 0) {
          let h = '<div class="warning" style="display:block"><strong>🔔 ' + data.changes.length + ' job changes detected!</strong><ul style="margin:10px 0 0 20px">';
          data.changes.forEach(c => {
            c.changes.forEach(ch => {
              h += '<li><strong>' + esc(c.contact.name) + '</strong>: ' + ch.type + ' changed from "' + esc(ch.from) + '" to "' + esc(ch.to) + '"</li>';
            });
          });
          h += '</ul></div>';
          document.getElementById('w-changes').innerHTML = h;
        } else {
          document.getElementById('w-changes').innerHTML = '<div class="success show">✅ No changes detected. All ' + data.checked + ' contacts checked.</div>';
        }
        
        loadWatchlist();
      } catch (e) { showError('w-error', e.message); }
      finally { showLoading('w-loading', false); }
    }
    
    // Load watchlist on tab switch
    document.querySelector('[data-tab="watchlist"]')?.addEventListener('click', loadWatchlist);
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

  if (parsed.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', version: '6.0.0' })); return; }

  // API: Dashboard Stats
  if (parsed.pathname === '/api/stats') {
    const data = stats.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // API: Reset Stats (admin)
  if (parsed.pathname === '/api/stats/reset' && req.method === 'POST') {
    const data = stats.resetStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, stats: data }));
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }

  // API: Discover
  if (parsed.pathname === '/api/discover') {
    const { firstName, lastName, company, domain, linkedin } = parsed.query;
    if (!firstName || !lastName) { 
      res.writeHead(400, { 'Content-Type': 'application/json' }); 
      res.end(JSON.stringify({ error: 'Name required' })); 
      return; 
    }
    try {
      console.log(`\x1b[36m🔍 Discover: ${firstName} ${lastName}\x1b[0m`);
      stats.trackRequest('/api/discover');
      const result = discoverPerson(firstName, lastName, company || '', domain || '', linkedin || '');
      stats.trackEnrichment(result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('Discover error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, emails: [], phones: [] }));
    }
    return;
  }

  // API: Prospect
  if (parsed.pathname === '/api/prospect' && req.method === 'POST') {
    handlePost(req, res, (filters, send) => {
      console.log(`\x1b[36m🎯 Prospect: ${JSON.stringify(filters)}\x1b[0m`);
      stats.trackRequest('/api/prospect');
      const results = prospectPeople(filters);
      send(200, results);
    });
    return;
  }

  // API: Colleagues (NEW)
  if (parsed.pathname === '/api/colleagues' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { domain, roles, seniority, department, limit } = JSON.parse(body || '{}');
        if (!domain) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Domain required' }));
          return;
        }
        console.log(`\x1b[36m👥 Colleagues: ${domain} [${roles?.join(', ') || 'all'}]\x1b[0m`);
        stats.trackRequest('/api/colleagues');
        const results = findColleagues(domain, { roles, seniority, department, limit });
        console.log(`\x1b[32m✅ Found ${results.colleagues?.length || 0} colleagues (${results.duration}ms)\x1b[0m`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (e) {
        console.error('Colleagues error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }


  // API: Enrich Colleague (NEW)
  if (parsed.pathname === '/api/colleagues/enrich' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const colleague = safeJsonParse(body);
        console.log(`\x1b[36m👤 Enrich: ${colleague.firstName} ${colleague.lastName}\x1b[0m`);
        const results = enrichColleague(colleague);
        console.log(`\x1b[32m✅ Found ${results.emails?.length || 0} emails, ${results.phones?.length || 0} phones\x1b[0m`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (e) {
        console.error('Enrich error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, emails: [], phones: [] }));
      }
    });
    return;
  }

  // API: Company
  if (parsed.pathname === '/api/company') {
    const { domain } = parsed.query;
    if (!domain) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Domain required' })); return; }
    try {
      console.log(`\x1b[36m🏢 Company: ${domain}\x1b[0m`);
      const results = getCompanyIntel(domain);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (e) {
      console.error('Company error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, company: null }));
    }
    return;
  }

  // API: ABN Lookup
  if (parsed.pathname === '/api/abn') {
    const { q } = parsed.query;
    if (!q) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Query (q) required' })); return; }
    try {
      console.log(`\x1b[36m🔢 ABN: ${q}\x1b[0m`);
      const results = lookupABN(q);
      console.log(`\x1b[32m✅ Found ${results.matches?.length || 0} ABN matches (${results.duration}ms)\x1b[0m`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (e) {
      console.error('ABN error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, matches: [] }));
    }
    return;
  }

  // API: ABN Validate
  if (parsed.pathname === '/api/abn/validate') {
    const { abn } = parsed.query;
    if (!abn) { res.writeHead(400); res.end(JSON.stringify({ error: 'ABN required' })); return; }
    const result = validateABN(abn);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: Hiring Signals
  if (parsed.pathname === '/api/hiring') {
    const { company } = parsed.query;
    if (!company) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Company name or domain required' })); return; }
    try {
      console.log(`\x1b[36m💼 Hiring: ${company}\x1b[0m`);
      const results = getHiringSignals(company);
      console.log(`\x1b[32m✅ Found ${results.jobCount || 0} jobs, ${results.careerPages?.length || 0} sources (${results.duration}ms)\x1b[0m`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (e) {
      console.error('Hiring error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, jobCount: 0, careerPages: [] }));
    }
    return;
  }



  // API: Tech Stack Lookup
  if (parsed.pathname === '/api/tech') {
    const { company } = parsed.query;
    if (!company) { res.writeHead(400); res.end(JSON.stringify({ error: 'Company name or domain required' })); return; }
    console.log(`\x1b[36m🔧 Tech Stack: ${company}\x1b[0m`);
    const results = getTechStack(company);
    console.log(`\x1b[32m✅ Found ${results.totalCount} technologies (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: Search by Technology
  if (parsed.pathname === '/api/tech/search') {
    const { tech, location, limit } = parsed.query;
    if (!tech) { res.writeHead(400); res.end(JSON.stringify({ error: 'Technology name required' })); return; }
    console.log(`\x1b[36m🔧 Tech Search: ${tech} in ${location || 'any location'}\x1b[0m`);
    const results = searchByTech(tech, location, parseInt(limit) || 10);
    console.log(`\x1b[32m✅ Found ${results.companies.length} companies (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // API: Lookalike Companies
  if (parsed.pathname === '/api/lookalike') {
    const { company, location, limit, minEmployees, maxEmployees } = parsed.query;
    if (!company) { res.writeHead(400); res.end(JSON.stringify({ error: 'Seed company required' })); return; }
    console.log(`\x1b[36m🔄 Lookalike: ${company}\x1b[0m`);
    const results = findLookalikes(company, { 
      location, 
      limit: parseInt(limit) || 10,
      minEmployees: minEmployees ? parseInt(minEmployees) : null,
      maxEmployees: maxEmployees ? parseInt(maxEmployees) : null,
    });
    console.log(`\x1b[32m✅ Found ${results.lookalikes.length} similar companies (${results.duration}ms)\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }




  // API: LinkedIn
  if (parsed.pathname === '/api/linkedin') {
    const { url: liUrl } = parsed.query;
    if (!liUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'URL required' })); return; }
    console.log(`\x1b[36m🔗 LinkedIn: ${liUrl}\x1b[0m`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(enrichLinkedIn(liUrl)));
    return;
  }

  // Bulk endpoints
  if (parsed.pathname === '/api/bulk/template') {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="template.csv"' });
    res.end('firstName,lastName,company,domain,linkedin,title\nJohn,Smith,Acme,acme.com,,CEO\nJane,Doe,Tech Co,techco.io,,CTO');
    return;
  }

  if (parsed.pathname === '/api/bulk/validate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { csv } = safeJsonParse(body);
        const parsed = parseCSV(csv);
        if (parsed.error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: parsed.error })); return; }
        if (parsed.contacts.length > 100) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Max 100 contacts' })); return; }
        const compliance = checkCompliance(parsed.contacts);
        console.log(`\x1b[36m📋 Validate: ${compliance.validContacts.length} valid, ${compliance.issues.length} issues\x1b[0m`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(compliance));
      } catch (e) {
        console.error('Bulk validate error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/bulk/enrich' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { contacts } = safeJsonParse(body);
        console.log(`\x1b[36m📋 Enrich: ${contacts?.length || 0} contacts\x1b[0m`);
        stats.trackRequest('/api/bulk/enrich');
        const results = await enrichContactsBulk(contacts || []);
        results.forEach(r => stats.trackEnrichment(r));
        console.log(`\x1b[32m✅ Enriched ${results.length} contacts\x1b[0m`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enriched: results }));
      } catch (e) {
        console.error('Bulk enrich error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, enriched: [] }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/bulk/download' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { results } = safeJsonParse(body);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="enriched.csv"' });
        res.end(generateCSV(results || []));
      } catch (e) {
        console.error('Bulk download error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Export to HubSpot format
  if (parsed.pathname === '/api/export/hubspot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { data, type } = safeJsonParse(body);
        console.log(`\x1b[36m📤 Export HubSpot: ${type}\x1b[0m`);
        const contacts = normalizeForExport(data, type);
        const csv = generateHubSpotCSV(contacts);
        res.writeHead(200, { 
          'Content-Type': 'text/csv', 
          'Content-Disposition': 'attachment; filename="hubspot_import.csv"' 
        });
        res.end(csv);
      } catch (e) {
        console.error('HubSpot export error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Export to Salesforce format
  if (parsed.pathname === '/api/export/salesforce' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { data, type } = safeJsonParse(body);
        console.log(`\x1b[36m📤 Export Salesforce: ${type}\x1b[0m`);
        const contacts = normalizeForExport(data, type);
        const csv = generateSalesforceCSV(contacts);
        res.writeHead(200, { 
          'Content-Type': 'text/csv', 
          'Content-Disposition': 'attachment; filename="salesforce_leads.csv"' 
        });
        res.end(csv);
      } catch (e) {
        console.error('Salesforce export error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Slack: /colleagues endpoint
  if (parsed.pathname === '/slack/colleagues' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /colleagues: ${text}\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'in_channel', text: `👥 Searching for colleagues at ${text}...` }));
      
      setImmediate(() => {
        try {
          const parts = (text || '').split(/\s+/);
          const domain = parts[0];
          const roles = parts.slice(1).filter(p => !['at', 'in', '@'].includes(p.toLowerCase()));
          
          const results = findColleagues(domain, { roles, limit: 10 });
          
          let msg = `👥 *${results.company?.name || domain}*\n`;
          if (results.company?.employees) msg += `${results.company.employees} AU employees\n`;
          msg += `\nFound *${results.total}* colleagues:\n`;
          
          (results.colleagues || []).slice(0, 8).forEach(c => {
            msg += `• *${c.name}* - ${c.title || 'Unknown'}`;
            if (c.linkedin) msg += ` <${c.linkedin}|LinkedIn>`;
            msg += '\n';
          });
          
          if (results.total > 8) msg += `_...and ${results.total - 8} more_\n`;
          msg += `\n_${results.duration}ms | FREE - no credits_`;
          
          if (response_url) {
            curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
          }
        } catch (e) {
          console.error('Slack colleagues error:', e.message);
          if (response_url) {
            curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'ephemeral', text: `Error: ${e.message}` });
          }
        }
      });
    });
    return;
  }

  // Slack: /abn command
  if (parsed.pathname === '/slack/abn' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /abn: ${text}\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'in_channel', text: `🔢 Looking up ABN: ${text}...` }));
      
      setImmediate(() => {
        const results = lookupABN(text.trim());
        
        let msg = `🔢 *ABN Search: ${text}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (results.matches?.length) {
          results.matches.slice(0, 5).forEach(m => {
            msg += `\n*${m.abn}*\n`;
            msg += `${m.entityName || 'Unknown'}\n`;
            msg += `Status: ${m.status}${m.statusDate ? ' (since ' + m.statusDate + ')' : ''}\n`;
            if (m.entityType) msg += `Type: ${m.entityType}\n`;
            msg += `<${m.url}|View on ABR>\n`;
          });
        } else {
          msg += `_No ABN records found_\n`;
        }
        
        msg += `\n_${results.duration}ms_`;
        
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
        }
      });
    });
    return;
  }

  // Slack: /hiring command
  if (parsed.pathname === '/slack/hiring' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /hiring: ${text}\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'in_channel', text: `💼 Checking hiring at ${text}...` }));
      
      setImmediate(() => {
        const results = getHiringSignals(text.trim());
        
        let msg = `💼 *${results.company?.name || text}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (results.company) {
          if (results.company.employees) msg += `👥 ${results.company.employees.toLocaleString()} employees\n`;
          if (results.company.industry) msg += `🏷️ ${results.company.industry}\n`;
        }
        
        if (results.jobCount) {
          msg += `\n📊 *${results.jobCount} open positions*\n`;
        }
        
        if (results.growthIndicators?.length) {
          results.growthIndicators.forEach(g => {
            const emoji = g.type === 'hot' ? '🔥' : g.type === 'active' ? '📈' : '✅';
            msg += `${emoji} ${g.label}\n`;
          });
        }
        
        if (results.careerPages?.length) {
          msg += `\n📍 *Job Sources:*\n`;
          results.careerPages.slice(0, 4).forEach(p => {
            msg += `• <${p.url}|${p.source}>${p.jobCount ? ' (' + p.jobCount + ' jobs)' : ''}\n`;
          });
        }
        
        msg += `\n_${results.duration}ms_`;
        
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
        }
      });
    });
    return;
  }


  // Slack: /tech command
  if (parsed.pathname === '/slack/tech' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /tech: ${text}\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'in_channel', text: `🔧 Looking up tech stack for ${text}...` }));
      
      setImmediate(() => {
        const results = getTechStack(text.trim());
        
        let msg = `🔧 *${results.company?.name || text}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (results.company) {
          if (results.company.employees) msg += `👥 ${results.company.employees.toLocaleString()} employees\n`;
          if (results.company.industry) msg += `🏷️ ${results.company.industry}\n`;
        }
        
        msg += `\n📊 *${results.totalCount} technologies*\n`;
        
        if (Object.keys(results.byCategory).length) {
          const sorted = Object.entries(results.byCategory).sort((a,b) => b[1].length - a[1].length);
          sorted.slice(0, 8).forEach(([cat, techs]) => {
            msg += `\n*${cat}* (${techs.length})\n`;
            msg += `${techs.slice(0, 5).join(', ')}${techs.length > 5 ? '...' : ''}\n`;
          });
        }
        
        msg += `\n_${results.duration}ms_`;
        
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
        }
      });
    });
    return;
  }


  // Slack: /lookalike command
  if (parsed.pathname === '/slack/lookalike' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /lookalike: ${text}\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'in_channel', text: `🔄 Finding companies similar to ${text}...` }));
      
      setImmediate(() => {
        const results = findLookalikes(text.trim(), { limit: 10 });
        
        let msg = '';
        
        if (results.seed) {
          msg += `📌 *Seed: ${results.seed.name}*\n`;
          msg += `${results.seed.industry || ''} • ${results.seed.employees?.toLocaleString() || '?'} employees\n`;
          msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        }
        
        msg += `\n🔄 *${results.lookalikes.length} Similar Companies*\n`;
        
        if (results.lookalikes.length) {
          results.lookalikes.slice(0, 8).forEach(c => {
            msg += `\n• *${c.name}* (${c.similarity}% match)\n`;
            msg += `  ${c.industry || ''} • ${c.employees?.toLocaleString() || '?'} emp`;
            if (c.linkedin) msg += ` • <${c.linkedin}|LinkedIn>`;
            msg += '\n';
          });
          if (results.lookalikes.length > 8) msg += `\n_...and ${results.lookalikes.length - 8} more_\n`;
        } else {
          msg += '_No similar companies found_\n';
        }
        
        msg += `\n_${results.duration}ms_`;
        
        if (response_url) {
          curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
        }
      });
    });
    return;
  }


  // Slack: /cdhelp command (help/readme)
  if ((parsed.pathname === '/slack/cdhelp' || parsed.pathname === '/slack/help') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      console.log(`\x1b[35m📱 Slack /cdhelp\x1b[0m`);
      
      const helpText = `🔍 *Contact Discovery Bot - Command Reference*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*PERSON LOOKUP*
\`/discover Tom Cowan, TDM Growth Partners\`
→ Find emails, phones, LinkedIn for a person

*PROSPECTING* ✨ FREE
\`/prospect CEO Sydney 10\`
\`/prospect CFO, Director Melbourne fintech\`
→ Find leads by title, location, industry

*FIND COLLEAGUES* ✨ FREE
\`/colleagues atlassian.com CFO\`
\`/colleagues canva.com CEO CTO VP\`
→ Find specific roles at any company

*COMPANY INTEL*
\`/company atlassian.com\`
\`/company Canva\`
→ Full company profile, employees, tech stack

*LINKEDIN ENRICHMENT*
\`/linkedin https://linkedin.com/in/username\`
→ Get contact info from LinkedIn URL

*ABN LOOKUP* ✨ FREE
\`/abn Atlassian\`
\`/abn 53 102 443 916\`
→ Australian Business Number verification

*HIRING SIGNALS* ✨ FREE
\`/hiring canva.com\`
→ Open jobs, growth indicators, career pages

*TECH STACK*
\`/tech atlassian.com\`
→ See what technologies a company uses

*LOOKALIKE COMPANIES* ✨ FREE
\`/lookalike atlassian.com\`
→ Find similar companies by industry & size

*JOB CHANGE ALERTS*
\`/watchlist\` → List watched contacts
\`/watchlist add Tom Cowan TDM\` → Add to watchlist
\`/watchlist check\` → Check for job changes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ = FREE (no API credits used)
📊 Web UI: Open the app for bulk upload, CRM export, and dashboard
`;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        response_type: 'ephemeral',  // Only visible to user who typed command
        text: helpText 
      }));
    });
    return;
  }

  // Slack: /watchlist command
  if (parsed.pathname === '/slack/watchlist' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = querystring.parse(body);
      const { text, response_url } = params;
      console.log(`\x1b[35m📱 Slack /watchlist: ${text}\x1b[0m`);
      
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() || 'list';
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      let msg = '';
      
      if (cmd === 'add' && parts.length >= 3) {
        // /watchlist add FirstName LastName [Company]
        const firstName = parts[1];
        const lastName = parts[2];
        const company = parts.slice(3).join(' ');
        
        const result = watchlist.addToWatchlist({ firstName, lastName, company });
        
        if (result.success) {
          msg = `✅ Added *${firstName} ${lastName}*${company ? ' @ ' + company : ''} to watchlist\n_${result.total} contacts tracked_`;
        } else {
          msg = `❌ ${result.error}`;
        }
        res.end(JSON.stringify({ response_type: 'ephemeral', text: msg }));
        
      } else if (cmd === 'check') {
        res.end(JSON.stringify({ response_type: 'in_channel', text: '👁️ Checking watchlist for job changes...' }));
        
        setImmediate(async () => {
          const wl = watchlist.getWatchlist();
          const results = { checked: 0, changes: [] };
          
          for (const contact of wl.contacts.slice(0, 20)) {
            try {
              let currentData = {};
              
              if (contact.linkedin) {
                const lushaData = curlGet(
                  `https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(contact.linkedin)}&revealEmails=false&revealPhones=false`,
                  { 'api_key': config.lusha.apiKey }
                );
                const d = lushaData.data || lushaData.contact?.data;
                if (d) {
                  currentData.title = d.currentJobTitle;
                  currentData.company = d.company?.name;
                }
              }
              
              if (!currentData.title) {
                const apolloData = curlPost(
                  'https://api.apollo.io/v1/people/match',
                  { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
                  { first_name: contact.firstName, last_name: contact.lastName, linkedin_url: contact.linkedin }
                );
                if (apolloData.person) {
                  currentData.title = apolloData.person.title;
                  currentData.company = apolloData.person.organization?.name;
                }
              }
              
              const changes = watchlist.checkForChanges(contact, currentData);
              if (changes.length > 0) {
                results.changes.push({ contact, changes });
                watchlist.updateContact(contact.id, currentData, changes);
              } else {
                watchlist.updateContact(contact.id, currentData, []);
              }
              results.checked++;
            } catch (e) { /* continue */ }
          }
          
          watchlist.markChecked();
          
          if (results.changes.length > 0) {
            msg = `🔔 *${results.changes.length} job changes detected!*\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            results.changes.forEach(c => {
              msg += `\n*${c.contact.firstName} ${c.contact.lastName}*\n`;
              c.changes.forEach(ch => {
                msg += `• ${ch.type}: ${ch.from} → ${ch.to}\n`;
              });
            });
          } else {
            msg = `✅ No changes detected. Checked ${results.checked} contacts.`;
          }
          
          if (response_url) {
            curlPost(response_url, { 'Content-Type': 'application/json' }, { response_type: 'in_channel', text: msg });
          }
        });
        return;
        
      } else if (cmd === 'remove' && parts[1]) {
        const result = watchlist.removeFromWatchlist(parts[1]);
        msg = result.success ? `✅ Removed from watchlist` : `❌ ${result.error}`;
        res.end(JSON.stringify({ response_type: 'ephemeral', text: msg }));
        
      } else {
        // Default: list
        const wl = watchlist.getWatchlist();
        msg = `👁️ *Watchlist* (${wl.total} contacts)\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (wl.contacts.length === 0) {
          msg += `_Empty. Add contacts with:_\n\`/watchlist add FirstName LastName Company\``;
        } else {
          wl.contacts.slice(0, 15).forEach(c => {
            const hasChanges = c.changeHistory?.length > 0;
            msg += `${hasChanges ? '🔔' : '•'} *${c.firstName} ${c.lastName}*`;
            if (c.lastCompany) msg += ` @ ${c.lastCompany}`;
            if (c.lastTitle) msg += ` (${c.lastTitle})`;
            msg += '\n';
          });
          if (wl.total > 15) msg += `_...and ${wl.total - 15} more_\n`;
        }
        
        if (wl.lastChecked) {
          msg += `\n_Last checked: ${new Date(wl.lastChecked).toLocaleString()}_`;
        }
        
        res.end(JSON.stringify({ response_type: 'in_channel', text: msg }));
      }
    });
    return;
  }



  // ============ WATCHLIST API ============
  
  // Get watchlist
  if (parsed.pathname === '/api/watchlist' && req.method === 'GET') {
    const data = watchlist.getWatchlist();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  
  // Add to watchlist
  if (parsed.pathname === '/api/watchlist' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const contact = safeJsonParse(body);
      console.log(`\x1b[36m👁️ Watchlist add: ${contact.firstName} ${contact.lastName}\x1b[0m`);
      const result = watchlist.addToWatchlist(contact);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  
  // Remove from watchlist
  if (parsed.pathname === '/api/watchlist' && req.method === 'DELETE') {
    const { id } = parsed.query;
    console.log(`\x1b[36m👁️ Watchlist remove: ${id}\x1b[0m`);
    const result = watchlist.removeFromWatchlist(id);
    res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  
  // Check watchlist for changes
  if (parsed.pathname === '/api/watchlist/check' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      console.log(`\x1b[36m👁️ Checking watchlist for changes...\x1b[0m`);
      const wl = watchlist.getWatchlist();
      const results = { checked: 0, changes: [], errors: [] };
      
      for (const contact of wl.contacts) {
        try {
          // Enrich to get current data
          let currentData = {};
          
          if (contact.linkedin) {
            const lushaData = curlGet(
              `https://api.lusha.com/v2/person?linkedinUrl=${encodeURIComponent(contact.linkedin)}&revealEmails=false&revealPhones=false`,
              { 'api_key': config.lusha.apiKey }
            );
            const d = lushaData.data || lushaData.contact?.data;
            if (d) {
              currentData.title = d.currentJobTitle;
              currentData.company = d.company?.name;
            }
          }
          
          if (!currentData.title) {
            const apolloData = curlPost(
              'https://api.apollo.io/v1/people/match',
              { 'Content-Type': 'application/json', 'x-api-key': config.apollo.apiKey },
              { first_name: contact.firstName, last_name: contact.lastName, linkedin_url: contact.linkedin }
            );
            if (apolloData.person) {
              currentData.title = apolloData.person.title;
              currentData.company = apolloData.person.organization?.name;
            }
          }
          
          const changes = watchlist.checkForChanges(contact, currentData);
          
          if (changes.length > 0) {
            results.changes.push({
              contact: { id: contact.id, name: `${contact.firstName} ${contact.lastName}`, linkedin: contact.linkedin },
              changes: changes,
            });
            watchlist.updateContact(contact.id, currentData, changes);
          } else {
            watchlist.updateContact(contact.id, currentData, []);
          }
          
          results.checked++;
          
          // Rate limiting
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          results.errors.push({ contact: contact.firstName + ' ' + contact.lastName, error: e.message });
        }
      }
      
      watchlist.markChecked();
      console.log(`\x1b[32m✅ Checked ${results.checked} contacts, ${results.changes.length} changes found\x1b[0m`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});


// Global error handlers to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`
\x1b[1m┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   🔍 Contact Discovery v6                                     │
│                                                               │
│   http://localhost:${PORT}                                        │
│                                                               │
│   Features:                                                   │
│     👤 Discover    🎯 Prospect (FREE)   🏢 Company            │
│     🔗 LinkedIn    📋 Bulk Upload                             │
│     👥 COLLEAGUES (NEW!) - Find roles at any company          │
│                                                               │
│   Slack: /colleagues atlassian.com CFO                        │
│                                                               │
└───────────────────────────────────────────────────────────────┘\x1b[0m
  `);
});
