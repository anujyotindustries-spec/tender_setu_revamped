import { runLiveScraper } from '../services/scraperService';
import { pool } from '../utils/db';

async function main() {
  console.log('--- Starting Standalone Universal Scraper ---');
  let exitCode = 0;
  try {
    const result = await runLiveScraper();
    console.log(`--- Scraper finished: ${result.count} new tenders added ---`);
    // A run where no listing source returned any tenders (portal blocked or
    // layout changed) or every insert failed (e.g. schema out of date) used to
    // end green and look healthy for weeks. Individual flaky portals still
    // don't fail the run; only a total outage does.
    if (result.failed) {
      console.error('--- Scraper FAILED: no listing source returned tenders, or inserts failed. See the run summary above. ---');
      exitCode = 1;
    }
  } catch (err: any) {
    console.error('Scraper encountered an error:', err);
    exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (closeErr: any) {
      console.warn('Pool close warning:', closeErr.message);
    }
    process.exit(exitCode);
  }
}

void main();
