/**
 * Watchlist Module - Job Change Alerts
 * 
 * Tracks contacts and detects when they change roles/companies
 */

const fs = require('fs');
const path = require('path');

const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');

// Load watchlist from file
function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading watchlist:', e.message); }
  return { contacts: [], lastChecked: null };
}

// Save watchlist to file
function saveWatchlist(data) {
  try {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) { 
    console.error('Error saving watchlist:', e.message);
    return false;
  }
}

// Add contact to watchlist
function addToWatchlist(contact) {
  const watchlist = loadWatchlist();
  
  // Check for duplicate
  const existing = watchlist.contacts.find(c => 
    (c.linkedin && c.linkedin === contact.linkedin) ||
    (c.email && c.email === contact.email) ||
    (c.firstName?.toLowerCase() === contact.firstName?.toLowerCase() && 
     c.lastName?.toLowerCase() === contact.lastName?.toLowerCase() &&
     c.company?.toLowerCase() === contact.company?.toLowerCase())
  );
  
  if (existing) {
    return { success: false, error: 'Contact already in watchlist', existing };
  }
  
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    title: contact.title,
    linkedin: contact.linkedin,
    email: contact.email,
    addedAt: new Date().toISOString(),
    lastChecked: null,
    lastTitle: contact.title,
    lastCompany: contact.company,
    changeHistory: [],
  };
  
  watchlist.contacts.push(entry);
  saveWatchlist(watchlist);
  
  return { success: true, contact: entry, total: watchlist.contacts.length };
}

// Remove from watchlist
function removeFromWatchlist(id) {
  const watchlist = loadWatchlist();
  const idx = watchlist.contacts.findIndex(c => c.id === id);
  
  if (idx === -1) {
    return { success: false, error: 'Contact not found' };
  }
  
  const removed = watchlist.contacts.splice(idx, 1)[0];
  saveWatchlist(watchlist);
  
  return { success: true, removed, remaining: watchlist.contacts.length };
}

// Get all watched contacts
function getWatchlist() {
  const watchlist = loadWatchlist();
  return {
    contacts: watchlist.contacts,
    total: watchlist.contacts.length,
    lastChecked: watchlist.lastChecked,
  };
}

// Check a single contact for changes
function checkForChanges(contact, currentData) {
  const changes = [];
  
  // Compare title
  if (currentData.title && contact.lastTitle && 
      currentData.title.toLowerCase() !== contact.lastTitle.toLowerCase()) {
    changes.push({
      type: 'title',
      from: contact.lastTitle,
      to: currentData.title,
    });
  }
  
  // Compare company
  if (currentData.company && contact.lastCompany &&
      currentData.company.toLowerCase() !== contact.lastCompany.toLowerCase()) {
    changes.push({
      type: 'company',
      from: contact.lastCompany,
      to: currentData.company,
    });
  }
  
  return changes;
}

// Update contact with new data
function updateContact(id, newData, changes = []) {
  const watchlist = loadWatchlist();
  const contact = watchlist.contacts.find(c => c.id === id);
  
  if (!contact) return { success: false, error: 'Contact not found' };
  
  // Record changes in history
  if (changes.length > 0) {
    contact.changeHistory.push({
      date: new Date().toISOString(),
      changes: changes,
    });
  }
  
  // Update current data
  if (newData.title) contact.lastTitle = newData.title;
  if (newData.company) contact.lastCompany = newData.company;
  if (newData.linkedin) contact.linkedin = newData.linkedin;
  contact.lastChecked = new Date().toISOString();
  
  saveWatchlist(watchlist);
  return { success: true, contact };
}

// Mark full check completed
function markChecked() {
  const watchlist = loadWatchlist();
  watchlist.lastChecked = new Date().toISOString();
  saveWatchlist(watchlist);
}

// Get contacts with changes
function getContactsWithChanges() {
  const watchlist = loadWatchlist();
  return watchlist.contacts.filter(c => c.changeHistory.length > 0);
}

// Clear all change history
function clearHistory() {
  const watchlist = loadWatchlist();
  watchlist.contacts.forEach(c => { c.changeHistory = []; });
  saveWatchlist(watchlist);
  return { success: true };
}

module.exports = {
  loadWatchlist,
  saveWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  checkForChanges,
  updateContact,
  markChecked,
  getContactsWithChanges,
  clearHistory,
};
