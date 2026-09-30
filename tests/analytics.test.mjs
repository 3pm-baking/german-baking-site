/**
 * GA4 events fired by the ordering funnel.
 *
 * These numbers are actively reconciled against Tailgate orders, so a silent
 * change to a payload is a wrong attribution number, not just a missing
 * metric. GA4 loads from an external script, so without an event recorder
 * every `if (window.gtag)` guard short-circuits and none of this is covered.
 *
 * Two payload quirks are pinned deliberately rather than "fixed", because
 * they feed the funnel the team reconciles and the semantics are theirs to
 * decide (see the notes on the individual tests).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, cardSlugs, marketsMap, mount, orderStatus } from "./harness.mjs";

const REF = "a1b2c3d4e5f6";
const TOKEN = "signed-token-value";

/**
 * Copy a payload out of the jsdom realm. Objects built inside the VM have that
 * realm's Object.prototype, so `deepEqual` (strict) rejects them on prototype
 * identity even when every field matches.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const twoUnits = (slugs) => [
  {
    slug: slugs[0],
    name: "German Cheesecake",
    capacity: 20,
    remaining: 6,
    units: [
      { name: "slice", price_cents: 600 },
      { name: "whole", price_cents: 4500 },
    ],
  },
  {
    slug: slugs[1],
    name: "Apple Streusel",
    capacity: 12,
    remaining: 12,
    units: [{ name: "slice", price_cents: 700 }],
  },
];

/** Homepage with a populated cart, steppers rendered. */
function storefront() {
  const page = mount({
    page: "index",
    routes: { "GET /api/v1/availability": { drops: [] } },
    load: false,
  });
  const slugs = cardSlugs(page);
  page.setRoute("GET /api/v1/availability", availability({ items: twoUnits(slugs) }), {
    rerun: false,
  });
  page.load();
  return { page, slugs };
}

function statusPage({ order = {}, cart } = {}) {
  return mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: orderStatus(order),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart,
  });
}

/** Cart page with two lines and the form filled, ready to submit. */
async function filledCart() {
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": availability(),
      "POST /api/v1/orders": { order_ref: REF, status_token: "tok" },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: {
      items: [
        { slug: "german-cheesecake", unit: "slice", qty: 2 },
        { slug: "apple-streusel", unit: "slice", qty: 1 },
      ],
    },
  });
  await page.settle();
  // the page validates name/contact before it will start a checkout
  page.eval(
    `document.getElementById("tg-cart-name").value = "Jane Doe";
     document.getElementById("tg-cart-contact").value = "jane@example.com";`
  );
  return page;
}

test("purchase reports checkout_initiated=false for a browser that never started it", async () => {
  const page = statusPage({ order: { status: "paid" } });
  await page.settle();

  assert.equal(page.event("purchase").payload.checkout_initiated, false);
  await page.close();
});

test("purchase reports checkout_initiated=true after a checkout in this browser", async () => {
  const page = statusPage({ order: { status: "paid" } });
  // Set the flag before the status page renders, as a Square redirect would.
  page.window.localStorage.setItem("tailgate_checkout_initiated", "1");
  await page.settle();

  assert.equal(page.event("purchase").payload.checkout_initiated, true);
  await page.close();
});

test("the checkout flag is consumed once, so a later visit reports false", async () => {
  const page = statusPage({ order: { status: "paid" } });
  page.window.localStorage.setItem("tailgate_checkout_initiated", "1");
  await page.settle();
  await page.close();

  const second = statusPage({ order: { status: "paid" } });
  await second.settle();
  assert.equal(second.event("purchase").payload.checkout_initiated, false);
  await second.close();
});

// --- add_to_cart -----------------------------------------------------------

test("add_to_cart carries the unit, the quantity, and the unit price", async () => {
  const { page, slugs } = storefront();
  await page.settle();

  page
    .$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`)
    .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.deepEqual(plain(page.event("add_to_cart").payload), {
    item: slugs[0],
    unit: "slice",
    quantity: 1,
    value: 6,
  });
  await page.close();
});

test("add_to_cart reports the whole price for a whole-cake unit", async () => {
  const { page, slugs } = storefront();
  await page.settle();

  page
    .$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="whole"]`)
    .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.equal(page.event("add_to_cart").payload.value, 45);
  await page.close();
});

test("removing from the cart fires nothing", async () => {
  const { page, slugs } = storefront();
  await page.settle();

  const box = `.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`;
  page.$(box).dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();
  page.$(`${box} .tg-add-box__minus`).dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.equal(page.eventsNamed("remove_from_cart").length, 0);
  assert.equal(page.eventsNamed("add_to_cart").length, 1, "only the add was an event");
  await page.close();
});

// --- checkout_click ---------------------------------------------------------

test("checkout_click reports the number of cart LINES, not units", async () => {
  // Pinned as-is: 2 slices of one product is 1 line but 2 units. GA4's
  // add_to_cart sends `quantity` (units) while this sends `items` (lines),
  // so the two are not comparable in a funnel. Changing either is a reporting
  // decision, not a refactor.
  const page = await filledCart();
  await page.settle();

  page.$("#tg-cart-checkout").dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.deepEqual(plain(page.event("checkout_click").payload), { items: 2 });
  await page.close();
});

