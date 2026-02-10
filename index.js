/**
 * Contact Discovery Slack Bot v2.0
 * 
 * Enhanced with:
 * - Web search enrichment (pre-API intelligence gathering)
 * - Advanced LinkedIn URL discovery (multiple strategies)
 * - Fuzzy name matching
 * - Company domain auto-lookup
 * - Email/phone validation
 * - Redis caching (30-day TTL)
 * - Batch processing
 * 
 * Usage:
 *   /enrich John Smith, CEO, Acme Corp, Sydney
 *   /enrich-batch (with CSV attachment)
 *   @ContactBot Steven Lowy @ LFG
 */

const express = require('express');
const axios = require('axios');
const { WebClient } = require('@slack/web-api');
const Redis = require('ioredis');
const Fuse = require('fuse.js');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  // Slack
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  
  // Data Enrichment APIs
  apis: {
    firmable: {
      apiKey: process.env.FIRMABLE_API_KEY || process.env.FIRMABLE_API_KEY || '',
      baseUrl: 'https://api.firmable.com',
    },
    lusha: {
      apiKey: process.env.LUSHA_API_KEY || process.env.LUSHA_API_KEY || '',
      baseUrl: 'https://api.lusha.com',
    },
    apollo: {
      apiKey: process.env.APOLLO_API_KEY || process.env.APOLLO_API_KEY || '',
      baseUrl: 'https://api.apollo.io',
    },
    // For web search - using SerpAPI
    serp: {
      apiKey: process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '',
      baseUrl: 'https://serpapi.com',
    },
    // Email validation
    hunter: {
      apiKey: process.env.HUNTER_API_KEY || '',
      baseUrl: 'https://api.hunter.io/v2',
    },
    // Phone validation
    numverify: {
      apiKey: process.env.NUMVERIFY_API_KEY || 'd3ae53eca810fb4102116068d0ce4ca3',
      baseUrl: 'http://apilayer.net/api',
    },
  },
  
  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    cacheTTL: 30 * 24 * 60 * 60, // 30 days in seconds
  },
  
  // Server
  port: process.env.PORT || 3000,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

const slackClient = new WebClient(config.slack.botToken);

// Redis client with fallback to in-memory cache
let redis;
let memoryCache = new Map();

try {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
  });
  redis.on('error', (err) => {
    console.warn('Redis error, using memory cache:', err.message);
    redis = null;
  });
} catch (err) {
  console.warn('Redis unavailable, using memory cache');
  redis = null;
}

// ============================================================================
// CACHING LAYER
// ============================================================================

const cache = {
  /**
   * Generate cache key from person data
   */
  generateKey(person) {
    const normalized = `${person.firstName?.toLowerCase()}_${person.lastName?.toLowerCase()}_${person.company?.toLowerCase() || ''}`;
    return `contact:${crypto.createHash('md5').update(normalized).digest('hex')}`;
  },

  /**
   * Get from cache
   */
  async get(key) {
    try {
      if (redis) {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
      } else {
        const cached = memoryCache.get(key);
        if (cached && cached.expiry > Date.now()) {
          return cached.data;
        }
        return null;
      }
    } catch (err) {
      console.error('Cache get error:', err.message);
      return null;
    }
  },

  /**
   * Set in cache
   */
  async set(key, data, ttl = config.redis.cacheTTL) {
    try {
      if (redis) {
        await redis.setex(key, ttl, JSON.stringify(data));
      } else {
        memoryCache.set(key, {
          data,
          expiry: Date.now() + (ttl * 1000),
        });
      }
    } catch (err) {
      console.error('Cache set error:', err.message);
    }
  },

  /**
   * Check if exists
   */
  async exists(key) {
    const data = await this.get(key);
    return data !== null;
  },
};

// ============================================================================
// FUZZY MATCHING & NAME UTILITIES
// ============================================================================

const nameUtils = {
  // Common nickname mappings
  nicknames: {
    'bob': ['robert', 'bobby', 'rob'],
    'robert': ['bob', 'bobby', 'rob'],
    'bill': ['william', 'will', 'billy'],
    'william': ['bill', 'will', 'billy'],
    'mike': ['michael', 'mick', 'mickey'],
    'michael': ['mike', 'mick', 'mickey'],
    'steve': ['steven', 'stephen'],
    'steven': ['steve', 'stephen'],
    'stephen': ['steve', 'steven'],
    'jim': ['james', 'jimmy'],
    'james': ['jim', 'jimmy'],
    'dick': ['richard', 'rick', 'ricky'],
    'richard': ['dick', 'rick', 'ricky'],
    'dave': ['david', 'davey'],
    'david': ['dave', 'davey'],
    'tom': ['thomas', 'tommy'],
    'thomas': ['tom', 'tommy'],
    'joe': ['joseph', 'joey'],
    'joseph': ['joe', 'joey'],
    'dan': ['daniel', 'danny'],
    'daniel': ['dan', 'danny'],
    'tony': ['anthony', 'anton'],
    'anthony': ['tony', 'ant'],
    'chris': ['christopher', 'christoph'],
    'christopher': ['chris', 'christoph'],
    'matt': ['matthew', 'matty'],
    'matthew': ['matt', 'matty'],
    'nick': ['nicholas', 'nicky'],
    'nicholas': ['nick', 'nicky'],
    'alex': ['alexander', 'alexandra', 'alexis'],
    'alexander': ['alex', 'xander'],
    'sam': ['samuel', 'samantha'],
    'samuel': ['sam', 'sammy'],
    'ed': ['edward', 'eddie', 'ted'],
    'edward': ['ed', 'eddie', 'ted'],
    'ben': ['benjamin', 'benny'],
    'benjamin': ['ben', 'benny'],
    'kate': ['katherine', 'kathryn', 'katie', 'kathy'],
    'katherine': ['kate', 'katie', 'kathy'],
    'liz': ['elizabeth', 'beth', 'lizzy'],
    'elizabeth': ['liz', 'beth', 'lizzy'],
    'jen': ['jennifer', 'jenny'],
    'jennifer': ['jen', 'jenny'],
    'meg': ['margaret', 'maggie', 'peggy'],
    'margaret': ['meg', 'maggie', 'peggy'],
  },

  /**
   * Get all name variants for fuzzy matching
   */
  getNameVariants(firstName) {
    const lower = firstName.toLowerCase();
    const variants = new Set([lower]);
    
    // Add nickname variants
    if (this.nicknames[lower]) {
      this.nicknames[lower].forEach(v => variants.add(v));
    }
    
    // Check if this name is a variant of another
    Object.entries(this.nicknames).forEach(([name, nicks]) => {
      if (nicks.includes(lower)) {
        variants.add(name);
        nicks.forEach(n => variants.add(n));
      }
    });
    
    return Array.from(variants);
  },

  /**
   * Fuzzy match score between two names
   */
  fuzzyScore(name1, name2) {
    const n1 = name1.toLowerCase();
    const n2 = name2.toLowerCase();
    
    // Exact match
    if (n1 === n2) return 1.0;
    
    // Check nickname variants
    const variants1 = this.getNameVariants(n1);
    if (variants1.includes(n2)) return 0.95;
    
    // Levenshtein distance for typos
    const distance = this.levenshtein(n1, n2);
    const maxLen = Math.max(n1.length, n2.length);
    const similarity = 1 - (distance / maxLen);
    
    return similarity;
  },

  /**
   * Levenshtein distance
   */
  levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  },

  /**
   * Generate possible email patterns
   */
  generateEmailPatterns(firstName, lastName, domain) {
    const f = firstName.toLowerCase();
    const l = lastName.toLowerCase();
    const fi = f.charAt(0);
    const li = l.charAt(0);
    
    return [
      `${f}.${l}@${domain}`,
      `${f}${l}@${domain}`,
      `${fi}${l}@${domain}`,
      `${f}${li}@${domain}`,
      `${fi}.${l}@${domain}`,
      `${f}_${l}@${domain}`,
      `${l}.${f}@${domain}`,
      `${l}${f}@${domain}`,
      `${f}@${domain}`,
      `${l}@${domain}`,
    ];
  },
};

