#!/usr/bin/env node
// SCREENS OF EVERY APP THAT RUNS ON THE WEB, TAKEN BY CI.
//
// For each brand whose contract names a web app (web: url:), open it in a
// headless browser at a desktop and a phone size, wait for it to draw, and
// save brand-assets/media/<brand>/auto-desktop.png and auto-phone.png with a
// captured.json saying from where and when. The releases page shows them
// after the brand's own screenshots, marked as captured automatically.
//
// A screen that comes back blank (the app had not drawn yet) is not saved:
// the previous capture stays rather than a white rectangle replacing it.
//
// Usage: node tools/capture-media.mjs [--catalog data/catalog.json] [--out brand-assets/media]

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const catalog = JSON.parse(readFileSync(arg('catalog', 'data/catalog.json'), 'utf8'));
const outRoot = arg('out', 'brand-assets/media');
const settleMs = Number(arg('settle-ms', '25000'));
const slug = (v) => String(v).trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const FRAMES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
// A PNG this small is a blank or near-blank page.
const BLANK_BYTES = 20000;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let saved = 0;
try {
  for (const product of catalog.products || []) {
    const url = product.webApp;
    if (!/^https:\/\//.test(url || '')) continue;
    const dir = join(outRoot, slug(product.brandId));
    mkdirSync(dir, { recursive: true });
    let any = false;
    for (const frame of FRAMES) {
      const { name, ...options } = frame;
      const context = await browser.newContext({ ...options, colorScheme: 'dark', locale: 'en-IN' });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 120000 });
        await page.waitForTimeout(settleMs);
        const tmp = join(dir, `.auto-${name}.png`);
        await page.screenshot({ path: tmp });
        if (statSync(tmp).size < BLANK_BYTES) {
          console.log(`${product.brandId} ${name}: blank, keeping the previous capture`);
          unlinkSync(tmp);
        } else {
          renameSync(tmp, join(dir, `auto-${name}.png`));
          any = true;
          saved += 1;
          console.log(`${product.brandId} ${name}: captured from ${url}`);
        }
      } catch (error) {
        console.log(`${product.brandId} ${name}: ${error.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
    if (any) writeFileSync(join(dir, 'captured.json'), `${JSON.stringify({ url, capturedAt: new Date().toISOString() }, null, 2)}\n`);
  }
} finally {
  await browser.close();
}
console.log(`captured ${saved} screens`);
