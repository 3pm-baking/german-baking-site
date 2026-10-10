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

import { availability, deliveryOptionFixture, marketsMap, mount, reply } from "./harness.mjs";

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
  assert.equal(page.value(".tg-cart-qty select"), "1");
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

// --- quantity control -------------------------------------------------------
// A number input makes a phone customer type. The whole legal range is small
// (a drop caps an item at 6), so it is a dropdown instead.

test("quantity is a dropdown, not a field to type into", async () => {
  const page = cart();
  await page.settle();

  assert.equal(page.$(".tg-cart-qty input"), null, "no typing required on a phone");
  const select = page.$(".tg-cart-qty select");
  assert.ok(select, "quantity must be a select");
  assert.match(select.getAttribute("aria-label"), /German Cheesecake/);
  assert.equal(select.value, "2", "the current quantity is the selected option");
  await page.close();
});

test("the quantity dropdown offers 1 to what remains, and never 0", async () => {
  const page = cart();
  await page.settle();

  const options = page.$$(".tg-cart-qty select option").map((o) => o.value);
  assert.deepEqual(options, ["1", "2", "3", "4", "5", "6"], "one option per remaining unit");
  assert.ok(!options.includes("0"), "removing a line is the × button's job");
  await page.close();
});

test("an uncapped item still gets a bounded dropdown", async () => {
  const uncapped = availability();
  uncapped.drops[0].items[0].remaining = null;

  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": uncapped },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 2 }] },
  });
  await page.settle();

  const options = page.$$(".tg-cart-qty select option").map((o) => o.value);
  assert.ok(options.length > 2, "still more than the one option in the cart");
  assert.ok(options.length <= 12, `bounded, not a 99-row list (got ${options.length})`);
  await page.close();
});

test("picking a quantity re-quotes the line and the subtotal", async () => {
  const page = cart();
  await page.settle();

  const select = page.$(".tg-cart-qty select");
  select.value = "4";
  select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.settle();

  assert.equal(page.value(".tg-cart-qty select"), "4");
  assert.equal(page.text("[data-line-total]"), "$24.00");
  assert.equal(page.text(".tg-cart-total"), "$24.00");
  const stored = JSON.parse(page.window.localStorage.getItem("tailgate_cart"));
  assert.equal(stored.items[0].qty, 4, "the choice is saved, not just rendered");
  await page.close();
});

test("a line with nothing left is dropped rather than shown at 0", async () => {
  // The dropdown has no 0, so a remaining=0 item cannot be represented as a row.
  const gone = availability();
  gone.drops[0].items[0].remaining = 0;

  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": gone },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 2 }] },
  });
  await page.settle();

  assert.equal(page.$$(".tg-cart-row").length, 0);
  assert.match(page.bodyText("#tg-cart-root"), /cart is empty/i);
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

/* -------------------------------------------------------------------------
 * delivery on the cart page (address quote, 30-min rule, minimum, fail-soft)
 * ------------------------------------------------------------------------ */

const TG_QUOTE_OK = {
  ok: true,
  minutes_one_way: 15,
  round_trip_minutes: 30,
  fee_cents: 1000,
  max_one_way_minutes: 30,
  cents_per_hour: 2000,
};

/** Deliverable-unit map for the fixtures: the whole is deliverable, the
 *  slice is not — exactly what seed_drops' `units: [whole]` policy produces
 *  and what the availability wire format carries. */
const DELIVERABLE_ITEMS = [
  {
    slug: "german-cheesecake",
    name: "German Cheesecake",
    capacity: 20,
    remaining: 6,
    units: [
      { name: "slice", price_cents: 600 },
      { name: "whole", price_cents: 4500, fulfillment_types: ["pickup", "delivery"] },
    ],
  },
  {
    slug: "apple-streusel",
    name: "Apple Streusel",
    capacity: 12,
    remaining: 12,
    units: [{ name: "slice", price_cents: 700 }],
  },
];

function deliveryCartPage({
  deliveryOption = deliveryOptionFixture(),
  quote = null,
  items = DELIVERABLE_ITEMS,
  cart = { items: [{ slug: "german-cheesecake", unit: "whole", qty: 1 }] },
} = {}) {
  const routes = {
    "GET /api/v1/availability": availability({ deliveryOption, items }),
  };
  if (quote) routes["POST /api/v1/quote"] = quote;
  return mount({
    page: "cart",
    routes,
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart,
  });
}

test("checking the address quotes minutes and fee in the status line", async () => {
  const page = await deliveryCartPage({ quote: TG_QUOTE_OK });
  await page.waitFor("#tg-cart-checkout");

  const radio = page.$("input[name='tg-delivery']");
  radio.checked = true;
  radio.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.settle();

  assert.ok(page.has("#tg-delivery-address"), "address box appears with the radio");
  page.$("#tg-delivery-address").value = "22 Haywood Rd, Asheville, NC 28806";
  page.$("#tg-delivery-check").click();
  await page.settle();

  assert.match(page.text("[data-delivery-status]"), /15 min away/);
  assert.match(page.text("[data-delivery-status]"), /\$10\.00 delivery/);
  const post = page.calls.find((c) => c.route === "POST /api/v1/quote");
  assert.equal(page.requestBody(page.calls.indexOf(post)).address, "22 Haywood Rd, Asheville, NC 28806");
  await page.close();
});