// ============================================================================
// WEB SEARCH ENRICHMENT (Pre-API Intelligence)
// ============================================================================

const webSearch = {
  /**
   * Search Google for LinkedIn profile using SerpAPI
   */
  async findLinkedInProfile(person) {
    const results = [];
    
    // Build search queries - most specific to least specific
    const queries = [];
    
    // Strategy 1: Exact name + company with site: operator
    if (person.company) {
      queries.push(`site:linkedin.com/in/ "${person.firstName} ${person.lastName}" "${person.company}"`);
      queries.push(`site:linkedin.com/in/ "${person.firstName} ${person.lastName}" ${person.company}`);
    }
    
    // Strategy 2: Name + title + company
    if (person.title && person.company) {
      queries.push(`site:linkedin.com/in/ ${person.firstName} ${person.lastName} ${person.title} ${person.company}`);
    }
    
    // Strategy 3: Just name + company (broader)
    if (person.company) {
      queries.push(`site:linkedin.com/in/ ${person.firstName} ${person.lastName} ${person.company}`);
    }
    
    // Strategy 4: Name variants with company
    const firstNameVariants = nameUtils.getNameVariants(person.firstName);
    firstNameVariants.slice(0, 2).forEach(variant => {
      if (variant !== person.firstName.toLowerCase() && person.company) {
        queries.push(`site:linkedin.com/in/ "${variant} ${person.lastName}" "${person.company}"`);
      }
    });
    
    // Strategy 5: Name + location (if no company)
    if (!person.company && person.location) {
      queries.push(`site:linkedin.com/in/ "${person.firstName} ${person.lastName}" ${person.location}`);
    }
    
    // Strategy 6: Just the name (last resort)
    queries.push(`site:linkedin.com/in/ "${person.firstName} ${person.lastName}"`);

    console.log(`   🔎 LinkedIn search strategies: ${queries.length} queries`);

    // Execute searches (limit to first 3 that return results)
    let successfulSearches = 0;
    for (const query of queries) {
      if (successfulSearches >= 3) break;
      
      try {
        console.log(`      Query: ${query.substring(0, 60)}...`);
        const searchResults = await this.googleSearch(query);
        
        if (searchResults.length > 0) {
          results.push(...searchResults);
          successfulSearches++;
          console.log(`      ✓ Found ${searchResults.length} results`);
        }
        
        // Rate limiting - be nice to the API
        await this.sleep(300);
      } catch (err) {
        console.error('      ✗ Search error:', err.message);
      }
    }

    // Deduplicate and score results
    const scored = this.scoreLinkedInResults(results, person);
    
    if (scored.length > 0) {
      console.log(`   📊 Top LinkedIn match: ${scored[0].url} (${Math.round(scored[0].confidence * 100)}%)`);
    }
    
    return scored.length > 0 ? scored[0] : null;
  },

  /**
   * Search for company domain
   */
  async findCompanyDomain(companyName) {
    try {
      // Try multiple search strategies
      const queries = [
        `"${companyName}" official website`,
        `${companyName} company website`,
        `${companyName} homepage`,
      ];
      
      const allDomains = [];
      
      for (const query of queries.slice(0, 2)) {
        const results = await this.googleSearch(query);
        
        // Extract domains from results
        results.forEach(r => {
          try {
            const url = new URL(r.url);
            let domain = url.hostname.replace('www.', '');
            
            // Skip social media and common sites
            const skipDomains = [
              'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
              'youtube.com', 'wikipedia.org', 'crunchbase.com', 'bloomberg.com',
              'reuters.com', 'forbes.com', 'glassdoor.com', 'indeed.com',
              'zoominfo.com', 'dnb.com', 'google.com', 'bing.com',
            ];
            
            if (!skipDomains.some(skip => domain.includes(skip))) {
              allDomains.push(domain);
            }
          } catch {
            // Invalid URL, skip
          }
        });
        
        await this.sleep(200);
      }
      
      if (allDomains.length === 0) return null;
      
      // Return most common domain (likely the real company site)
      const domainCounts = {};
      allDomains.forEach(d => {
        domainCounts[d] = (domainCounts[d] || 0) + 1;
      });
      
      const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
      
      // Prefer shorter domains and .com/.com.au etc
      const topDomains = sorted.slice(0, 3).map(([d]) => d);
      const preferred = topDomains.find(d => 
        d.endsWith('.com') || d.endsWith('.com.au') || d.endsWith('.co') || d.endsWith('.io')
      );
      
      return preferred || topDomains[0] || null;
    } catch (err) {
      console.error('Domain search error:', err.message);
      return null;
    }
  },

  /**
   * Enrich person data via web search before API calls
   */
  async preEnrich(person) {
    const enriched = { ...person };
    const searchInsights = {
      linkedinCandidates: [],
      possibleDomain: null,
      additionalContext: [],
    };

    console.log(`\n🔎 Web search pre-enrichment for: ${person.firstName} ${person.lastName}`);

    // 1. Find company domain if not provided
    if (person.company && !person.domain) {
      searchInsights.possibleDomain = await this.findCompanyDomain(person.company);
      if (searchInsights.possibleDomain) {
        enriched.domain = searchInsights.possibleDomain;
        console.log(`   ✓ Found domain: ${enriched.domain}`);
      }
    }

    // 2. Search for LinkedIn profile
    const linkedinResult = await this.findLinkedInProfile(person);
    if (linkedinResult) {
      searchInsights.linkedinCandidates.push(linkedinResult);
      enriched.linkedinUrl = linkedinResult.url;
      enriched.linkedinConfidence = linkedinResult.confidence;
      console.log(`   ✓ Found LinkedIn: ${linkedinResult.url} (${Math.round(linkedinResult.confidence * 100)}%)`);
    }

    // 3. Search for additional context (title verification, etc.)
    try {
      const contextQuery = `"${person.firstName} ${person.lastName}" "${person.company}" ${person.title || ''}`;
      const contextResults = await this.googleSearch(contextQuery);
      
      // Extract any title/role mentions
      contextResults.forEach(r => {
        if (r.snippet) {
          searchInsights.additionalContext.push(r.snippet);
        }
      });
    } catch (err) {
      // Non-critical, continue
    }

    return { enriched, searchInsights };
  },

  /**
   * Score LinkedIn results based on match quality
   */
  scoreLinkedInResults(results, person) {
    const scored = [];
    
    results.forEach(result => {
      if (!result.url?.includes('linkedin.com/in/')) return;
      
      let score = 0.5; // Base score for being a LinkedIn profile
      
      // Knowledge graph results are highly trusted
      if (result.fromKnowledgeGraph) {
        score += 0.35;
      }
      
      const title = (result.title || '').toLowerCase();
      const snippet = (result.snippet || '').toLowerCase();
      const url = (result.url || '').toLowerCase();
      const fullName = `${person.firstName} ${person.lastName}`.toLowerCase();
      const company = (person.company || '').toLowerCase();
      
      // Name in title (strong signal)
      if (title.includes(fullName)) {
        score += 0.2;
      } else if (title.includes(person.lastName.toLowerCase())) {
        score += 0.1;
      }
      
      // Name in URL slug (very strong signal)
      const urlSlug = url.split('/in/')[1]?.split('/')[0]?.split('?')[0] || '';
      const nameInUrl = `${person.firstName}${person.lastName}`.toLowerCase().replace(/\s+/g, '');
      const nameWithDash = `${person.firstName}-${person.lastName}`.toLowerCase();
      if (urlSlug.includes(nameWithDash) || urlSlug.replace(/-/g, '').includes(nameInUrl)) {
        score += 0.15;
      }
      
      // Company match (strong signal)
      if (company) {
        if (title.includes(company) || snippet.includes(company)) {
          score += 0.2;
        }
        // Partial company match
        const companyWords = company.split(/\s+/).filter(w => w.length > 2);
        const matchedWords = companyWords.filter(w => 
          title.includes(w) || snippet.includes(w)
        );
        if (matchedWords.length > 0 && matchedWords.length < companyWords.length) {
          score += 0.1;
        }
      }
      
      // Title/role match
      if (person.title) {
        const titleLower = person.title.toLowerCase();
        if (title.includes(titleLower) || snippet.includes(titleLower)) {
          score += 0.1;
        }
        // Partial title match (CEO, CFO, Director, etc.)
        const titleKeywords = ['ceo', 'cfo', 'cto', 'coo', 'director', 'manager', 'founder', 'partner', 'principal', 'vp', 'president'];
        titleKeywords.forEach(keyword => {
          if (titleLower.includes(keyword) && (title.includes(keyword) || snippet.includes(keyword))) {
            score += 0.05;
          }
        });
      }
      
      // Location match
      if (person.location) {
        const locationLower = person.location.toLowerCase();
        const locationParts = locationLower.split(/[,\s]+/).filter(p => p.length > 2);
        locationParts.forEach(part => {
          if (snippet.includes(part) || title.includes(part)) {
            score += 0.03;
          }
        });
      }
      
      // Position bonus (first results are usually better)
      if (result.position && result.position <= 3) {
        score += (4 - result.position) * 0.02;
      }
      
      scored.push({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        confidence: Math.min(score, 1.0),
        nameInSlug: urlSlug.includes(person.firstName.toLowerCase()) || urlSlug.includes(person.lastName.toLowerCase()),
        fromKnowledgeGraph: result.fromKnowledgeGraph || false,
      });
    });
    
    // Filter: require at least first or last name in the LinkedIn slug
    // This prevents false positives (e.g. searching "Shane Hunter" matching "Shane Flaherty")
    const nameFiltered = scored.filter(r => {
      if (r.nameInSlug) return true;
      // Allow knowledge graph results even without slug match (high trust)
      if (r.fromKnowledgeGraph && r.confidence >= 0.8) return true;
      console.log(`   ⚠ LinkedIn rejected (name not in slug): ${r.url}`);
      return false;
    });
    
    // Sort by confidence and deduplicate
    const seen = new Set();
    return nameFiltered
      .sort((a, b) => b.confidence - a.confidence)
      .filter(r => {
        // Normalize URL for deduplication
        const normalizedUrl = r.url.split('?')[0].replace(/\/$/, '').toLowerCase();
        if (seen.has(normalizedUrl)) return false;
        seen.add(normalizedUrl);
        return true;
      });
  },

  /**
   * Google search implementation
   * Uses SerpAPI if available, otherwise falls back to alternative
   */
  async googleSearch(query) {
    // Try SerpAPI first
    if (config.apis.serp.apiKey) {
      return this.serpApiSearch(query);
    }
    
    // Fallback: Try Google Custom Search API
    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
      return this.googleCustomSearch(query);
    }
    
    // Last resort: Basic scraping (not recommended for production)
    console.warn('No search API configured - search disabled');
    return [];
  },

  async serpApiSearch(query, options = {}) {
    try {
      const response = await axios.get(`${config.apis.serp.baseUrl}/search.json`, {
        params: {
          api_key: config.apis.serp.apiKey,
          engine: 'google',
          q: query,
          num: 10,
          gl: options.country || 'au',  // Default to Australia
          hl: 'en',
          // For Australian searches, use Australian Google
          google_domain: options.country === 'us' ? 'google.com' : 'google.com.au',
        },
        timeout: 15000,
      });
      
      const results = [];
      
      // Check knowledge graph for direct LinkedIn link
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
      
      // Parse organic results
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
      console.error('SerpAPI error:', err.response?.data || err.message);
      return [];
    }
  },

  async googleCustomSearch(query) {
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: process.env.GOOGLE_API_KEY,
          cx: process.env.GOOGLE_CSE_ID,
          q: query,
          num: 10,
        },
      });
      
      return (response.data.items || []).map(r => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet,
      }));
    } catch (err) {
      console.error('Google CSE error:', err.message);
      return [];
    }
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
};

