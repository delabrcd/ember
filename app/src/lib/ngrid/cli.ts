// Local test entrypoint: `npm run scrape` (inside the container).
// Runs a full collect + persist and prints a summary.
import { collect } from './collect';
import { persist } from './persist';

(async () => {
  // Env-credential pass (no loginId): scrapes every billing account the login
  // exposes and returns one result each.
  const results = await collect((m) => console.log('[scrape]', m));
  console.log('\n=== summary ===');
  console.log('accounts discovered:', results.length);
  for (const result of results) {
    const summary = await persist(result);
    console.log('account:', result.account.accountNumber, result.account.companyCode, result.account.region);
    console.log('  bills:', result.bills.length, '| usage:', result.usage.length, '| costs:', result.costs.length, '| weather:', result.weather.length);
    console.log('  PDFs downloaded this run:', result.pdfsDownloaded);
    console.log('  DB:', summary.billsTotal, 'bills total,', summary.billsAdded, 'new');
  }
  process.exit(0);
})().catch((e) => {
  console.error('scrape failed:', e);
  process.exit(1);
});
