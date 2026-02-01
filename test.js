/**
 * Test script for Contact Discovery Bot
 * 
 * Run: node test.js
 */

require('dotenv').config();
const { discoverContact, parseInput } = require('./index');

// Test cases
const testCases = [
  'Steven Lowy, Principal, LFG, Sydney Australia',
  'John Smith @ Acme Corp',
  'Jane Doe (CFO) at TechCorp',
  'Michael Johnson, CEO, Example Inc',
  'Sarah Williams',
];

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CONTACT DISCOVERY BOT - TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Test parsing
  console.log('📝 PARSING TESTS\n');
  testCases.forEach((input, i) => {
    const parsed = parseInput(input);
    console.log(`${i + 1}. Input: "${input}"`);
    console.log(`   Parsed:`, parsed);
    console.log();
  });

  // Test discovery (requires API access)
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  LIVE DISCOVERY TESTS (requires API access)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Only run if explicitly requested
  if (process.argv.includes('--live')) {
    for (const testCase of testCases.slice(0, 2)) {
      console.log(`\n🔍 Testing: "${testCase}"\n`);
      try {
        const results = await discoverContact(testCase);
        console.log('Results:');
        console.log(JSON.stringify(results, null, 2));
      } catch (error) {
        console.log(`Error: ${error.message}`);
      }
      console.log('\n' + '─'.repeat(60));
    }
  } else {
    console.log('Skipping live tests. Run with --live flag to test APIs:');
    console.log('  node test.js --live\n');
  }
}

runTests().catch(console.error);