// ============================================================================
// EMAIL & PHONE VALIDATION
// ============================================================================

const validation = {
  /**
   * Validate email deliverability
   */
  async validateEmail(email) {
    // Basic format check
    if (!this.isValidEmailFormat(email)) {
      return { valid: false, reason: 'invalid_format', confidence: 0 };
    }

    // Check for disposable domains
    if (this.isDisposableEmail(email)) {
      return { valid: true, reason: 'disposable', confidence: 0.3 };
    }

    // Hunter.io verification (if API key available)
    if (config.apis.hunter.apiKey) {
      try {
        const response = await axios.get(`${config.apis.hunter.baseUrl}/email-verifier`, {
          params: {
            email,
            api_key: config.apis.hunter.apiKey,
          },
        });
        
        const data = response.data.data;
        return {
          valid: data.result === 'deliverable',
          reason: data.result,
          confidence: data.score / 100,
          details: {
            status: data.status,
            disposable: data.disposable,
            webmail: data.webmail,
          },
        };
      } catch (err) {
        console.error('Hunter validation error:', err.message);
      }
    }

    // Fallback: Basic validation only
    return {
      valid: true,
      reason: 'format_valid',
      confidence: 0.6,
    };
  },

  /**
   * Validate phone number using NumVerify
   */
  async validatePhone(phone, countryCode = '') {
    // Clean the number
    const cleaned = phone.replace(/\D/g, '');
    
    // Basic length check
    if (cleaned.length < 8 || cleaned.length > 15) {
      return { valid: false, reason: 'invalid_length', confidence: 0 };
    }

    // NumVerify validation (if API key available)
    if (config.apis.numverify.apiKey) {
      try {
        const params = {
          access_key: config.apis.numverify.apiKey,
          number: cleaned,
          format: 1,
        };
        
        // Only add country_code if provided
        if (countryCode) {
          params.country_code = countryCode;
        }
        
        const response = await axios.get(`${config.apis.numverify.baseUrl}/validate`, {
          params,
          timeout: 10000,
        });
        
        const data = response.data;
        
        // Check for API error
        if (data.error) {
          console.error('NumVerify API error:', data.error);
          return this.fallbackPhoneValidation(cleaned, countryCode);
        }
        
        return {
          valid: data.valid,
          reason: data.valid ? 'verified' : 'invalid',
          confidence: data.valid ? 0.95 : 0,
          details: {
            carrier: data.carrier,
            lineType: data.line_type,
            location: data.location,
            countryCode: data.country_code,
            countryName: data.country_name,
            internationalFormat: data.international_format,
            localFormat: data.local_format,
          },
        };
      } catch (err) {
        console.error('NumVerify validation error:', err.message);
        return this.fallbackPhoneValidation(cleaned, countryCode);
      }
    }

    return this.fallbackPhoneValidation(cleaned, countryCode);
  },

  /**
   * Fallback pattern-based phone validation
   */
  fallbackPhoneValidation(cleaned, countryCode) {
    const patterns = {
      AU: /^(?:\+?61|0)?4\d{8}$/, // Australian mobile
      US: /^(?:\+?1)?[2-9]\d{9}$/, // US
      UK: /^(?:\+?44)?7\d{9}$/, // UK mobile
      NZ: /^(?:\+?64)?2\d{7,9}$/, // New Zealand mobile
    };

    const isValidPattern = patterns[countryCode]?.test(cleaned) || cleaned.length >= 10;
    
    return {
      valid: isValidPattern,
      reason: isValidPattern ? 'pattern_valid' : 'pattern_invalid',
      confidence: isValidPattern ? 0.6 : 0.2,
    };
  },

  isValidEmailFormat(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  isDisposableEmail(email) {
    const disposableDomains = [
      'tempmail.com', 'throwaway.com', 'mailinator.com', 'guerrillamail.com',
      'temp-mail.org', '10minutemail.com', 'fakeinbox.com',
    ];
    const domain = email.split('@')[1]?.toLowerCase();
    return disposableDomains.includes(domain);
  },
};

// ============================================================================
// API SERVICES (Enhanced)
// ============================================================================

const apiServices = {
  /**
   * Firmable API - Australia/NZ focused
   */
  async firmableEnrich(person, linkedinUrl = null) {
    const results = { emails: [], mobiles: [], raw: null, error: null, companyInfo: null };
    
    try {
      // Firmable works best via Company endpoint which includes contact emails & phones
      // Auth: Authorization: Bearer (not x-api-key!)
      const domain = person.domain || `${person.company.toLowerCase().replace(/\s+/g, '')}.com`;
      
      const response = await axios.get(`${config.apis.firmable.baseUrl}/company`, {
        params: { website: domain },
        headers: { 'Authorization': `Bearer ${config.apis.firmable.apiKey}` },
        timeout: 10000,
      });
      
      if (response.data && response.data.id) {
        results.raw = response.data;
        results.companyInfo = {
          name: response.data.name,
          address: response.data.hq_location,
          abn: response.data.industry_codes?.abn,
          linkedin: response.data.linkedin,
        };
        
        // Extract emails that match the person's name
        if (response.data.emails?.length) {
          const firstLower = person.firstName.toLowerCase();
          const lastLower = person.lastName.toLowerCase();
          
          response.data.emails.forEach(email => {
            const emailLower = email.toLowerCase();
            // Check if email likely belongs to this person
            if (emailLower.includes(firstLower) || 
                emailLower.includes(lastLower) ||
                emailLower.includes(firstLower[0] + lastLower) ||
                emailLower.includes(firstLower + '.' + lastLower)) {
              results.emails.push({ email, type: 'work', confidence: 0.95 });
            }
          });
        }
        
        // Company phones (may be direct lines)
        if (response.data.phones?.length) {
          response.data.phones.forEach(phone => {
            results.mobiles.push({ number: phone, type: 'company', confidence: 0.8 });
          });
        }
      }
    } catch (error) {
      results.error = error.response?.data?.error || error.response?.data?.message || error.message;
    }
    
    return results;
  },

  /**
   * Firmable People API - LinkedIn-based individual lookup (v6.9)
   * 
   * Key learning: Firmable /people?ln_url= returns the best AU contact data
   * (direct emails, mobile +61 numbers, seniority, department) but REQUIRES
   * a LinkedIn URL. The /company endpoint only returns company-level data.
   *
   * This method should be called whenever a LinkedIn URL is available,
   * either from web search discovery or from Apollo/other sources.
   */
  async firmablePersonLookup(linkedinUrl) {
    const results = { emails: [], mobiles: [], raw: null, error: null, personInfo: null };
    
    if (!linkedinUrl || !config.apis.firmable.apiKey) return results;
    
    try {
      const response = await axios.get(`${config.apis.firmable.baseUrl}/people`, {
        params: { ln_url: linkedinUrl },
        headers: { 'Authorization': `Bearer ${config.apis.firmable.apiKey}` },
        timeout: 10000,
      });
      
      const data = response.data;
      if (!data || data.error || !data.name) {
        results.error = data?.error || 'No person data returned';
        return results;
      }
      
      results.raw = data;
      results.personInfo = {
        name: data.name,
        headline: data.headline || data.position || '',
        seniority: data.seniority || '',
        department: data.department || '',
        location: Array.isArray(data.location) ? data.location.join(', ') : (data.location || ''),
        company: data.current_company?.name || '',
        linkedin: linkedinUrl,
      };
      
      // Extract work emails
      const workEmails = data.emails?.work || [];
      workEmails.forEach(e => {
        results.emails.push({
          email: e.value || e,
          type: 'work',
          confidence: 0.95,
          source: 'firmable-person',
        });
      });
      
      // Extract personal emails as fallback
      const personalEmails = data.emails?.personal || [];
      personalEmails.forEach(e => {
        results.emails.push({
          email: e.value || e,
          type: 'personal',
          confidence: 0.7,
          source: 'firmable-person',
        });
      });
      
      // Extract phone numbers - prefer AU (+61) numbers
      const phones = data.phones || [];
      phones.forEach(p => {
        const number = p.value || p;
        const isAU = String(number).startsWith('+61') || String(number).startsWith('04');
        results.mobiles.push({
          number: String(number),
          type: isAU ? 'mobile-au' : 'mobile',
          confidence: isAU ? 0.95 : 0.7,
          source: 'firmable-person',
          auVerified: isAU,
        });
      });
      
    } catch (error) {
      results.error = error.response?.data?.error || error.response?.data?.message || error.message;
    }
    
    return results;
  },

  /**
   * Lusha API (Enhanced with domain)
   */
  async lushaEnrich(person) {
    const results = { emails: [], mobiles: [], raw: null, error: null };
    
    try {
      const params = {
        firstName: person.firstName,
        lastName: person.lastName,
        refreshJobInfo: true,
      };
      
      // Prefer domain over company name for better matching
      if (person.domain) {
        params.companyDomain = person.domain;
      } else if (person.company) {
        params.companyName = person.company;
      }
      
      // If we have LinkedIn URL, use it
      if (person.linkedinUrl) {
        params.linkedinUrl = person.linkedinUrl;
      }
      
      const response = await axios.get(`${config.apis.lusha.baseUrl}/v2/person`, {
        params,
        headers: {
          'api_key': config.apis.lusha.apiKey,
        },
        timeout: 10000,
      });
      
      if (response.data?.data) {
        results.raw = response.data.data;
        const data = response.data.data;
        
        if (data.emailAddresses) {
          data.emailAddresses.forEach(e => {
            results.emails.push({
              email: typeof e === 'string' ? e : e.email,
              type: e.type || 'work',
              confidence: 0.85,
            });
          });
        }
        
        if (data.phoneNumbers) {
          data.phoneNumbers.forEach(p => {
            results.mobiles.push({
              number: typeof p === 'string' ? p : p.number,
              type: p.type || 'mobile',
              confidence: 0.8,
            });
          });
        }
      }
    } catch (error) {
      results.error = error.response?.data?.message || error.message;
    }
    
    return results;
  },

  /**
   * Apollo.io API (Enhanced)
   */
  async apolloEnrich(person) {
    const results = { emails: [], mobiles: [], linkedin: null, raw: null, error: null };
    
    try {
      const body = {
        first_name: person.firstName,
        last_name: person.lastName,
        reveal_personal_emails: true,
        reveal_phone_number: true,
      };
      
      // Add domain/company
      if (person.domain) {
        body.domain = person.domain;
      }
      if (person.company) {
        body.organization_name = person.company;
      }
      
      // Add LinkedIn if available
      if (person.linkedinUrl) {
        body.linkedin_url = person.linkedinUrl;
      }
      
      const response = await axios.post(
        `${config.apis.apollo.baseUrl}/api/v1/people/match`,
        body,
        {
          headers: {
            'x-api-key': config.apis.apollo.apiKey,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
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
      }
    } catch (error) {
      results.error = error.response?.data?.message || error.message;
    }
    
    return results;
  },
};

// ============================================================================
// CONTACT DISCOVERY ORCHESTRATOR (Enhanced)
// ============================================================================

async function discoverContact(input, options = {}) {
  const startTime = Date.now();
  
  // Parse input
  let person = parseInput(input);
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 DISCOVERING: ${person.firstName} ${person.lastName} @ ${person.company || 'Unknown'}`);
  console.log(`${'═'.repeat(60)}`);
  
  // Check cache first
  const cacheKey = cache.generateKey(person);
  if (!options.skipCache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      console.log('📦 Cache hit! Returning cached results.');
      cached.metadata.fromCache = true;
      return cached;
    }
  }
  
  // Results structure
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
    validation: {
      emails: [],
      mobiles: [],
    },
    metadata: {
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      fromCache: false,
      searchEnriched: false,
    },
  };
  
  // Default to Australia if no location specified
  if (!person.location) {
    person.location = 'Australia';
    console.log('   📍 Defaulting to Australia (no location specified)');
  }
  
  // Step 1: Web search pre-enrichment (using Australian Google)
  console.log('\n📡 Phase 1: Web Search Pre-Enrichment');
  const { enriched, searchInsights } = await webSearch.preEnrich(person);
  person = enriched;
  results.searchInsights = searchInsights;
  results.linkedin = enriched.linkedinUrl || null;
  results.metadata.searchEnriched = true;
  
  // Step 2: Run API calls in parallel
  console.log('\n📡 Phase 2: API Enrichment');
  const [apolloResult, lushaResult] = await Promise.all([
    apiServices.apolloEnrich(person),
    apiServices.lushaEnrich(person),
  ]);
  
  results.sources.apollo = apolloResult;
  results.sources.lusha = lushaResult;
  
  // Update LinkedIn from Apollo if not found via search
  if (!results.linkedin && apolloResult.linkedin) {
    results.linkedin = apolloResult.linkedin;
  }
  
  // Step 3: Firmable for AU/NZ (default to running since we assume Australia)
  const isAUNZ = person.location?.toLowerCase().match(/australia|au|new zealand|nz|sydney|melbourne|brisbane|perth|adelaide|auckland|wellington|hobart|canberra|gold coast|newcastle/i);
  if (isAUNZ || !person.location) {
    console.log('   📡 Firmable: AU/NZ contact detected');
    
    // 3a: Company-level lookup (domain-based, returns company info + matching emails)
    results.sources.firmable = await apiServices.firmableEnrich(person, results.linkedin);
    
    // 3b: Person-level lookup via LinkedIn URL (returns direct email + mobile)
    // Key insight: Firmable /people?ln_url= is the best source for AU mobile numbers
    // but requires a LinkedIn URL. Web search discovery or Apollo may have found one.
    if (results.linkedin) {
      console.log('   📡 Firmable Person: querying via LinkedIn URL');
      const firmablePerson = await apiServices.firmablePersonLookup(results.linkedin);
      
      if (firmablePerson && !firmablePerson.error) {
        // Merge person-level data into firmable results
        if (!results.sources.firmable) results.sources.firmable = { emails: [], mobiles: [], raw: null, error: null };
        
        // Add person emails (higher quality than company-level matches)
        firmablePerson.emails?.forEach(e => {
          if (!results.sources.firmable.emails.some(existing => existing.email?.toLowerCase() === e.email?.toLowerCase())) {
            results.sources.firmable.emails.push(e);
          }
        });
        
        // Add person mobiles (direct lines, not company switchboard)
        firmablePerson.mobiles?.forEach(m => {
          if (!results.sources.firmable.mobiles.some(existing => existing.number?.replace(/\D/g, '') === m.number?.replace(/\D/g, ''))) {
            results.sources.firmable.mobiles.push(m);
          }
        });
        
        // Store person info for context
        results.sources.firmable.personInfo = firmablePerson.personInfo;
        
        console.log(`   ✓ Firmable Person: ${firmablePerson.emails?.length || 0} emails, ${firmablePerson.mobiles?.length || 0} mobiles`);
      } else {
        console.log(`   ✗ Firmable Person: ${firmablePerson?.error || 'no match'}`);
      }
    } else {
      console.log('   ⚠ Firmable Person: skipped (no LinkedIn URL available)');
    }
  }
  
  // Step 4: Consolidate and deduplicate
  console.log('\n📊 Phase 3: Consolidating Results');
  const allEmails = [];
  const allMobiles = [];
  
  // Include all sources
  ['firmable', 'lusha', 'apollo'].forEach(source => {
    const sourceData = results.sources[source];
    if (sourceData) {
      sourceData.emails?.forEach(e => allEmails.push({ ...e, source }));
      sourceData.mobiles?.forEach(m => allMobiles.push({ ...m, source }));
    }
  });
  
  // Deduplicate and boost confidence for cross-source matches
  const emailCounts = {};
  allEmails.forEach(e => {
    const key = e.email?.toLowerCase();
    if (!key) return;
    if (!emailCounts[key]) {
      emailCounts[key] = { ...e, sources: [e.source], count: 1 };
    } else {
      emailCounts[key].count++;
      emailCounts[key].sources.push(e.source);
      // Boost confidence for multi-source verification
      emailCounts[key].confidence = Math.min(emailCounts[key].confidence + 0.1, 1.0);
    }
  });
  
  results.consolidated.emails = Object.values(emailCounts)
    .sort((a, b) => b.confidence - a.confidence);
  
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
  
  // Flag non-AU numbers when contact is expected to be Australian
  // Lusha sometimes returns stale UK/US numbers for AU-based contacts
  if (isAUNZ) {
    Object.values(mobileCounts).forEach(m => {
      const num = m.number || '';
      const isAU = num.startsWith('+61') || num.startsWith('04') || num.startsWith('61');
      const isNZ = num.startsWith('+64') || num.startsWith('64');
      if (!isAU && !isNZ) {
        m.confidence = Math.max(m.confidence - 0.3, 0.1);
        m.nonAUFlag = true;
        console.log(`   ⚠ Non-AU mobile flagged (confidence reduced): ${num}`);
      }
    });
  }
  
  results.consolidated.mobiles = Object.values(mobileCounts)
    .sort((a, b) => b.confidence - a.confidence);
  
  // Step 5: Validate top results
  console.log('\n✅ Phase 4: Validation');
  if (results.consolidated.emails.length > 0) {
    const topEmail = results.consolidated.emails[0];
    const emailValidation = await validation.validateEmail(topEmail.email);
    results.validation.emails.push({
      email: topEmail.email,
      ...emailValidation,
    });
    // Update confidence based on validation
    if (emailValidation.valid) {
      topEmail.validated = true;
      topEmail.confidence = Math.min(topEmail.confidence + 0.1, 1.0);
    }
  }
  
  if (results.consolidated.mobiles.length > 0) {
    const topMobile = results.consolidated.mobiles[0];
    // Determine country code from location or number prefix
    let countryCode = '';
    if (isAUNZ) {
      countryCode = person.location?.toLowerCase().includes('zealand') ? 'NZ' : 'AU';
    } else if (topMobile.number?.startsWith('+1') || topMobile.number?.startsWith('1')) {
      countryCode = 'US';
    } else if (topMobile.number?.startsWith('+44')) {
      countryCode = 'GB';
    }
    
    const phoneValidation = await validation.validatePhone(topMobile.number, countryCode);
    results.validation.mobiles.push({
      number: topMobile.number,
      ...phoneValidation,
    });
    if (phoneValidation.valid) {
      topMobile.validated = true;
      topMobile.validatedDetails = phoneValidation.details;
      topMobile.confidence = Math.min(topMobile.confidence + 0.1, 1.0);
    }
  }
  
  // Finalize
  results.metadata.duration_ms = Date.now() - startTime;
  
  // Cache results
  await cache.set(cacheKey, results);
  
  console.log(`\n✨ Discovery complete in ${results.metadata.duration_ms}ms`);
  console.log(`   Emails: ${results.consolidated.emails.length}`);
  console.log(`   Mobiles: ${results.consolidated.mobiles.length}`);
  console.log(`   LinkedIn: ${results.linkedin || 'Not found'}`);
  
  return results;
}

/**
 * Batch discovery
 */
async function discoverBatch(contacts, options = {}) {
  const results = {
    total: contacts.length,
    processed: 0,
    successful: 0,
    failed: 0,
    results: [],
    errors: [],
    metadata: {
      startTime: new Date().toISOString(),
      endTime: null,
      duration_ms: 0,
    },
  };
  
  const startTime = Date.now();
  const concurrency = options.concurrency || 3;
  
  console.log(`\n🚀 Starting batch discovery for ${contacts.length} contacts (concurrency: ${concurrency})`);
  
  // Process in batches
  for (let i = 0; i < contacts.length; i += concurrency) {
    const batch = contacts.slice(i, i + concurrency);
    
    const batchResults = await Promise.allSettled(
      batch.map(contact => discoverContact(contact, { skipCache: options.skipCache }))
    );
    
    batchResults.forEach((result, idx) => {
      results.processed++;
      
      if (result.status === 'fulfilled') {
        results.successful++;
        results.results.push(result.value);
      } else {
        results.failed++;
        results.errors.push({
          contact: batch[idx],
          error: result.reason?.message || 'Unknown error',
        });
      }
    });
    
    // Progress update
    console.log(`   Progress: ${results.processed}/${results.total}`);
    
    // Rate limiting between batches
    if (i + concurrency < contacts.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  results.metadata.endTime = new Date().toISOString();
  results.metadata.duration_ms = Date.now() - startTime;
  
  console.log(`\n✨ Batch complete: ${results.successful} successful, ${results.failed} failed`);
  
  return results;
}

/**
 * Parse input string
 */
function parseInput(input) {
  const person = {
    firstName: '',
    lastName: '',
    title: '',
    company: '',
    location: '',
    domain: '',
    linkedinUrl: '',
  };
  
  let cleanInput = input.trim();
  
  // Check for LinkedIn URL in input
  const linkedinMatch = cleanInput.match(/(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s,]+)/i);
  if (linkedinMatch) {
    person.linkedinUrl = linkedinMatch[1];
    cleanInput = cleanInput.replace(linkedinMatch[0], '').trim();
  }
  
  // Comma-separated format
  if (cleanInput.includes(',')) {
    const parts = cleanInput.split(',').map(p => p.trim());
    
    if (parts[0]) {
      const nameParts = parts[0].split(' ');
      person.firstName = nameParts[0] || '';
      person.lastName = nameParts.slice(1).join(' ') || '';
    }
    if (parts[1]) person.title = parts[1];
    if (parts[2]) person.company = parts[2];
    if (parts[3]) person.location = parts[3];
  }
  // "@" or "at" format
  else if (cleanInput.includes('@') || cleanInput.toLowerCase().includes(' at ')) {
    const separator = cleanInput.includes('@') ? '@' : / at /i;
    const [namePart, companyPart] = cleanInput.split(separator).map(p => p.trim());
    
    if (namePart) {
      const titleMatch = namePart.match(/(.+?)\s*\((.+?)\)/);
      if (titleMatch) {
        const nameParts = titleMatch[1].trim().split(' ');
        person.firstName = nameParts[0] || '';
        person.lastName = nameParts.slice(1).join(' ') || '';
        person.title = titleMatch[2];
      } else {
        const nameParts = namePart.split(' ');
        person.firstName = nameParts[0] || '';
        person.lastName = nameParts.slice(1).join(' ') || '';
      }
    }
    if (companyPart) person.company = companyPart;
  }
  // Simple name
  else {
    const nameParts = cleanInput.split(' ');
    person.firstName = nameParts[0] || '';
    person.lastName = nameParts.slice(1).join(' ') || '';
  }
  
  return person;
}

// ============================================================================
// SLACK MESSAGE FORMATTERS
// ============================================================================

function formatSlackMessage(results) {
  const person = results.input;
  const hasEmails = results.consolidated.emails.length > 0;
  const hasMobiles = results.consolidated.mobiles.length > 0;
  const hasLinkedIn = !!results.linkedin;
  
  // Confidence calculation
  let confidence = 'low';
  let confidenceEmoji = '🔴';
  if (hasEmails && hasMobiles && hasLinkedIn) {
    confidence = 'high';
    confidenceEmoji = '🟢';
  } else if ((hasEmails && hasMobiles) || (hasLinkedIn && (hasEmails || hasMobiles))) {
    confidence = 'medium';
    confidenceEmoji = '🟡';
  }
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📋 Contact Discovery: ${person.firstName} ${person.lastName}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Company:*\n${person.company || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Title:*\n${person.title || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Location:*\n${person.location || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Confidence:*\n${confidenceEmoji} ${confidence.toUpperCase()}` },
      ],
    },
    { type: 'divider' },
  ];
  
  // LinkedIn
  if (hasLinkedIn) {
    const linkedinConfidence = results.input.linkedinConfidence 
      ? ` _(${Math.round(results.input.linkedinConfidence * 100)}% match)_`
      : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔗 LinkedIn:*\n<${results.linkedin}|${results.linkedin}>${linkedinConfidence}`,
      },
    });
  }
  
  // Emails
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📧 Emails:*' },
  });
  
  if (hasEmails) {
    const emailText = results.consolidated.emails
      .slice(0, 5)
      .map(e => {
        const validated = e.validated ? ' ✓' : '';
        const sources = e.sources ? e.sources.join(', ') : e.source;
        return `• \`${e.email}\` _(${sources}, ${Math.round(e.confidence * 100)}%)${validated}_`;
      })
      .join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: emailText } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No emails found_' } });
  }
  
  // Mobiles
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📱 Mobile Numbers:*' },
  });
  
  if (hasMobiles) {
    const mobileText = results.consolidated.mobiles
      .slice(0, 5)
      .map(m => {
        const validated = m.validated ? ' ✓' : '';
        const sources = m.sources ? m.sources.join(', ') : m.source;
        // Show carrier/type if validated
        let details = '';
        if (m.validatedDetails?.carrier) {
          details = ` _${m.validatedDetails.carrier}_`;
        }
        if (m.validatedDetails?.internationalFormat) {
          return `• \`${m.validatedDetails.internationalFormat}\` _(${sources}, ${Math.round(m.confidence * 100)}%)${validated}${details}_`;
        }
        return `• \`${m.number}\` _(${sources}, ${Math.round(m.confidence * 100)}%)${validated}${details}_`;
      })
      .join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mobileText } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No mobile numbers found_' } });
  }
  
  // Footer
  const cacheNote = results.metadata.fromCache ? ' (cached)' : '';
  const searchNote = results.metadata.searchEnriched ? ' 🔎' : '';
  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*Sources:* Firmable ${results.sources.firmable ? (results.sources.firmable?.error ? '❌' : '✅') : '⚪'} | Lusha ${results.sources.lusha?.error ? '❌' : '✅'} | Apollo ${results.sources.apollo?.error ? '❌' : '✅'}${searchNote} | ⏱️ ${results.metadata.duration_ms}ms${cacheNote}`,
      }],
    }
  );
  
  return { blocks };
}

function formatBatchSlackMessage(results) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 Batch Discovery Complete`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total:*\n${results.total}` },
        { type: 'mrkdwn', text: `*Successful:*\n${results.successful}` },
        { type: 'mrkdwn', text: `*Failed:*\n${results.failed}` },
        { type: 'mrkdwn', text: `*Duration:*\n${Math.round(results.metadata.duration_ms / 1000)}s` },
      ],
    },
    { type: 'divider' },
  ];
  
  // Summary of results
  const withEmails = results.results.filter(r => r.consolidated.emails.length > 0).length;
  const withMobiles = results.results.filter(r => r.consolidated.mobiles.length > 0).length;
  const withLinkedIn = results.results.filter(r => r.linkedin).length;
  
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Results Summary:*\n• ${withEmails} contacts with emails\n• ${withMobiles} contacts with mobiles\n• ${withLinkedIn} contacts with LinkedIn`,
    },
  });
  
  // List first few results
  if (results.results.length > 0) {
    blocks.push({ type: 'divider' });
    const preview = results.results.slice(0, 5).map(r => {
      const name = `${r.input.firstName} ${r.input.lastName}`;
      const email = r.consolidated.emails[0]?.email || 'no email';
      return `• *${name}*: ${email}`;
    }).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Preview (first 5):*\n${preview}` },
    });
  }
  
  return { blocks };
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    cache: redis ? 'redis' : 'memory',
    timestamp: new Date().toISOString(),
  });
});

// Single contact slash command
app.post('/slack/commands', async (req, res) => {
  const { command, text, user_id, response_url } = req.body;
  
  console.log(`\n📥 Command from ${user_id}: ${command} ${text}`);
  
  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching for: ${text}...\n_Using web search + API enrichment_`,
  });
  
  try {
    const results = await discoverContact(text);
    const message = formatSlackMessage(results);
    
    await axios.post(response_url, {
      response_type: 'in_channel',
      ...message,
    });
  } catch (error) {
    console.error('Discovery error:', error);
    await axios.post(response_url, {
      response_type: 'ephemeral',
      text: `❌ Error: ${error.message}`,
    });
  }
});

