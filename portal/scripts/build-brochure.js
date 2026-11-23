#!/usr/bin/env node
'use strict';
/* global document -- used inside page.evaluate(), which runs in the browser */

/**
 * Builds the product overview PDF shown and downloadable in the app
 * (Guides → Product overview) from docs/brochure/mailharbor-overview.html.
 *
 *   cd portal && npm run brochure
 *
 * Needs Playwright with Chromium (a development tool; not used at runtime):
 *   npm i -D playwright && npx playwright install chromium
 * The generated PDF is committed, so production never runs this script.
 */
const path = require('node:path');
const fs = require('node:fs');

// `npm run brochure` builds the product overview (shown in the app); `npm run brochure -- pricing` builds the
// internal sales pricing PDF next to its source (never served by the app).
const PRICING = process.argv[2] === 'pricing';
const SRC = PRICING ? path.resolve(__dirname, '../../docs/internal/sales/mailharbor-pricing.html')
  : path.resolve(__dirname, '../../docs/brochure/mailharbor-overview.html');
const OUT = PRICING ? path.resolve(__dirname, '../../docs/internal/sales/mailharbor-pricing.pdf')
  : path.resolve(__dirname, '../public/downloads/mailharbor-overview.pdf');
const PREVIEWS = PRICING ? null : path.resolve(__dirname, '../public/downloads/overview');

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${SRC}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);

    // Page previews for the in-app viewer (images work on every device; inline PDFs don't).
    // Files are overwritten each run; pages.json tells the viewer how many pages exist.
    if (!PREVIEWS) return;
    fs.mkdirSync(PREVIEWS, { recursive: true });
    const shots = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.5 });
    await shots.goto(`file://${SRC}`, { waitUntil: 'networkidle' });
    await shots.evaluate(() => document.fonts.ready);
    const pages = await shots.$$('.page');
    for (const [i, el] of pages.entries()) {
      await el.screenshot({ path: path.join(PREVIEWS, `page-${i + 1}.jpg`), type: 'jpeg', quality: 82 });
    }
    fs.writeFileSync(path.join(PREVIEWS, 'pages.json'), JSON.stringify({ pages: pages.length, built: new Date().toISOString().slice(0, 10) }));
    console.log(`Wrote ${pages.length} page previews to ${path.relative(process.cwd(), PREVIEWS)}`);
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
