/**
 * UI test for the Graph Reasoning detail panel layout.
 *
 * Why this exists: layout bugs in the panel (empty columns, full-width leakage,
 * overlapping text, masonry imbalance) kept shipping because "webpack compiles
 * clean" was being treated as validation. It is not. This script loads the
 * actual rendered DOM, queries computed grid-column / bounding-box of each
 * panel section, and reports actual vs expected.
 *
 * Run:  node scripts/ui-test/panel-layout.js [paperLabelSubstring]
 * e.g.  node scripts/ui-test/panel-layout.js Graspgpt
 *       node scripts/ui-test/panel-layout.js Pointnetgpd
 *
 * Requires the dashboard dev server to be up at http://localhost:3002.
 */

const { chromium } = require('playwright');

const URL = process.env.UI_TEST_URL || 'http://localhost:3002';
const TARGET_LABEL = process.argv[2] || 'Graspgpt';
const SCREENSHOT_DIR = require('path').resolve(__dirname, 'screenshots');
const fs = require('fs');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.warn('[console]', msg.text()); });

  console.log(`→ loading ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle' });

  // Navigate to Graph Reasoning tab
  console.log(`→ clicking Graph Reasoning tab`);
  await page.locator('button.nav-link', { hasText: 'Graph Reasoning' }).click();
  await page.waitForTimeout(2000);
  await page.waitForSelector('.kgv-container', { timeout: 15000 });
  await page.waitForTimeout(1500); // let cytoscape lay out

  // Wait for window.__kgCy (exposed by KGGraphViz on localhost only).
  await page.waitForFunction(() => !!window.__kgCy, null, { timeout: 10000 });

  // Click the paper node via cytoscape API. We programmatically emit a tap
  // event on the node whose label matches TARGET_LABEL — this fires the
  // same React handler as a real user click without depending on canvas
  // pixel coordinates.
  console.log(`→ tapping paper labeled "${TARGET_LABEL}"`);
  const tapped = await page.evaluate(label => {
    const cy = window.__kgCy;
    if (!cy) return { ok: false, reason: 'no __kgCy on window' };
    const matches = cy.nodes().filter(n => {
      const l = (n.data('label') || '').toLowerCase();
      return l === label.toLowerCase() || l.includes(label.toLowerCase());
    });
    if (matches.length === 0) {
      const all = cy.nodes().map(n => n.data('label')).filter(Boolean);
      return { ok: false, reason: `no node matching "${label}"; available labels (first 30): ${all.slice(0, 30).join(' | ')}` };
    }
    matches[0].emit('tap');
    return { ok: true, label: matches[0].data('label'), id: matches[0].data('id') };
  }, TARGET_LABEL);
  if (!tapped.ok) {
    console.error(`✗ ${tapped.reason}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/error-no-target.png`, fullPage: true });
    await browser.close(); process.exit(2);
  }
  console.log(`  matched node id=${tapped.id} label="${tapped.label}"`);
  await page.waitForTimeout(1500);

  // Wait for the detail panel to appear
  await page.waitForSelector('.kgnd-panel', { timeout: 5000 });
  console.log(`→ detail panel opened`);

  // Inspect every direct child of .detail-panel-body and report its slot + computed grid-column
  const sections = await page.evaluate(() => {
    const body = document.querySelector('.kgnd-panel .detail-panel-body');
    if (!body) return null;
    return Array.from(body.children).map((el, i) => {
      const cs = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        index: i,
        className: el.className,
        gridColumn: cs.gridColumn,
        gridRow: cs.gridRow,
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        firstText: (el.textContent || '').trim().slice(0, 60).replace(/\s+/g, ' '),
      };
    });
  });
  if (!sections) {
    console.error('✗ could not inspect detail-panel-body');
    await browser.close(); process.exit(2);
  }

  // Report
  const bodyRect = await page.evaluate(() => {
    const b = document.querySelector('.kgnd-panel .detail-panel-body');
    const r = b.getBoundingClientRect();
    const cs = window.getComputedStyle(b);
    return {
      width: Math.round(r.width),
      gridTemplateColumns: cs.gridTemplateColumns,
      display: cs.display,
    };
  });
  console.log(`\n  panel body: width ${bodyRect.width}px · display ${bodyRect.display} · grid-template-columns ${bodyRect.gridTemplateColumns}\n`);
  console.log(`  ${'idx'.padEnd(4)}${'class'.padEnd(48)}${'grid-col'.padEnd(14)}${'x'.padEnd(7)}${'w'.padEnd(7)}${'h'.padEnd(7)}preview`);
  console.log(`  ${'-'.repeat(4)}${'-'.repeat(48)}${'-'.repeat(14)}${'-'.repeat(7)}${'-'.repeat(7)}${'-'.repeat(7)}-------`);
  sections.forEach(s => {
    const cls = s.className.length > 46 ? s.className.slice(0, 45) + '…' : s.className;
    console.log(`  ${String(s.index).padEnd(4)}${cls.padEnd(48)}${s.gridColumn.padEnd(14)}${String(s.x).padEnd(7)}${String(s.width).padEnd(7)}${String(s.height).padEnd(7)}${s.firstText}`);
  });

  // Assertions
  console.log('\n  checks:');
  let problems = 0;

  // 1) Slot-width violations — already covered.
  sections.forEach(s => {
    const isLeftSlot = s.className.includes('kgnd-slot-left');
    const isRightSlot = s.className.includes('kgnd-slot-right');
    const w = s.width;
    if ((isLeftSlot || isRightSlot) && w > bodyRect.width * 0.7) {
      console.log(`  ✗ slotted section [${s.index} ${s.firstText}] is too wide (${w}px / ${bodyRect.width}px)`);
      problems += 1;
    }
  });

  // 2) Column-height balance — the bug the user has flagged repeatedly.
  // Sum heights of all .kgnd-slot-left vs .kgnd-slot-right children.
  // Imbalance = abs(leftH - rightH) / max(leftH, rightH).
  // > 0.5 means one column is 2x or more the other → visible empty void.
  const leftH = sections.filter(s => s.className.includes('kgnd-slot-left')).reduce((a, s) => a + s.height, 0);
  const rightH = sections.filter(s => s.className.includes('kgnd-slot-right')).reduce((a, s) => a + s.height, 0);
  const maxH = Math.max(leftH, rightH);
  const imbalance = maxH > 0 ? Math.abs(leftH - rightH) / maxH : 0;
  console.log(`  • left column total: ${leftH}px,  right column total: ${rightH}px,  imbalance: ${(imbalance * 100).toFixed(0)}%`);
  if (imbalance > 0.5 && maxH > 200) {
    console.log(`  ✗ COLUMN IMBALANCE > 50% — short column has empty void under content`);
    problems += 1;
  }

  // 3) Empty column — one slot has zero content while the other has content.
  if ((leftH === 0 && rightH > 0) || (rightH === 0 && leftH > 0)) {
    console.log(`  ✗ ONE COLUMN IS EMPTY — content all on one side`);
    problems += 1;
  }

  if (problems === 0) console.log('  ✓ all layout checks pass');

  // Screenshot
  const shot = `${SCREENSHOT_DIR}/${TARGET_LABEL.replace(/\W+/g, '_')}.png`;
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n  screenshot: ${shot}`);

  await browser.close();
  process.exit(problems === 0 ? 0 : 1);
})();