test("a quoted fee adds a delivery row to the totals", async () => {
  const page = await deliveryCartPage();
  await page.waitFor("#tg-cart-checkout");
  page.eval(`tgShowDeliveryResult(document, ${JSON.stringify(TG_QUOTE_OK)})`);

  assert.match(page.text(".tg-delivery-fee"), /\$10\.00/);
  assert.match(page.bodyText("tfoot"), /Delivery fee/);
  // the labeled total stays the items subtotal: the disclosed charge is
  // items + fee rows (with tax on top at checkout, same as pickup)
  assert.equal(page.text(".tg-cart-total"), "$45.00");
  await page.close();
});

test("the rule text is rendered from the drop's numbers, not baked copy", async () => {
  const page = await deliveryCartPage(); // 30-min range, $20/h
  await page.waitFor("#tg-cart-checkout");

  assert.match(page.bodyText(".tg-delivery-rule"), /30 minutes one way/);
  assert.match(page.bodyText(".tg-delivery-rule"), /\$20\.00\/hour/);
  assert.match(page.bodyText(".tg-delivery-rule"), /15 minutes out is \$10\.00/);
  await page.close();
});

test("too far: names the distance and keeps pickup open, no fee row", async () => {
  const page = await deliveryCartPage();
  await page.waitFor("#tg-cart-checkout");
  page.eval(
    "tgShowDeliveryResult(document, { ok: false, reason: 'too_far', minutes_one_way: 45 })"
  );

  assert.match(page.text("[data-delivery-status]"), /45 minutes away/);
  assert.match(page.text("[data-delivery-status]"), /30-minute delivery range/);
  assert.ok(!page.has(".tg-delivery-fee"));
  assert.equal(page.$$(".tg-pickup-option").length, 1);
  await page.close();
});

test("quote failure fails soft and keeps pickup fully intact", async () => {
  const page = await deliveryCartPage({ quote: reply(503, {}) });
  await page.waitFor("#tg-cart-checkout");
  page.eval("tgShowDeliveryResult(document, { ok: false, reason: 'unavailable' })");

  assert.match(page.text("[data-delivery-status]"), /still order for pickup/);
  assert.equal(page.$$(".tg-pickup-option").length, 1);
  assert.equal(page.$("input[name='tg-pickup']").disabled, false);
  await page.close();
});

test("zone fallback appears when the quote is unreachable and tiers are set", async () => {
  const page = await deliveryCartPage();
  await page.waitFor("#tg-cart-checkout");
  page.eval("tgShowDeliveryResult(document, { ok: false, reason: 'unavailable' })");

  const zone = page.$("#tg-delivery-zone");
  assert.ok(zone, "zone select renders");
  zone.value = "asheville-city";
  zone.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.settle();
  assert.match(page.text(".tg-delivery-fee"), /\$5\.00/); // the tier's fee
  await page.close();
});

test("below the configurable minimum the radio is greyed with its reason", async () => {
  const page = await deliveryCartPage({
    deliveryOption: deliveryOptionFixture({ minOrderCents: 5000 }),
  });
  await page.waitFor("#tg-cart-checkout");

  const radio = page.$("input[name='tg-delivery']");
  assert.equal(radio.disabled, true, "radio disabled below the minimum");
  assert.match(
    page.bodyText(".tg-delivery-option--disabled"),
    /minimum of \$50\.00/,
    "the reason is visible, the option is not silently gone"
  );
  await page.close();
});

test("slices never count toward the delivery minimum", async () => {
  const page = await deliveryCartPage({
    deliveryOption: deliveryOptionFixture({ minOrderCents: 5000 }),
    cart: {
      items: [
        { slug: "german-cheesecake", unit: "whole", qty: 1 }, // deliverable 4500
        { slug: "german-cheesecake", unit: "slice", qty: 2 }, // pickup 1200
      ],
    },
  });
  await page.waitFor("#tg-cart-checkout");

  assert.equal(page.$("input[name='tg-delivery']").disabled, true);
  await page.close();
});

test("at the minimum delivery is selectable and quotes", async () => {
  const page = await deliveryCartPage({ quote: TG_QUOTE_OK });
  await page.waitFor("#tg-cart-checkout");

  const radio = page.$("input[name='tg-delivery']");
  assert.equal(radio.disabled, false);
  assert.equal(radio.checked, false);
  await page.close();
});

test("more than three pickup dates collapse behind a details toggle", async () => {
  const fivePoints = [1, 2, 3, 4, 5].map((n) => ({
    slug: `point-${n}`,
    label: `Market ${n}`,
    window_start: "15:30",
    window_end: "18:30",
  }));
  // same-day cutoffs so the sort order is stable: point-1..3 visible
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": availability({
        cutoff: "2026-09-27T13:48:00+00:00",
        pickupPoints: fivePoints,
      }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.waitFor("#tg-cart-checkout");

  const visibleCards = [...page.$(".tg-pickup-options")?.querySelectorAll(":scope > .tg-pickup-option") ?? []];
  assert.equal(visibleCards.length, 3, "three imminent cards stay visible");
  assert.ok(page.has(".tg-more-pickup"));
  const hiddenCards = [...page.$(".tg-more-pickup")?.querySelectorAll(".tg-pickup-option") ?? []];
  assert.equal(hiddenCards.length, 2, "the tail collapses behind the toggle");
  // every card is still a real radio, collapsed or not
  assert.equal(page.$$("input[name='tg-pickup']").length, 5);
  await page.close();
});

test("no deliverable line: no delivery card at all, pickup unaffected", async () => {
  const page = await deliveryCartPage({
    cart: { items: [{ slug: "apple-streusel", unit: "slice", qty: 2 }] },
  });
  await page.waitFor("#tg-cart-checkout");

  assert.ok(!page.has(".tg-delivery-option"));
  assert.equal(page.$$(".tg-pickup-option").length, 1);
  await page.close();
});
