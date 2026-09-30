/**
 * Order status page — the receipt a customer comes back to.
 *
 * Two failure modes this file exists to pin:
 *
 *  1. Money. Square adds tax on top, so the line-item sum is a subtotal.
 *     Labelling it "Total" under-quotes what they are about to be charged.
 *  2. Raw identifiers. The status page used to build display names from
 *     /availability, so whenever availability was unreachable — or the drop
 *     had aged out of the publish window, which is exactly when someone opens
 *     their receipt — it degraded to printing `Pickup: west-asheville` and
 *     `german-cheesecake`. Names now ride with the order; these tests assert
 *     they are used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, marketsMap, mount, orderStatus, reply } from "./harness.mjs";

const REF = "a1b2c3d4e5f6";
const TOKEN = "signed-token-value";

function status({ order = {}, availabilityPayload = availability(), ...rest } = {}) {
  return mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availabilityPayload,
      [`GET /api/v1/orders/${REF}`]: orderStatus(order),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    ...rest,
  });
}

test("shows the order status, lines, and total", async () => {
  const page = status();
  await page.settle();

  assert.match(page.text(".tg-badge"), /Paid/);
  assert.match(page.bodyText(".tg-cart-table"), /German Cheesecake \(slice\)/);
  assert.match(page.bodyText(".tg-cart-table"), /×2/);
  assert.equal(page.text("tfoot th:last-child"), "$60.00");
  await page.close();
});

test("a taxed order labels the sum 'Subtotal' and says tax is added at checkout", async () => {
  const page = status({ order: { taxPercent: 2.0, totalCents: 6000 } });
  await page.settle();

  assert.equal(page.text("tfoot th"), "Subtotal");
  assert.match(page.bodyText("tfoot"), /tax/i);
  assert.match(page.bodyText("tfoot"), /2(\.0)?%/);
  await page.close();
});

test("an untaxed order still says 'Total'", async () => {
  const page = status({ order: { taxPercent: null, totalCents: 6000 } });
  await page.settle();

  assert.equal(page.text("tfoot th"), "Total");
  await page.close();
});

test("every order status maps to a customer-readable label", async () => {
  const expected = {
    pending: /Awaiting payment/,
    paid: /Paid!/,
    fulfilled: /Picked up/,
    canceled: /Canceled/,
    expired: /Expired/,
    no_show: /Missed pickup/,
  };
  for (const [statusValue, pattern] of Object.entries(expected)) {
    const page = status({ order: { status: statusValue } });
    await page.settle();
    assert.match(page.text(".tg-badge"), pattern, `status ${statusValue}`);
    await page.close();
  }
});

// --- no raw identifiers on a customer surface -------------------------------

test("shows the market name, never the pickup slug", async () => {
  const page = status();
  await page.settle();

  const text = page.bodyText("#tg-status-root");
  assert.match(text, /West Asheville Tailgate Market/);
  assert.doesNotMatch(text, /west-asheville/);
  await page.close();
});

test("shows item display names from the order, not slugs from availability", async () => {
  // availability deliberately names the item differently, so passing this
  // proves the order's own name is used rather than availability's.
  const page = status({
    order: {
      lines: [
        { item_slug: "german-cheesecake", item_name: "German Cheesecake", unit_name: "slice", quantity: 2, unit_price_cents: 600 },
      ],
    },
    availabilityPayload: (() => {
      const payload = availability();
      payload.drops[0].items[0].name = "STALE AVAILABILITY NAME";
      return payload;
    })(),
  });
  await page.settle();

  const text = page.bodyText(".tg-cart-table");
  assert.match(text, /German Cheesecake/);
  assert.doesNotMatch(text, /STALE AVAILABILITY NAME/);
  assert.doesNotMatch(text, /german-cheesecake/);
  await page.close();
});

test("still shows human names when availability is unreachable", async () => {
  // The realistic version of this: the customer opens their order the day
  // after pickup, when the drop is no longer in the publish window.
  const page = status({
    availabilityPayload: () => {
      throw new Error("502");
    },
  });
  await page.settle();

  const text = page.bodyText("#tg-status-root");
  assert.match(text, /German Cheesecake/);
  assert.doesNotMatch(text, /german-cheesecake/);
  await page.close();
});

test("never prints an ISO timestamp at the customer", async () => {
  const page = status();
  await page.settle();

  const text = page.bodyText("#tg-status-root");
  assert.doesNotMatch(text, /T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(text, /\+00:00/);
  await page.close();
});

test("never prints the order ref or status token at the customer", async () => {
  const page = status();
  await page.settle();

  const text = page.bodyText("#tg-status-root");
  assert.doesNotMatch(text, new RegExp(REF));
  assert.doesNotMatch(text, new RegExp(TOKEN));
  await page.close();
});

// --- market card ------------------------------------------------------------

test("renders the market card with address, window, and calendar link", async () => {
  const page = status();
  await page.settle();

  assert.match(page.text(".tg-market-card-heading"), /See you at West Asheville Tailgate Market/);
  assert.match(page.text(".tg-market-card-address"), /Market St/);
  assert.match(page.text(".tg-market-card__when"), /3:30/);
  assert.match(page.bodyText(".tg-market-card-schedule"), /Tuesdays/);

  const cal = page.$(".tg-market-card-cal");
  assert.ok(cal, "paid orders must offer add-to-calendar");
  assert.match(cal.getAttribute("href"), /calendar\.ics\?token=/);
  await page.close();
});

test("omits the calendar link when the order has no pickup time", async () => {
  const page = status({ order: { pickupAt: null } });
  await page.settle();

  assert.equal(page.$(".tg-market-card-cal"), null);
  await page.close();
});

test("a pending order says pickup is happening, not 'see you'", async () => {
  const page = status({ order: { status: "pending" } });
  await page.settle();

  assert.match(page.text(".tg-market-card-heading"), /^Pickup at /);
  assert.match(page.text(".tg-status-waiting"), /updates automatically/);
  await page.close();
});

test("does not offer cancellation on a fulfilled order", async () => {
  const page = status({ order: { status: "fulfilled", cancellable: false } });
  await page.settle();

  assert.equal(page.$("#tg-cancel-order"), null);
  await page.close();
});

test("offers cancellation on a paid order and shows the deadline", async () => {
  const page = status({ order: { status: "paid", cancellable: true } });
  await page.settle();

  assert.ok(page.$("#tg-cancel-order"));
  assert.match(page.bodyText("#tg-status-root"), /Cancellations close/);
  await page.close();
});

// --- polling ----------------------------------------------------------------

test("polls a pending order and re-renders when payment lands", async () => {
  // Square's webhook is slow and variable (14 min observed), so the customer
  // routinely lands here while the order is still pending. One fetch would
  // leave them staring at "Awaiting payment" forever.
  let statusValue = "pending";
  const page = mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: () => orderStatus({ status: statusValue }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
  });
  await page.settle();

  assert.match(page.text(".tg-badge"), /Awaiting payment/);
  assert.equal(page.pendingTimers() > 0, true, "a pending order must schedule a poll");

  statusValue = "paid";
  await page.runTimer(1);
  await page.settle();

  assert.match(page.text(".tg-badge"), /Paid!/);
  assert.equal(page.pendingTimers(), 0, "polling must stop once the order is terminal");
  await page.close();
});

test("stops polling once the order reaches a terminal state", async () => {
  let statusValue = "pending";
  const page = mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: () => orderStatus({ status: statusValue }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
  });
  await page.settle();

  statusValue = "canceled";
  await page.runTimer(1);
  await page.settle();
  assert.match(page.text(".tg-badge"), /Canceled/);

  // no new timer may be scheduled off a terminal state
  assert.equal(page.pendingTimers(), 0);
  await page.close();
});

test("does not poll a paid order", async () => {
  const page = status({ order: { status: "paid" } });
  await page.settle();

  assert.equal(page.pendingTimers(), 0, "only non-terminal states are worth re-checking");
  await page.close();
});

test("keeps polling through a transient fetch error", async () => {
  let calls = 0;
  let statusValue = "pending";
  const page = mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: () => {
        calls += 1;
        if (calls === 2) throw new Error("502"); // one flaky poll
        return orderStatus({ status: statusValue });
      },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
  });
  await page.settle();

  await page.runTimer(1);
  await page.settle();
  assert.match(page.text(".tg-badge"), /Awaiting payment/, "a hiccup must not blank the page");
  assert.ok(page.pendingTimers() > 0, "polling must continue after an error");

  statusValue = "paid";
  await page.runTimer(1);
  await page.settle();
  assert.match(page.text(".tg-badge"), /Paid!/);
  await page.close();
});

// --- bad links --------------------------------------------------------------

test("an invalid link says so instead of erroring", async () => {
  for (const code of [403, 404]) {
    const page = mount({
      page: "status",
      search: `?ref=${REF}&token=forged`,
      routes: {
        "GET /api/v1/availability": availability(),
        [`GET /api/v1/orders/${REF}`]: reply(code, { detail: "Invalid link" }),
      },
      globals: { TAILGATE_MARKETS: marketsMap() },
    });
    await page.settle();

    assert.match(page.bodyText("#tg-status-root"), /not valid/i, `status ${code}`);
    await page.close();
  }
});

test("a missing ref or token explains what is wrong", async () => {
  for (const search of ["", "?ref=" + REF, "?token=" + TOKEN]) {
    const page = mount({
      page: "status",
      search,
      routes: { "GET /api/v1/availability": availability() },
      globals: { TAILGATE_MARKETS: marketsMap() },
    });
    await page.settle();

    assert.match(page.bodyText("#tg-status-root"), /Missing order link/i, `search "${search}"`);
    await page.close();
  }
});

// --- cancellation -----------------------------------------------------------

test("cancelling posts the token and flips the badge to canceled", async () => {
  let canceled = false;
  const page = mount({
    page: "status",
    search: `?ref=${REF}&token=${TOKEN}`,
    routes: {
      "GET /api/v1/availability": availability(),
      [`GET /api/v1/orders/${REF}`]: () =>
        orderStatus({ status: canceled ? "canceled" : "paid", cancellable: !canceled }),
      [`POST /api/v1/orders/${REF}/cancel`]: () => {
        canceled = true;
        return { order_ref: REF, status: "canceled" };
      },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
  });
  await page.settle();

  page.$("#tg-cancel-order").dispatchEvent(new page.window.MouseEvent("click"));
  await page.settle();

  const cancelCall = page.calls.find((c) => c.path.endsWith("/cancel"));
  assert.ok(cancelCall, "cancellation must call the API");
  assert.deepEqual(page.requestBody(page.calls.indexOf(cancelCall)), { token: TOKEN });
  assert.match(page.text(".tg-badge"), /Canceled/);
  await page.close();
});
