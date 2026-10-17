import axios from 'axios';
import * as cheerio from 'cheerio';
import { pool, query } from '../utils/db';
import { scoreTenderAgainstCompanies } from './matchingService';
import { extractTenderData, parseLocalTenderData } from './extractionService';
import { getGeminiUsageStats } from './geminiService';

const SCRAPER_ADVISORY_LOCK = 82507421;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Listing sources (primary) ──────────────────────────────────────────────
// The Central Public Procurement Portal and its GeM mirror publish every
// active central/state tender as a server-rendered, newest-first table, so a
// plain HTTP fetch is enough: no headless browser, and closing dates come
// straight from the table instead of being guessed from free text.

interface ListingSource {
  name: string;
  pageUrl: (page: number) => string;
}

const CPPP_BASE = 'https://eprocure.gov.in/cppp/latestactivetendersnew/cpppdata';

const LISTING_SOURCES: ListingSource[] = [
  {
    name: 'eProcure CPPP',
    // CPPP only paginates through a base64-encoded `url` parameter.
    pageUrl: (page) =>
      page === 1
        ? CPPP_BASE
        : `${CPPP_BASE}?url=${encodeURIComponent(Buffer.from(`${CPPP_BASE}?page=${page}`).toString('base64'))}`,
  },
  {
    name: 'GeM CPPP',
    pageUrl: (page) => (page === 1 ? 'https://gem.gov.in/cppp' : `https://gem.gov.in/cppp/${page}`),
  },
];

const FULL_RUN_MAX_PAGES = 100;   // ~1,000 tenders per source per scheduled run
const QUICK_RUN_MAX_PAGES = 3;    // manual "Refresh" from the dashboard
const QUICK_RUN_BUDGET_MS = 40_000; // must fit inside the 60s serverless limit
const KNOWN_PAGES_BEFORE_STOP = 2; // listings are newest-first, so stop once we reach tenders we already hold
const MAX_CONSECUTIVE_INSERT_ERRORS = 5;

// ─── Secondary portals (static HTML) ────────────────────────────────────────
// Only portals verified on 2026-10-17 to return real tender rows over plain
// HTTP are listed. The previous registry also held ~20 portals that 404, sit
// behind a captcha/JS search form (all NIC GePNIC state portals), or return
// bot-block and nav-menu text that was being ingested as "tenders".

interface PortalConfig {
  name: string;
  url: string;
  rowSelector: string;
  maxItems: number;
}

const PORTAL_REGISTRY: PortalConfig[] = [
  { name: 'AIIMS Delhi', url: 'https://www.aiims.edu/index.php/en/tenders/aiims-tender', rowSelector: 'table tr',               maxItems: 40 },
  { name: 'IIT Delhi',   url: 'https://home.iitd.ac.in/tenders.php',                     rowSelector: 'a[href*="/tenders/"]',   maxItems: 30 },
  { name: 'C-DAC',       url: 'https://www.cdac.in/index.aspx?id=tenders',               rowSelector: 'a[href*="tenders_details"]', maxItems: 30 },
  // Unreachable from the verification machine (connection reset); kept in case it was transient.
  { name: 'HAL',         url: 'https://hal-india.co.in/Tender/tenderdetail',             rowSelector: 'table tr, li a, .tender', maxItems: 30 },
  { name: 'IIT Bombay',  url: 'https://www.iitb.ac.in/newacadhome/tenders.jsp',          rowSelector: 'table tr, li a',         maxItems: 30 },
];

export interface SourceResult {
  name: string;
  fetched: number;
  added: number;
  insertErrors: number;
  error?: string;
}