// Batch processing slash command
app.post('/slack/commands/batch', async (req, res) => {
  const { text, user_id, response_url } = req.body;
  
  console.log(`\n📥 Batch command from ${user_id}`);
  
  // Parse batch input (newline or semicolon separated)
  const contacts = text
    .split(/[;\n]/)
    .map(c => c.trim())
    .filter(c => c.length > 0);
  
  if (contacts.length === 0) {
    return res.json({
      response_type: 'ephemeral',
      text: '❌ No contacts provided. Use format:\n`/enrich-batch John Smith, CEO, Acme; Jane Doe, CFO, TechCorp`',
    });
  }
  
  if (contacts.length > 50) {
    return res.json({
      response_type: 'ephemeral',
      text: '❌ Maximum 50 contacts per batch.',
    });
  }
  
  res.json({
    response_type: 'ephemeral',
    text: `🚀 Processing batch of ${contacts.length} contacts...\n_This may take a few minutes_`,
  });
  
  try {
    const results = await discoverBatch(contacts);
    const message = formatBatchSlackMessage(results);
    
    await axios.post(response_url, {
      response_type: 'in_channel',
      ...message,
    });
  } catch (error) {
    console.error('Batch error:', error);
    await axios.post(response_url, {
      response_type: 'ephemeral',
      text: `❌ Batch error: ${error.message}`,
    });
  }
});

