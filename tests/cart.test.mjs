/**
 * Cart page — what the customer is quoted before they pay.
 *
 * The total row is the highest-stakes string on the site: Square adds sales
 * tax on top, so the pre-tax sum is a SUBTOTAL whenever tax is configured.
 * Labelling it "Total" under-quotes the customer by the tax amount and was
 * live on both the cart and the status page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, marketsMap, mount } from "./harness.mjs";

function cart({ taxPercent, newsletterEnabled, ...rest } = {}) {
  return mount({
    page: "cart",
    routes: { "GET /api/v1/availability": availability({ taxPercent, newsletterEnabled, ...rest }) },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 2 }] },
  });
}

test("renders one row per cart line with unit price and line total", async () => {
  const page = cart();
  await page.settle();

  assert.equal(page.$$(".tg-cart-row").length, 1);
  assert.match(page.text(".tg-cart-item"), /German Cheesecake/);
  assert.match(page.text(".tg-cart-item"), /\(slice\)/);
  assert.equal(page.text(".tg-cart-price"), "$6.00");
  assert.equal(page.text("[data-line-total]"), "$12.00");
  await page.close();
});

test("sums multiple lines into the total", async () => {
  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": availability() },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: {
      items: [
        { slug: "german-cheesecake", unit: "slice", qty: 2 }, // 600 * 2 = 1200
        { slug: "german-cheesecake", unit: "whole", qty: 1 }, // 4500
        { slug: "apple-streusel", unit: "slice", qty: 1 }, // 700
      ],
    },
  });
  await page.settle();

  assert.equal(page.$$(".tg-cart-row").length, 3);
  assert.equal(page.text(".tg-cart-total"), "$64.00");
  await page.close();
});

test("a taxed cart labels the sum 'Subtotal' and says tax is added at checkout", async () => {
  const page = cart({ taxPercent: 2.0 });
  await page.settle();

  assert.equal(page.text("tfoot th"), "Subtotal");
  assert.equal(page.text(".tg-cart-total"), "$12.00");
  assert.match(
    page.bodyText("tfoot"),
    /tax/i,
    "customer must be told tax is added, not shown the pre-tax sum as final"
  );
  assert.match(page.bodyText("tfoot"), /2(\.0)?%/);
  await page.close();
});

test("an untaxed cart still says 'Total'", async () => {
  const page = cart({ taxPercent: null });
  await page.settle();

  assert.equal(page.text("tfoot th"), "Total");
  assert.doesNotMatch(page.bodyText("tfoot"), /tax/i);
  await page.close();
});

test("a taxed cart must not claim to know the final amount", async () => {
  const page = cart({ taxPercent: 2.0 });
  await page.settle();

  // If the site ever starts computing tax client-side, this is where the
  // arithmetic must live. Right now it must not invent a total it cannot
  // authoritatively know (Square applies the rate at checkout).
  const text = page.bodyText("tfoot");
  assert.doesNotMatch(text, /\$12\.24/, "client-side tax math would drift from Square");
  await page.close();
});

// --- pickup selection -------------------------------------------------------

test("offers one pickup card per open drop x pickup point", async () => {
  const page = cart();
  await page.settle();

  const cards = page.$$(".tg-pickup-option");
  assert.equal(cards.length, 1);
  assert.equal(page.text(".tg-pickup-market"), "West Asheville");
  assert.match(page.text(".tg-pickup-when"), /3:30/);
  await page.close();
});

test("preselects the soonest cutoff and labels it with a human deadline", async () => {
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": {
        ...availability(),
        drops: [
          ...availability().drops,
          {
            ...availability().drops[0],
            drop_id: "2026-10-06",
            fulfillment_options: [
              {
                ...availability().drops[0].fulfillment_options[0],
                cutoff: "2026-10-04T13:48:00+00:00",
                pickup_at: "2026-10-06T15:30:00+00:00",
                pickup_points: [
                  { slug: "black-mountain", label: "Black Mountain Tailgate Market", window_start: "09:00", window_end: "12:00" },
                ],
              },
            ],
          },
        ],
      },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.settle();

  const cards = page.$$(".tg-pickup-option");
  assert.equal(cards.length, 2);
  const checked = page.$("input[name='tg-pickup']:checked");
  assert.ok(checked, "a pickup option must be preselected");
  assert.equal(checked.value, "2026-09-29|west-asheville"); // soonest cutoff first
  assert.match(page.text(".tg-pickup-deadline"), /Order by/);
  await page.close();
});

test("no pickup card renders a slug to the customer", async () => {
  const page = cart();
  await page.settle();

  const visible = page.bodyText(".tg-pickup-options");
  assert.doesNotMatch(visible, /west-asheville/);
  await page.close();
});

// --- reconciliation ---------------------------------------------------------

test("drops a line that sold out since it was added, and says so", async () => {
  const soldOut = availability();
  soldOut.drops[0].items[0].sold_out = true;
  soldOut.drops[0].items[0].remaining = 0;

  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": soldOut },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 2 }] },
  });
  await page.settle();

  assert.match(page.text(".tg-cart-note"), /sold out/i);
  assert.match(page.bodyText("#tg-cart-root"), /cart is empty/i);
  await page.close();
});

test("clamps a quantity to what remains and says so", async () => {
  const nearlyGone = availability();
  nearlyGone.drops[0].items[0].remaining = 1;

  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": nearlyGone },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 4 }] },
  });
  await page.settle();

  assert.match(page.text(".tg-cart-note"), /quantity reduced to 1/i);
  assert.equal(page.value(".tg-cart-qty input"), "1");
  assert.equal(page.text(".tg-cart-total"), "$6.00");
  await page.close();
});

test("ignores a closed drop when resolving a cart line", async () => {
  // A line must resolve to an OPEN drop — resolving against a closed one
  // would quote a pickup window the customer can no longer order from.
  const closed = availability({ status: "closed" });
  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": closed },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.settle();

  assert.match(page.text(".tg-cart-note"), /sold out/i);
  await page.close();
});

// --- newsletter opt-in ------------------------------------------------------

test("shows the newsletter opt-in when the API enables it", async () => {
  const page = cart({ newsletterEnabled: true });
  await page.settle();

  assert.ok(page.$("#tg-cart-newsletter"), "opt-in checkbox must render");
  assert.equal(page.$("#tg-cart-newsletter").checked, false, "must default to unchecked");
  await page.close();
});

test("hides the newsletter opt-in when the API disables it", async () => {
  const page = cart({ newsletterEnabled: false });
  await page.settle();

  assert.equal(page.$("#tg-cart-newsletter"), null);
  await page.close();
});

// --- fail-soft --------------------------------------------------------------

test("degrades to a message when availability cannot be fetched", async () => {
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": () => {
        throw new Error("network down");
      },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.settle();

  assert.match(page.bodyText("#tg-cart-root"), /unavailable/i);
  await page.close();
});

test("an empty cart invites the customer back to the products", async () => {
  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": availability() },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [] },
  });
  await page.settle();

  assert.match(page.bodyText("#tg-cart-root"), /cart is empty/i);
  assert.ok(page.$('a[href="/#products"]'));
  await page.close();
});