export interface ScrapeOptions {
  quick?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function isAlreadyIngested(snippet: string): Promise<boolean> {
  if (!snippet || snippet.length < 10) return true;
  const res = await query(
    `SELECT id FROM tenders WHERE LOWER(title) LIKE $1 LIMIT 1`,
    [`%${snippet.substring(0, 50).toLowerCase()}%`]
  );
  return res.rows.length > 0;
}

async function ingestRawText(rawText: string, source: string, url?: string): Promise<boolean> {
  try {
    const result = await extractTenderData(rawText, source, 'live_scraped');
    if (result.success && result.tender && !result.duplicate) {
      if (url) {
        await query('UPDATE tenders SET url = $1 WHERE id = $2', [url, result.tender.id]).catch(() => {});
      }
      await scoreTenderAgainstCompanies(result.tender.id).catch(console.error);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error(`[Ingestion] Error processing from ${source}:`, err.message);
    return false;
  }
}

async function fetchHtml(url: string, attempts = 3): Promise<string> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data } = await axios.get<string>(url, {
        timeout: 25000,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      return data;
    } catch (err: any) {
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}

// ─── Listing scraper (CPPP + GeM) ───────────────────────────────────────────

interface ListedTender {
  title: string;
  organisation: string;
  publishedAt: string;
  closingAt: string;
  url: string;
}

// Columns are located by header text, not position, because CPPP and its GeM
// mirror order them differently.
export function parseListingTable(html: string, pageUrl: string): ListedTender[] {
  const $ = cheerio.load(html);
  const listed: ListedTender[] = [];

  $('table').each((_t, table) => {
    const headers = $(table)
      .find('thead th')
      .map((_i, th) => $(th).text().replace(/\s+/g, ' ').trim().toLowerCase())
      .get();
    const titleCol = headers.findIndex((h) => h.startsWith('title'));
    if (titleCol < 0) return;
    const col = (pattern: RegExp) => headers.findIndex((h) => pattern.test(h));
    const closingCol = col(/closing/);
    const publishedCol = col(/published/);
    const organisationCol = col(/organisation/);

    $(table).find('tbody tr').each((_r, tr) => {
      const cells = $(tr).children('td');
      const text = (i: number) => (i >= 0 ? $(cells[i]).text().replace(/\s+/g, ' ').trim() : '');
      const title = text(titleCol);
      if (!title) return;
      const href = $(cells[titleCol]).find('a').first().attr('href');
      let url = pageUrl;
      if (href) {
        try { url = new URL(href, pageUrl).toString(); } catch { /* keep the listing URL */ }
      }
      listed.push({
        title,
        organisation: text(organisationCol),
        publishedAt: text(publishedCol),
        closingAt: text(closingCol),
        url,
      });
    });
  });

  return listed;
}

async function findKnownTenders(rows: ListedTender[]): Promise<{ urls: Set<string>; titles: Set<string> }> {
  const res = await query(
    `SELECT url, LOWER(title) AS title FROM tenders WHERE url = ANY($1::text[]) OR LOWER(title) = ANY($2::text[])`,
    [rows.map((r) => r.url), rows.map((r) => r.title.toLowerCase())],
  );
  return {
    urls: new Set(res.rows.map((r: any) => r.url).filter(Boolean)),
    titles: new Set(res.rows.map((r: any) => r.title)),
  };
}

// Returns true when a tender was inserted. The title already carries the
// tender reference/id, so an exact title or URL match is a true duplicate —
// unlike the fuzzy prefix match used for free-text rows, which silently drops
// distinct tenders that merely start with the same words.
async function insertListedTender(row: ListedTender, source: string): Promise<boolean> {
  const rawText = [
    `Title & ID: ${row.title}`,
    `Organisation: ${row.organisation}`,
    `Closing Date: ${row.closingAt}`,
    `Published Date: ${row.publishedAt}`,
    `Portal URL: ${row.url}`,
  ].join('\n');

  // Classification only; the structured columns override the guessed fields.
  const parsed = parseLocalTenderData(rawText.replace(/\nPortal URL:.*$/, ''), source);
  const deadline = parsed.deadline;
  if (deadline && new Date(deadline).getTime() < Date.now()) return false; // already closed

  const inserted = await query(
    `INSERT INTO tenders (title, source, sector, value, deadline, eligibility, certifications, personnel_requirements, state, district, authority_type, raw_text, confidence_score, url, source_status, needs_manual_review)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      row.title, source, parsed.sector, parsed.value, deadline, parsed.eligibility, parsed.certifications,
      parsed.personnel_requirements, parsed.state, parsed.district, parsed.authority_type, rawText,
      parsed.confidence_score, row.url,
      deadline ? 'live_scraped' : 'needs_review',
      !deadline,
    ],
  );
  await scoreTenderAgainstCompanies(inserted.rows[0].id).catch(console.error);
  return true;
}

async function scrapeListingSource(source: ListingSource, maxPages: number, stopAt: number): Promise<SourceResult> {
  const result: SourceResult = { name: source.name, fetched: 0, added: 0, insertErrors: 0 };
  console.log(`\n[Listing] Scraping ${source.name}...`);

  let knownPagesInARow = 0;
  let consecutiveInsertErrors = 0;

  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() > stopAt) {
      console.log(`[Listing] ${source.name}: time budget reached at page ${page}.`);
      break;
    }

    let rows: ListedTender[];
    try {
      rows = parseListingTable(await fetchHtml(source.pageUrl(page)), source.pageUrl(page));
    } catch (err: any) {
      result.error = `page ${page}: ${err.message}`;
      console.error(`[Listing] ❌ ${source.name} ${result.error}`);
      break;
    }
    if (rows.length === 0) {
      if (page === 1) {
        result.error = 'page 1 returned no tender rows (blocked, or the page layout changed)';
        console.error(`[Listing] ❌ ${source.name} ${result.error}`);
      }
      break;
    }
    result.fetched += rows.length;

    const known = await findKnownTenders(rows);
    const fresh = rows.filter((r) => !known.urls.has(r.url) && !known.titles.has(r.title.toLowerCase()));
    console.log(`[Listing] ${source.name} page ${page}: ${rows.length} listed, ${fresh.length} new`);

    knownPagesInARow = fresh.length === 0 ? knownPagesInARow + 1 : 0;

    for (const row of fresh) {
      try {
        if (await insertListedTender(row, source.name)) result.added++;
        consecutiveInsertErrors = 0;
      } catch (err: any) {
        result.insertErrors++;
        consecutiveInsertErrors++;
        console.error(`[Listing] Insert failed for "${row.title.substring(0, 60)}": ${err.message}`);
        if (consecutiveInsertErrors >= MAX_CONSECUTIVE_INSERT_ERRORS) {
          result.error = `aborted after ${MAX_CONSECUTIVE_INSERT_ERRORS} consecutive insert errors: ${err.message}`;
          console.error(`[Listing] ❌ ${source.name} ${result.error}`);
          return result;
        }
      }
    }

    if (knownPagesInARow >= KNOWN_PAGES_BEFORE_STOP) {
      console.log(`[Listing] ${source.name}: reached tenders already stored, stopping.`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`[Listing] ${source.name}: +${result.added} new tenders (${result.fetched} scanned)`);
  return result;
}

// ─── Static portal scraper (Axios + Cheerio) ────────────────────────────────

async function scrapeStaticPortal(portal: PortalConfig): Promise<SourceResult> {
  const { name, url, rowSelector, maxItems } = portal;
  const result: SourceResult = { name, fetched: 0, added: 0, insertErrors: 0 };
  console.log(`\n[Static] Scraping ${name}...`);

  try {
    const html = await fetchHtml(url, 2);
    const $ = cheerio.load(html);
    const rows: string[] = [];

    $(rowSelector).each((_i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 30) rows.push(text);
    });

    result.fetched = rows.length;
    console.log(`[Static] ${name}: found ${rows.length} items. Processing top ${Math.min(maxItems, rows.length)}...`);

    for (const row of rows.slice(0, maxItems)) {
      if (await isAlreadyIngested(row)) continue;
      const rawText = `Source: ${name}\nURL: ${url}\nContent: ${row}`;
      if (await ingestRawText(rawText, name, url)) result.added++;
    }
  } catch (err: any) {
    result.error = err.message;
    console.error(`[Static] ❌ ${name} failed: ${err.message}`);
  }

  console.log(`[Static] ${name}: +${result.added} new tenders`);
  return result;
}

// ─── Main exported function ──────────────────────────────────────────────────

export interface ScrapeSummary {
  success: boolean;
  count: number;
  skipped?: boolean;
  sources: SourceResult[];
  // True when no listing source returned a single tender row, or inserts
  // failed outright. Callers use this to fail loudly instead of reporting an
  // empty run as a success.
  failed: boolean;
}

export async function runLiveScraper(options: ScrapeOptions = {}): Promise<ScrapeSummary> {
  const quick = options.quick === true;
  const lockClient = await pool.connect();
  let holdsLock = false;

  // pg-pool removes its own idle-error listener the moment a client is
  // checked out (only re-attaching it on release), so a client held for a
  // long time — as this one is, for the whole scraper run — has no error
  // listener at all while in use. Without this, the provider dropping the
  // connection mid-run emits an unhandled 'error' event straight from `pg`
  // internals and crashes the process. Losing the lock connection isn't fatal
  // to the run itself (advisory locks are released automatically when the
  // underlying Postgres session ends), so this just logs instead of throwing.
  lockClient.on('error', (err) => {
    console.error('[Scanner] Advisory-lock connection dropped:', err.message);
  });

  try {
    const lockResult = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [SCRAPER_ADVISORY_LOCK]);
    if (!lockResult.rows[0]?.locked) {
      console.log('[Scanner] Another scraper run is already in progress; skipping.');
      return { success: true, count: 0, skipped: true, sources: [], failed: false };
    }
    holdsLock = true;

    const geminiStats = getGeminiUsageStats();
    console.log(`\n🚀 Tender Scraper starting (${quick ? 'quick' : 'full'} run) — ${LISTING_SOURCES.length} listing sources${quick ? '' : ` + ${PORTAL_REGISTRY.length} portals`}`);
    console.log(`🤖 Gemini AI extraction: ${geminiStats.isAvailable ? `enabled (${geminiStats.dailyCalls}/${geminiStats.maxDaily} calls used today)` : 'disabled — using local regex fallback'}`);

    const sources: SourceResult[] = [];
    const maxPages = quick ? QUICK_RUN_MAX_PAGES : FULL_RUN_MAX_PAGES;
    const stopAt = quick ? Date.now() + QUICK_RUN_BUDGET_MS : Number.POSITIVE_INFINITY;

    for (const source of LISTING_SOURCES) {
      sources.push(await scrapeListingSource(source, maxPages, stopAt));
    }

    // The per-portal free-text scrapers are slow and low-yield, so a manual
    // refresh (which has to answer within the serverless time limit) skips them.
    if (!quick) {
      for (const portal of PORTAL_REGISTRY) {
        sources.push(await scrapeStaticPortal(portal));
        // Small delay between portals to be polite and avoid rate-limiting
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    const count = sources.reduce((sum, s) => sum + s.added, 0);
    const listing = sources.slice(0, LISTING_SOURCES.length);
    const nothingFetched = listing.every((s) => s.fetched === 0);
    const insertsBroken = count === 0 && sources.some((s) => s.insertErrors > 0);
    const failed = nothingFetched || insertsBroken;

    console.log('\n── Run summary ──');
    for (const s of sources) {
      console.log(`${s.error ? '❌' : '✅'} ${s.name.padEnd(16)} scanned=${s.fetched} added=${s.added} insertErrors=${s.insertErrors}${s.error ? ` — ${s.error}` : ''}`);
    }
    console.log(`\n🎉 Scraper complete! Total new tenders ingested: ${count}`);
    return { success: !failed, count, sources, failed };

  } finally {
    if (holdsLock) {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [SCRAPER_ADVISORY_LOCK]).catch(() => undefined);
    }
    lockClient.release();
  }
}

export async function seedInitialTenders(): Promise<number> {
  console.warn('[Scanner] Sample seeding is disabled. No unverified tenders were created.');
  return 0;
}