// Events handler
app.post('/slack/events', async (req, res) => {
  const { type, challenge, event } = req.body;
  
  if (type === 'url_verification') {
    return res.json({ challenge });
  }
  
  res.status(200).send();
  
  if (event?.type === 'app_mention') {
    const { text, channel } = event;
    const query = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    if (!query) {
      await slackClient.chat.postMessage({
        channel,
        text: 'Please provide a contact. Example:\n`@ContactBot John Smith, CEO, Acme Corp`\n\nOr for batch:\n`@ContactBot batch: John Smith, CEO, Acme; Jane Doe, CFO, Tech`',
      });
      return;
    }
    
    // Check for batch request
    if (query.toLowerCase().startsWith('batch:')) {
      const contacts = query.substring(6).split(/[;\n]/).map(c => c.trim()).filter(c => c);
      
      const searchingMsg = await slackClient.chat.postMessage({
        channel,
        text: `🚀 Processing batch of ${contacts.length} contacts...`,
      });
      
      try {
        const results = await discoverBatch(contacts);
        const message = formatBatchSlackMessage(results);
        await slackClient.chat.update({ channel, ts: searchingMsg.ts, ...message });
      } catch (error) {
        await slackClient.chat.update({
          channel,
          ts: searchingMsg.ts,
          text: `❌ Error: ${error.message}`,
        });
      }
    } else {
      // Single contact
      const searchingMsg = await slackClient.chat.postMessage({
        channel,
        text: `🔍 Searching for: ${query}...`,
      });
      
      try {
        const results = await discoverContact(query);
        const message = formatSlackMessage(results);
        await slackClient.chat.update({ channel, ts: searchingMsg.ts, ...message });
      } catch (error) {
        await slackClient.chat.update({
          channel,
          ts: searchingMsg.ts,
          text: `❌ Error: ${error.message}`,
        });
      }
    }
  }
});

