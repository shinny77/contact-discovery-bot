#!/usr/bin/env node
/**
 * Contact Discovery CLI Tool
 * 
 * Test the contact discovery workflow with real API calls.
 * 
 * Usage:
 *   node cli.js "Steven Lowy, Principal, LFG, Sydney"
 *   node cli.js "John Smith" "Acme Corp" "CEO"
 *   node cli.js --batch contacts.txt
 *   node cli.js --help
 * 
 * Environment variables (optional - defaults are included):
 *   SERP_API_KEY, FIRMABLE_API_KEY, LUSHA_API_KEY, APOLLO_API_KEY, NUMVERIFY_API_KEY
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// ============================================================================
// CONFIGURATION (API keys embedded for testing)
// ============================================================================

const config = {
  apis: {
    serp: {
      apiKey: process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '',
      baseUrl: 'https://serpapi.com',
    },
    firmable: {
      apiKey: process.env.FIRMABLE_API_KEY || process.env.FIRMABLE_API_KEY || '',
      baseUrl: 'https://api.firmable.com/v1',
    },
    lusha: {
      apiKey: process.env.LUSHA_API_KEY || process.env.LUSHA_API_KEY || '',
      baseUrl: 'https://api.lusha.com',
    },
    apollo: {
      apiKey: process.env.APOLLO_API_KEY || process.env.APOLLO_API_KEY || '',
      baseUrl: 'https://api.apollo.io',
    },
    numverify: {
      apiKey: process.env.NUMVERIFY_API_KEY || 'd3ae53eca810fb4102116068d0ce4ca3',
      baseUrl: 'http://apilayer.net/api',
    },
  },
};

// ============================================================================
// COLORS FOR TERMINAL OUTPUT
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

// ============================================================================
// INPUT PARSER
// ============================================================================

function parseInput(input) {
  // Handle array input: ["John Smith", "Acme Corp", "CEO"]
  if (Array.isArray(input)) {
    return {
      firstName: input[0]?.split(' ')[0] || '',
      lastName: input[0]?.split(' ').slice(1).join(' ') || '',
      company: input[1] || '',
      title: input[2] || '',
      location: input[3] || 'Australia',
      domain: null,
      linkedinUrl: null,
    };
  }

  // Handle string input
  let text = input.trim();
  let linkedinUrl = null;
  
  // Extract LinkedIn URL if present
  const linkedinMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s,]+/i);
  if (linkedinMatch) {
    linkedinUrl = linkedinMatch[0];
    text = text.replace(linkedinMatch[0], '').trim();
  }
  
  // Try to parse structured input
  let firstName = '', lastName = '', company = '', title = '', location = 'Australia';
  
  // Format: "John Smith, CEO, Acme Corp, Sydney"
  if (text.includes(',')) {
    const parts = text.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 1) {
      const nameParts = parts[0].split(' ');
      firstName = nameParts[0] || '';
      lastName = nameParts.slice(1).join(' ') || '';
    }
    if (parts.length >= 2) title = parts[1];
    if (parts.length >= 3) company = parts[2];
    if (parts.length >= 4) location = parts[3];
  }
  // Format: "John Smith @ Acme Corp"
  else if (text.includes('@') || text.toLowerCase().includes(' at ')) {
    const separator = text.includes('@') ? '@' : / at /i;
    const [namePart, companyPart] = text.split(separator).map(p => p.trim());
    const nameParts = namePart.split(' ');
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
    company = companyPart || '';
  }
  // Format: "John Smith (CEO) Acme Corp"
  else if (text.includes('(')) {
    const titleMatch = text.match(/\(([^)]+)\)/);
    if (titleMatch) {
      title = titleMatch[1];
      text = text.replace(titleMatch[0], '').trim();
    }
    const parts = text.split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts[1] || '';
    company = parts.slice(2).join(' ') || '';
  }
  // Simple name only
  else {
    const parts = text.split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }
  
  return {
    firstName,
    lastName,
    company,
    title,
    location,
    domain: null,
    linkedinUrl,
  };
}

// ============================================================================
// NAME UTILITIES
// ============================================================================

const nicknameMap = {
  'bob': 'robert', 'rob': 'robert', 'bobby': 'robert',
  'bill': 'william', 'will': 'william', 'billy': 'william', 'liam': 'william',
  'mike': 'michael', 'mick': 'michael', 'mikey': 'michael',
  'jim': 'james', 'jimmy': 'james', 'jamie': 'james',
  'tom': 'thomas', 'tommy': 'thomas',
  'dick': 'richard', 'rick': 'richard', 'rich': 'richard', 'ricky': 'richard',
  'steve': 'steven', 'stevie': 'steven',
  'dave': 'david', 'davy': 'david',
  'dan': 'daniel', 'danny': 'daniel',
  'tony': 'anthony', 'ant': 'anthony',
  'joe': 'joseph', 'joey': 'joseph',
  'chris': 'christopher', 'kit': 'christopher',
  'matt': 'matthew', 'matty': 'matthew',
  'nick': 'nicholas', 'nicky': 'nicholas',
  'alex': 'alexander', 'xander': 'alexander',
  'sam': 'samuel', 'sammy': 'samuel',
  'ben': 'benjamin', 'benny': 'benjamin',
  'ted': 'theodore', 'teddy': 'theodore',
  'ed': 'edward', 'eddie': 'edward', 'ned': 'edward',
  'chuck': 'charles', 'charlie': 'charles',
  'jack': 'john', 'johnny': 'john', 'jon': 'john',
  'pete': 'peter',
  'andy': 'andrew', 'drew': 'andrew',
  'greg': 'gregory',
  'jeff': 'jeffrey',
  'larry': 'lawrence',
  'liz': 'elizabeth', 'beth': 'elizabeth', 'betsy': 'elizabeth', 'lisa': 'elizabeth',
  'kate': 'katherine', 'kathy': 'katherine', 'katie': 'katherine',
  'meg': 'margaret', 'maggie': 'margaret', 'peggy': 'margaret',
  'sue': 'susan', 'suzy': 'susan',
  'jen': 'jennifer', 'jenny': 'jennifer',
  'pat': 'patricia', 'patty': 'patricia', 'trish': 'patricia',
};

function getNameVariants(name) {
  const lower = name.toLowerCase();
  const variants = [name];
  
  if (nicknameMap[lower]) {
    variants.push(nicknameMap[lower].charAt(0).toUpperCase() + nicknameMap[lower].slice(1));
  }
  
  Object.entries(nicknameMap).forEach(([nick, full]) => {
    if (full === lower) {
      variants.push(nick.charAt(0).toUpperCase() + nick.slice(1));
    }
  });
  
  return [...new Set(variants)];
}

// ============================================================================
// WEB SEARCH MODULE
// ============================================================================

const webSearch = {
  async serpApiSearch(query, options = {}) {
    try {
      log(colors.dim, `   🔍 Searching: "${query}"`);
      const response = await axios.get(`${config.apis.serp.baseUrl}/search.json`, {
        params: {
          api_key: config.apis.serp.apiKey,
          engine: 'google',
          q: query,
          num: 10,
          gl: options.country || 'au',
          hl: 'en',
          google_domain: options.country === 'us' ? 'google.com' : 'google.com.au',
        },
        timeout: 15000,
      });
      
      const results = [];
      
      if (response.data.knowledge_graph?.profiles) {
        const linkedinProfile = response.data.knowledge_graph.profiles.find(
          p => p.link?.includes('linkedin.com')
        );
        if (linkedinProfile) {
          results.push({
            url: linkedinProfile.link,
            title: linkedinProfile.name || 'LinkedIn Profile',
            snippet: 'From Knowledge Graph',
            position: 0,
            fromKnowledgeGraph: true,
          });
        }
      }
      
      const organicResults = response.data.organic_results || [];
      organicResults.forEach(r => {
        results.push({
          url: r.link,
          title: r.title,
          snippet: r.snippet,
          position: r.position,
        });
      });
      
      return results;
    } catch (err) {
      log(colors.red, `   ✗ SerpAPI error: ${err.response?.data?.error || err.message}`);
      return [];
    }
  },

  async findLinkedInProfile(person) {
    const strategies = [
      `site:linkedin.com/in/ "${person.firstName} ${person.lastName}" "${person.company}"`,
      `site:linkedin.com/in/ "${person.firstName} ${person.lastName}" ${person.title} ${person.company}`,
      `site:linkedin.com/in/ ${person.firstName} ${person.lastName} ${person.company}`,
    ];
    
    // Add nickname variants
    const firstNameVariants = getNameVariants(person.firstName);
    if (firstNameVariants.length > 1) {
      strategies.push(
        `site:linkedin.com/in/ "${firstNameVariants[1]} ${person.lastName}" "${person.company}"`
      );
    }
    
    // Add location-based search
    if (person.location) {
      strategies.push(
        `site:linkedin.com/in/ "${person.firstName} ${person.lastName}" ${person.location}`
      );
    }
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const query of strategies) {
      const results = await this.serpApiSearch(query);
      
      for (const result of results) {
        if (!result.url?.includes('linkedin.com/in/')) continue;
        
        let score = 0;
        const titleLower = result.title?.toLowerCase() || '';
        const urlLower = result.url?.toLowerCase() || '';
        
        if (result.fromKnowledgeGraph) score += 35;
        if (titleLower.includes(person.firstName.toLowerCase())) score += 20;
        if (titleLower.includes(person.lastName.toLowerCase())) score += 20;
        if (urlLower.includes(person.lastName.toLowerCase())) score += 15;
        if (person.company && titleLower.includes(person.company.toLowerCase())) score += 20;
        if (person.title && titleLower.includes(person.title.toLowerCase())) score += 10;
        if (person.location && titleLower.includes(person.location.toLowerCase())) score += 5;
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            url: result.url,
            title: result.title,
            score: score,
            confidence: Math.min(score / 100, 0.99),
          };
        }
      }
      
      if (bestScore >= 60) break;
    }
    
    return bestMatch;
  },

  async findCompanyDomain(companyName) {
    if (!companyName) return null;
    
    const results = await this.serpApiSearch(`${companyName} official website`);
    
    for (const result of results) {
      const url = result.url;
      if (!url) continue;
      
      // Skip social media and common non-company sites
      if (url.match(/linkedin|facebook|twitter|wikipedia|crunchbase|glassdoor|indeed/i)) continue;
      
      try {
        const domain = new URL(url).hostname.replace('www.', '');
        return domain;
      } catch (e) {
        continue;
      }
    }
    
    return null;
  },

  async preEnrich(person) {
    log(colors.cyan, '\n📡 Phase 1: Web Search Pre-Enrichment');
    
    const searchInsights = {
      linkedinSearch: null,
      domainSearch: null,
    };
    
    // Find LinkedIn profile
    if (!person.linkedinUrl) {
      log(colors.dim, '   Looking for LinkedIn profile...');
      const linkedinResult = await this.findLinkedInProfile(person);
      if (linkedinResult) {
        person.linkedinUrl = linkedinResult.url;
        searchInsights.linkedinSearch = linkedinResult;
        log(colors.green, `   ✓ Found LinkedIn: ${linkedinResult.url} (${Math.round(linkedinResult.confidence * 100)}% confidence)`);
      } else {
        log(colors.yellow, '   ✗ No LinkedIn profile found');
      }
    }
    
    // Find company domain
    if (!person.domain && person.company) {
      log(colors.dim, '   Looking for company domain...');
      const domain = await this.findCompanyDomain(person.company);
      if (domain) {
        person.domain = domain;
        searchInsights.domainSearch = domain;
        log(colors.green, `   ✓ Found domain: ${domain}`);
      }
    }
    
    return { enriched: person, searchInsights };
  },
};

// ============================================================================
// API SERVICES
// ============================================================================

const apiServices = {
  async firmableEnrich(person, linkedinUrl) {
    const results = { emails: [], mobiles: [], raw: null, error: null };
    
    try {
      log(colors.dim, '   📡 Firmable: Querying...');
      
      let endpoint = '/person/enrich';
      let params = {};
      
      if (linkedinUrl) {
        params.linkedin = linkedinUrl;
      } else if (person.company) {
        endpoint = '/person/search';
        params = {
          first_name: person.firstName,
          last_name: person.lastName,
          company: person.company,
        };
      }
      
      const response = await axios.get(`${config.apis.firmable.baseUrl}${endpoint}`, {
        params,
        headers: { 'x-api-key': config.apis.firmable.apiKey },
        timeout: 10000,
      });
      
      if (response.data) {
        results.raw = response.data;
        const data = response.data.person || response.data;
        
        if (data.email) {
          results.emails.push({
            email: data.email,
            type: 'work',
            confidence: 0.9,
          });
        }
        
        if (data.mobile) {
          results.mobiles.push({
            number: data.mobile,
            type: 'mobile',
            confidence: 0.9,
          });
        }
        
        if (data.phone) {
          results.mobiles.push({
            number: data.phone,
            type: 'direct',
            confidence: 0.85,
          });
        }
        
        log(colors.green, `   ✓ Firmable: ${results.emails.length} emails, ${results.mobiles.length} phones`);
      }
    } catch (error) {
      results.error = error.response?.data?.message || error.message;
      log(colors.red, `   ✗ Firmable: ${results.error}`);
    }
    
    return results;
  },

  async lushaEnrich(person) {
    const results = { emails: [], mobiles: [], raw: null, error: null };
    
    try {
      log(colors.dim, '   📡 Lusha: Querying...');
      
      const response = await axios.get(`${config.apis.lusha.baseUrl}/person`, {
        params: {
          firstName: person.firstName,
          lastName: person.lastName,
          company: person.domain || person.company,
        },
        headers: { api_key: config.apis.lusha.apiKey },
        timeout: 10000,
      });
      
      if (response.data?.data) {
        results.raw = response.data.data;
        const data = response.data.data;
        
        if (data.emailAddresses) {
          data.emailAddresses.forEach(e => {
            results.emails.push({
              email: e.email,
              type: e.type || 'work',
              confidence: 0.85,
            });
          });
        }
        
        if (data.phoneNumbers) {
          data.phoneNumbers.forEach(p => {
            results.mobiles.push({
              number: p.internationalNumber || p.localNumber,
              type: p.type || 'mobile',
              confidence: 0.85,
            });
          });
        }
        
        log(colors.green, `   ✓ Lusha: ${results.emails.length} emails, ${results.mobiles.length} phones`);
      }
    } catch (error) {
      results.error = error.response?.data?.message || error.message;
      log(colors.red, `   ✗ Lusha: ${results.error}`);
    }
    
    return results;
  },

  async apolloEnrich(person) {
    const results = { emails: [], mobiles: [], linkedin: null, raw: null, error: null };
    
    try {
      log(colors.dim, '   📡 Apollo: Querying...');
      
      const body = {
        first_name: person.firstName,
        last_name: person.lastName,
        reveal_personal_emails: true,
        reveal_phone_number: true,
      };
      
      if (person.domain) body.domain = person.domain;
      if (person.company) body.organization_name = person.company;
      if (person.linkedinUrl) body.linkedin_url = person.linkedinUrl;
      
      const response = await axios.post(
        `${config.apis.apollo.baseUrl}/api/v1/people/match`,
        body,
        {
          headers: {
            'x-api-key': config.apis.apollo.apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      
      if (response.data?.person) {
        results.raw = response.data.person;
        const data = response.data.person;
        
        if (data.email) {
          results.emails.push({
            email: data.email,
            type: 'work',
            confidence: 0.9,
          });
        }
        
        if (data.personal_emails) {
          data.personal_emails.forEach(e => {
            results.emails.push({
              email: e,
              type: 'personal',
              confidence: 0.7,
            });
          });
        }
        
        if (data.phone_numbers) {
          data.phone_numbers.forEach(p => {
            results.mobiles.push({
              number: p.raw_number || p.sanitized_number,
              type: p.type || 'mobile',
              confidence: 0.85,
            });
          });
        }
        
        if (data.linkedin_url) {
          results.linkedin = data.linkedin_url;
        }
        
        log(colors.green, `   ✓ Apollo: ${results.emails.length} emails, ${results.mobiles.length} phones`);
      }
    } catch (error) {
      results.error = error.response?.data?.message || error.message;
      log(colors.red, `   ✗ Apollo: ${results.error}`);
    }
    
    return results;
  },
};

// ============================================================================
// PHONE VALIDATION
// ============================================================================

const validation = {
  async validatePhone(phoneNumber) {
    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      
      const response = await axios.get(`${config.apis.numverify.baseUrl}/validate`, {
        params: {
          access_key: config.apis.numverify.apiKey,
          number: cleanNumber,
          format: 1,
        },
        timeout: 5000,
      });
      
      if (response.data) {
        return {
          valid: response.data.valid,
          carrier: response.data.carrier,
          lineType: response.data.line_type,
          location: response.data.location,
          internationalFormat: response.data.international_format,
        };
      }
    } catch (error) {
      // Fallback validation
      return this.fallbackValidation(phoneNumber);
    }
    
    return { valid: false };
  },

  fallbackValidation(phone) {
    const cleaned = phone.replace(/\D/g, '');
    
    // Australian mobile: starts with 04 or +614
    if (cleaned.match(/^(61)?4\d{8}$/)) {
      return { valid: true, lineType: 'mobile', location: 'Australia' };
    }
    
    // Australian landline
    if (cleaned.match(/^(61)?[2378]\d{8}$/)) {
      return { valid: true, lineType: 'landline', location: 'Australia' };
    }
    
    // US/Canada
    if (cleaned.match(/^1?[2-9]\d{9}$/)) {
      return { valid: true, lineType: 'unknown', location: 'US/Canada' };
    }
    
    return { valid: cleaned.length >= 8 && cleaned.length <= 15 };
  },
};

// ============================================================================
// MAIN DISCOVERY FUNCTION
// ============================================================================

async function discoverContact(input) {
  const startTime = Date.now();
  
  let person = parseInput(input);
  
  log(colors.bright + colors.white, `\n${'═'.repeat(60)}`);
  log(colors.bright + colors.cyan, `🔍 DISCOVERING: ${person.firstName} ${person.lastName}`);
  log(colors.dim, `   Company: ${person.company || 'Unknown'}`);
  log(colors.dim, `   Title: ${person.title || 'Unknown'}`);
  log(colors.dim, `   Location: ${person.location || 'Australia (default)'}`);
  log(colors.bright + colors.white, `${'═'.repeat(60)}`);
  
  // Default to Australia
  if (!person.location) {
    person.location = 'Australia';
  }
  
  const results = {
    input: person,
    linkedin: null,
    searchInsights: null,
    sources: {
      firmable: null,
      lusha: null,
      apollo: null,
    },
    consolidated: {
      emails: [],
      mobiles: [],
    },
    validation: [],
    metadata: {
      timestamp: new Date().toISOString(),
      duration_ms: 0,
    },
  };
  
  // Phase 1: Web Search
  const { enriched, searchInsights } = await webSearch.preEnrich(person);
  person = enriched;
  results.searchInsights = searchInsights;
  results.linkedin = enriched.linkedinUrl || null;
  
  // Phase 2: API Enrichment
  log(colors.cyan, '\n📡 Phase 2: API Enrichment');
  
  const [apolloResult, lushaResult] = await Promise.all([
    apiServices.apolloEnrich(person),
    apiServices.lushaEnrich(person),
  ]);
  
  results.sources.apollo = apolloResult;
  results.sources.lusha = lushaResult;
  
  if (!results.linkedin && apolloResult.linkedin) {
    results.linkedin = apolloResult.linkedin;
    log(colors.green, `   ✓ LinkedIn from Apollo: ${apolloResult.linkedin}`);
  }
  
  // Firmable for AU/NZ
  const isAUNZ = person.location?.toLowerCase().match(/australia|au|new zealand|nz|sydney|melbourne|brisbane|perth|adelaide/i);
  if (isAUNZ) {
    results.sources.firmable = await apiServices.firmableEnrich(person, results.linkedin);
  }
  
  // Phase 3: Consolidate
  log(colors.cyan, '\n📊 Phase 3: Consolidating Results');
  
  const allEmails = [];
  const allMobiles = [];
  
  ['firmable', 'lusha', 'apollo'].forEach(source => {
    const sourceData = results.sources[source];
    if (sourceData) {
      sourceData.emails?.forEach(e => allEmails.push({ ...e, source }));
      sourceData.mobiles?.forEach(m => allMobiles.push({ ...m, source }));
    }
  });
  
  // Deduplicate emails
  const emailCounts = {};
  allEmails.forEach(e => {
    const key = e.email?.toLowerCase();
    if (!key) return;
    if (!emailCounts[key]) {
      emailCounts[key] = { ...e, sources: [e.source], count: 1 };
    } else {
      emailCounts[key].count++;
      emailCounts[key].sources.push(e.source);
      emailCounts[key].confidence = Math.min(emailCounts[key].confidence + 0.1, 1.0);
    }
  });
  results.consolidated.emails = Object.values(emailCounts).sort((a, b) => b.confidence - a.confidence);
  
  // Deduplicate mobiles
  const mobileCounts = {};
  allMobiles.forEach(m => {
    const key = m.number?.replace(/\D/g, '');
    if (!key) return;
    if (!mobileCounts[key]) {
      mobileCounts[key] = { ...m, sources: [m.source], count: 1 };
    } else {
      mobileCounts[key].count++;
      mobileCounts[key].sources.push(m.source);
      mobileCounts[key].confidence = Math.min(mobileCounts[key].confidence + 0.1, 1.0);
    }
  });
  results.consolidated.mobiles = Object.values(mobileCounts).sort((a, b) => b.confidence - a.confidence);
  
  // Phase 4: Validate phones
  log(colors.cyan, '\n✅ Phase 4: Validation');
  
  for (const mobile of results.consolidated.mobiles.slice(0, 2)) {
    const phoneValidation = await validation.validatePhone(mobile.number);
    results.validation.push({
      number: mobile.number,
      ...phoneValidation,
    });
    if (phoneValidation.valid) {
      log(colors.green, `   ✓ ${mobile.number}: Valid (${phoneValidation.lineType || 'unknown'}, ${phoneValidation.location || 'unknown'})`);
    } else {
      log(colors.yellow, `   ⚠ ${mobile.number}: Could not validate`);
    }
  }
  
  results.metadata.duration_ms = Date.now() - startTime;
  
  return results;
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

function printResults(results) {
  log(colors.bright + colors.white, `\n${'═'.repeat(60)}`);
  log(colors.bright + colors.green, '📋 DISCOVERY RESULTS');
  log(colors.bright + colors.white, `${'═'.repeat(60)}`);
  
  const person = results.input;
  
  log(colors.white, `\n👤 ${colors.bright}${person.firstName} ${person.lastName}${colors.reset}`);
  if (person.title) log(colors.dim, `   Title: ${person.title}`);
  if (person.company) log(colors.dim, `   Company: ${person.company}`);
  if (person.location) log(colors.dim, `   Location: ${person.location}`);
  
  if (results.linkedin) {
    log(colors.blue, `\n🔗 LinkedIn: ${results.linkedin}`);
    if (results.searchInsights?.linkedinSearch) {
      log(colors.dim, `   Confidence: ${Math.round(results.searchInsights.linkedinSearch.confidence * 100)}%`);
    }
  }
  
  if (results.consolidated.emails.length > 0) {
    log(colors.green, '\n📧 Emails:');
    results.consolidated.emails.forEach(e => {
      const sources = e.sources?.join(', ') || e.source;
      const confidence = Math.round((e.confidence || 0) * 100);
      log(colors.white, `   • ${e.email} ${colors.dim}(${sources}, ${confidence}%)${colors.reset}`);
    });
  } else {
    log(colors.yellow, '\n📧 No emails found');
  }
  
  if (results.consolidated.mobiles.length > 0) {
    log(colors.green, '\n📱 Mobile Numbers:');
    results.consolidated.mobiles.forEach(m => {
      const sources = m.sources?.join(', ') || m.source;
      const confidence = Math.round((m.confidence || 0) * 100);
      const validationInfo = results.validation.find(v => v.number === m.number);
      const validIcon = validationInfo?.valid ? '✓' : '';
      log(colors.white, `   • ${m.number} ${colors.dim}(${sources}, ${confidence}%) ${validIcon}${colors.reset}`);
    });
  } else {
    log(colors.yellow, '\n📱 No mobile numbers found');
  }
  
  log(colors.dim, `\n─────────────────────────────────────────────────────────────`);
  
  const firmableStatus = results.sources.firmable ? (results.sources.firmable.error ? '❌' : '✅') : '⚪';
  const lushaStatus = results.sources.lusha?.error ? '❌' : '✅';
  const apolloStatus = results.sources.apollo?.error ? '❌' : '✅';
  
  log(colors.dim, `Sources: Firmable ${firmableStatus} | Lusha ${lushaStatus} | Apollo ${apolloStatus}`);
  log(colors.dim, `Duration: ${results.metadata.duration_ms}ms`);
  log(colors.bright + colors.white, `${'═'.repeat(60)}\n`);
}

function printJsonResults(results) {
  console.log(JSON.stringify(results, null, 2));
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
${colors.bright}Contact Discovery CLI${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node cli.js "Steven Lowy, Principal, LFG, Sydney"
  node cli.js "John Smith" "Acme Corp" "CEO"
  node cli.js --json "Steven Lowy, Principal, LFG"
  node cli.js --batch contacts.txt

${colors.cyan}Options:${colors.reset}
  --json      Output results as JSON
  --batch     Process multiple contacts from a file (one per line)
  --help      Show this help message

${colors.cyan}Input Formats:${colors.reset}
  "John Smith, CEO, Acme Corp, Sydney"    Comma-separated
  "John Smith @ Acme Corp"                @ symbol
  "John Smith (CEO) Acme Corp"            Parentheses for title
  "John Smith"                            Name only

${colors.cyan}API Keys:${colors.reset}
  All API keys are embedded for testing. Override with environment variables:
  SERP_API_KEY, FIRMABLE_API_KEY, LUSHA_API_KEY, APOLLO_API_KEY, NUMVERIFY_API_KEY
`);
    process.exit(0);
  }
  
  const jsonOutput = args.includes('--json');
  const batchMode = args.includes('--batch');
  
  // Filter out flags
  const inputs = args.filter(a => !a.startsWith('--'));
  
  if (batchMode && inputs.length > 0) {
    // Batch mode: read contacts from file
    const filename = inputs[0];
    if (!fs.existsSync(filename)) {
      console.error(`File not found: ${filename}`);
      process.exit(1);
    }
    
    const contacts = fs.readFileSync(filename, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    
    log(colors.bright, `\nProcessing ${contacts.length} contacts from ${filename}\n`);
    
    const allResults = [];
    for (const contact of contacts) {
      const results = await discoverContact(contact);
      allResults.push(results);
      
      if (!jsonOutput) {
        printResults(results);
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 1000));
    }
    
    if (jsonOutput) {
      printJsonResults(allResults);
    }
  } else {
    // Single contact mode
    const input = inputs.length === 1 ? inputs[0] : inputs;
    
    try {
      const results = await discoverContact(input);
      
      if (jsonOutput) {
        printJsonResults(results);
      } else {
        printResults(results);
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }
}

main();
