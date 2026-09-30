/**
 * Live-API driver for the money invariant test. Not a test itself — invoked
 * by tailgate's `test_site_totals.py` as a subprocess, because that is where
 * the real server lives.
 *
 * Reads {"apiBase": "...", "cart": {...}} from argv[2], loads the real built
 * cart page with the real preorder.js pointed at the live API (fetch NOT
 * stubbed), and prints what the customer would see as JSON.
 */

import { mount } from "./harness.mjs";

const { apiBase, cart } = JSON.parse(process.argv[2]);

const page = mount({
  page: "cart",
  routes: {},
  globals: { TAILGATE_API_BASE: apiBase },
  cart,
  passthrough: true, // talk to the real API, not a stub
});

// Real I/O, so wait for the render rather than flushing microtasks.
const total = await page.waitFor(".tg-cart-total");
const table = page.$(".tg-cart-table");
const foot = page.$("tfoot");

console.log(
  JSON.stringify({
    renderedTotal: total.textContent.trim(),
    renderedLabel: page.text("tfoot th"),
    taxNote: foot ? foot.textContent.replace(/\s+/g, " ").trim() : "",
    rows: page.$$(".tg-cart-row").length,
    hasTable: Boolean(table),
  })
);

await page.close();
