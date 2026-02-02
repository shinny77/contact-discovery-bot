/**
 * Stats Module - Track API usage and success rates
 */

const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading stats:', e.message); }
  return getDefaultStats();
}

function getDefaultStats() {
  return {
    startedAt: new Date().toISOString(),
    totalRequests: 0,
    byEndpoint: {},
    byDay: {},
    enrichmentStats: {
      total: 0,
      withEmail: 0,
      withPhone: 0,
      withLinkedIn: 0,
    },
    apiCalls: {
      apollo: { calls: 0, errors: 0 },
      firmable: { calls: 0, errors: 0 },
      lusha: { calls: 0, errors: 0 },
      serp: { calls: 0, errors: 0 },
    },
    lastUpdated: new Date().toISOString(),
  };
}

function saveStats(stats) {
  try {
    stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) { console.error('Error saving stats:', e.message); }
}

function trackRequest(endpoint) {
  const stats = loadStats();
  stats.totalRequests++;
  
  // Track by endpoint
  if (!stats.byEndpoint[endpoint]) {
    stats.byEndpoint[endpoint] = 0;
  }
  stats.byEndpoint[endpoint]++;
  
  // Track by day
  const today = new Date().toISOString().split('T')[0];
  if (!stats.byDay[today]) {
    stats.byDay[today] = 0;
  }
  stats.byDay[today]++;
  
  saveStats(stats);
}

function trackEnrichment(result) {
  const stats = loadStats();
  stats.enrichmentStats.total++;
  
  if (result.emails?.length > 0 || result.email) {
    stats.enrichmentStats.withEmail++;
  }
  if (result.phones?.length > 0 || result.phone) {
    stats.enrichmentStats.withPhone++;
  }
  if (result.linkedin) {
    stats.enrichmentStats.withLinkedIn++;
  }
  
  saveStats(stats);
}

function trackApiCall(api, success = true) {
  const stats = loadStats();
  if (!stats.apiCalls[api]) {
    stats.apiCalls[api] = { calls: 0, errors: 0 };
  }
  stats.apiCalls[api].calls++;
  if (!success) {
    stats.apiCalls[api].errors++;
  }
  saveStats(stats);
}

function getStats() {
  const stats = loadStats();
  
  // Calculate derived metrics
  const enrichRate = stats.enrichmentStats.total > 0 
    ? Math.round((stats.enrichmentStats.withEmail / stats.enrichmentStats.total) * 100) 
    : 0;
  
  // Get last 7 days
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    last7Days.push({
      date: key,
      requests: stats.byDay[key] || 0,
    });
  }
  
  // Top endpoints
  const topEndpoints = Object.entries(stats.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([endpoint, count]) => ({ endpoint, count }));
  
  return {
    ...stats,
    derived: {
      emailSuccessRate: enrichRate,
      phoneSuccessRate: stats.enrichmentStats.total > 0 
        ? Math.round((stats.enrichmentStats.withPhone / stats.enrichmentStats.total) * 100) 
        : 0,
      last7Days,
      topEndpoints,
      uptime: getUptime(stats.startedAt),
    },
  };
}

function getUptime(startedAt) {
  const start = new Date(startedAt);
  const now = new Date();
  const diff = now - start;
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resetStats() {
  const stats = getDefaultStats();
  saveStats(stats);
  return stats;
}

module.exports = {
  loadStats,
  saveStats,
  trackRequest,
  trackEnrichment,
  trackApiCall,
  getStats,
  resetStats,
};