test("no checkout_click when the form is incomplete", async () => {
  // The page refuses to submit before name and contact, so the funnel must not
  // record a checkout that never started.
  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": availability() },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.settle();

  page.$("#tg-cart-checkout").dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.equal(page.eventsNamed("checkout_click").length, 0);
  await page.close();
});

test("starting checkout records that this browser began it", async () => {
  // The Square redirect back to /order-status/ is the only way to tell a
  // genuine return-from-payment from a later status check, and that
  // distinction is what the purchase event reports.
  const page = await filledCart();
  await page.settle();

  page.$("#tg-cart-checkout").dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.equal(page.window.localStorage.getItem("tailgate_checkout_initiated"), "1");
  await page.close();
});

// --- purchase ---------------------------------------------------------------

test("purchase carries the order total, currency, and market", async () => {
  const page = statusPage({ order: { status: "paid", totalCents: 6000 } });
  await page.settle();

  const { payload } = page.event("purchase");
  assert.equal(payload.transaction_id, REF);
  assert.equal(payload.value, 60);
  assert.equal(payload.currency, "USD");
  // the human market name, not the pickup slug
  assert.equal(payload.market, "West Asheville Tailgate Market");
  await page.close();
});

test("purchase value is the PRE-TAX subtotal, matching the site's 'Subtotal' label", async () => {
  // The cart and the status page both label this sum a subtotal because
  // Square adds tax on top. GA4 revenue therefore sits ~2% under money taken.
  // Pinned so that if the API ever starts exposing a charged total, this test
  // is the thing that has to be revisited deliberately.
  const page = statusPage({ order: { status: "paid", totalCents: 6000, taxPercent: 2.0 } });
  await page.settle();

  assert.equal(page.event("purchase").payload.value, 60);
  assert.match(page.text("tfoot th"), /Subtotal/);
  await page.close();
});

test("purchase line items use the names the ORDER carries, not the slugs", async () => {
  const page = statusPage({
    order: {
      status: "paid",
      lines: [
        {
          item_slug: "german-cheesecake",
          item_name: "German Cheesecake",
          unit_name: "slice",
          quantity: 2,
          unit_price_cents: 600,
        },
      ],
    },
  });
  await page.settle();

  const [item] = page.event("purchase").payload.items;
  assert.deepEqual(plain(item), {
    item_id: "german-cheesecake",
    item_name: "German Cheesecake",
    item_variant: "slice",
    price: 6,
    quantity: 2,
  });
  await page.close();
});

test("purchase fires once per order per browser, not on every status poll", async () => {
  const page = statusPage({ order: { status: "pending" } });
  await page.settle();
  assert.equal(page.eventsNamed("purchase").length, 0, "pending is not a purchase");

  // flip to paid and let the poll re-render
  let status = "pending";
  const polling = mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: () => orderStatus({ status }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
  });
  await polling.settle();
  status = "paid";
  await polling.runTimer(1);
  await polling.settle();
  assert.equal(polling.eventsNamed("purchase").length, 1, "fired when payment landed");

  // further renders must not fire again
  polling.eval("tgTrackPurchase");
  polling.window.sessionStorage.setItem(`tg_purchase_${REF}`, ""); // simulate a fresh render attempt
  await polling.settle();
  assert.equal(polling.eventsNamed("purchase").length, 1, "deduped via sessionStorage");

  await page.close();
  await polling.close();
});

test("no purchase event for an order that is not paid", async () => {
  for (const status of ["pending", "canceled", "expired"]) {
    const page = statusPage({ order: { status } });
    await page.settle();
    assert.equal(page.eventsNamed("purchase").length, 0, `${status} must not be a purchase`);
    await page.close();
  }
});

// --- maps_click -------------------------------------------------------------

test("the market card's Maps link reports the market by name", async () => {
  // Asserted on the attribute rather than by dispatching a click: the harness
  // runs jsdom with `runScripts: "outside-only"` so the ordering layer can be
  // evaluated by us, and that mode deliberately does not compile inline event
  // handler attributes. The attribute is the source of truth for this event.
  const page = statusPage({ order: { status: "paid" } });
  await page.settle();

  const link = page.$(".tg-market-card-map");
  assert.ok(link, "a paid order must render a Maps link");
  const handler = link.getAttribute("onclick");
  assert.match(handler, /gtag\('event', 'maps_click'/);
  // the human market name, never the pickup slug
  assert.match(handler, /West Asheville Tailgate Market/);
  assert.doesNotMatch(handler, /west-asheville/);
  await page.close();
});

test("the Maps link's address is a real maps query, not a bare label", async () => {
  const page = statusPage({ order: { status: "paid" } });
  await page.settle();

  const href = page.$(".tg-market-card-map").getAttribute("href");
  assert.match(href, /google\.com\/maps\/search/);
  // the market's street address, URL-encoded (the fixture uses "1 Market St")
  assert.match(href, /query=1%20Market%20St/);
  await page.close();
});