// Direct API endpoints
app.post('/api/discover', async (req, res) => {
  const { query, skipCache } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }
  
  try {
    const results = await discoverContact(query, { skipCache });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/discover/batch', async (req, res) => {
  const { contacts, skipCache, concurrency } = req.body;
  
  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'Missing contacts array' });
  }
  
  try {
    const results = await discoverBatch(contacts, { skipCache, concurrency });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cache management
app.delete('/api/cache/:key', async (req, res) => {
  const { key } = req.params;
  try {
    if (redis) {
      await redis.del(key);
    } else {
      memoryCache.delete(key);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cache/stats', async (req, res) => {
  try {
    if (redis) {
      const info = await redis.info('memory');
      res.json({ type: 'redis', info });
    } else {
      res.json({ type: 'memory', size: memoryCache.size });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(config.port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║           CONTACT DISCOVERY BOT v2.1                             ║
╠═══════════════════════════════════════════════════════════════════╣
║  🆕 ENHANCEMENTS:                                                ║
║    • Web search pre-enrichment                                   ║
║    • Advanced LinkedIn URL discovery                             ║
║    • Fuzzy name matching (nicknames, typos)                      ║
║    • Company domain auto-lookup                                  ║
║    • Email/phone validation                                      ║
║    • Redis caching (30-day TTL)                                  ║
║    • Batch processing                                            ║
║                                                                   ║
║  Server: http://localhost:${config.port}                               ║
║  Cache: ${redis ? 'Redis' : 'Memory'}                                            ║
║                                                                   ║
║  Endpoints:                                                       ║
║    POST /slack/commands        - Single contact                   ║
║    POST /slack/commands/batch  - Batch processing                 ║
║    POST /slack/events          - @mentions                        ║
║    POST /api/discover          - Direct API                       ║
║    POST /api/discover/batch    - Direct batch API                 ║
║    GET  /api/cache/stats       - Cache statistics                 ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = {
  app,
  discoverContact,
  discoverBatch,
  parseInput,
  nameUtils,
  webSearch,
  validation,
  cache,
};
