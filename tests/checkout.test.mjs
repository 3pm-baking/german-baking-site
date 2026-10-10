/**
 * Checkout — the moment the displayed number becomes a real charge.
 *
 * preorder.js posts lines and lets the server price them. The risk is not
 * drift in the JS math (there is almost none) but a malformed request: a wrong
 * field name, a missing pickup point, or a quantity the server then rejects
 * after the customer has typed their details.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, deliveryOptionFixture, marketsMap, mount, reply } from "./harness.mjs";

/** Cart page with a filled cart, ready for checkout. */
async function cart({ payload = availability(), orderReply, cart, fill = true } = {}) {
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": payload,
      "POST /api/v1/orders": orderReply ?? {
        ...reply(201, {
          order_ref: "a1b2c3d4e5f6",
          status_token: "tok",
          status_url: "https://order.example.com/order/a1b2c3d4e5f6?token=tok",
          redirect_url: "https://square.link/u/TESTCHECKOUT",
          total_cents: 1200,
        }),
      },
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: cart ?? { items: [{ slug: "german-cheesecake", unit: "slice", qty: 2 }] },
  });
  // the checkout form is rendered after the availability fetch resolves
  await page.settle();
  if (fill) {
    page.eval(
      `document.getElementById("tg-cart-name").value = "Jane Doe";
       document.getElementById("tg-cart-contact").value = "jane@example.com";`
    );
  }
  return page;
}

const clickCheckout = async (page) => {
  page.$("#tg-cart-checkout").dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();
};

test("posts exactly what the API contract expects", async () => {
  const page = await cart();
  await clickCheckout(page);

  const post = page.calls.find((c) => c.path === "/api/v1/orders");
  assert.ok(post, "checkout must POST an order");
  assert.equal(post.method, "POST");
  assert.deepEqual(page.requestBody(page.calls.indexOf(post)), {
    drop_id: "2026-09-29",
    fulfillment_type: "pickup",
    pickup_point: "west-asheville",
    lines: [{ item: "german-cheesecake", unit: "slice", quantity: 2 }],
    name: "Jane Doe",
    contact: "jane@example.com",
    newsletter: false,
    tg_verify: "",
  });
  await page.close();
});

test("sends the preselected pickup point, not a slug invented by the client", async () => {
  const payload = availability();
  payload.drops.push({
    ...payload.drops[0],
    drop_id: "2026-10-06",
    fulfillment_options: [
      {
        ...payload.drops[0].fulfillment_options[0],
        cutoff: "2026-10-04T13:48:00+00:00",
        pickup_at: "2026-10-06T09:00:00+00:00",
        pickup_points: [
          { slug: "black-mountain", label: "Black Mountain Tailgate Market", window_start: "09:00", window_end: "12:00" },
        ],
      },
    ],
  });
  const page = await cart({ payload });

  // pick the second option the way a customer would
  const second = page.$$("input[name='tg-pickup']")[1];
  assert.ok(second, "a second market must be offered");
  second.checked = true;
  await clickCheckout(page);

  const post = page.calls.find((c) => c.path === "/api/v1/orders");
  const body = page.requestBody(page.calls.indexOf(post));
  assert.equal(body.pickup_point, "black-mountain");
  assert.equal(body.drop_id, "2026-10-06");
  await page.close();
});

test("refuses to submit without a name and contact, and does not call the API", async () => {
  const page = await cart({ fill: false });
  await clickCheckout(page);

  assert.equal(page.calls.find((c) => c.path === "/api/v1/orders"), undefined);
  assert.match(page.alerts.join(" "), /name and contact/i);
  await page.close();
});

test("sends the newsletter opt-in when the customer ticks the box", async () => {
  const page = await cart({ payload: availability({ newsletterEnabled: true }) });

  assert.ok(page.$("#tg-cart-newsletter"), "checkbox must exist to be ticked");
  page.$("#tg-cart-newsletter").checked = true;
  await clickCheckout(page);

  const post = page.calls.find((c) => c.path === "/api/v1/orders");
  assert.equal(page.requestBody(page.calls.indexOf(post)).newsletter, true);
  await page.close();
});

test("clears the cart and stores the order reference on success", async () => {
  const page = await cart();
  await clickCheckout(page);

  assert.equal(page.window.localStorage.getItem("tailgate_cart"), null, "cart must be emptied");
  assert.deepEqual(JSON.parse(page.window.localStorage.getItem("tailgate_order")), {
    ref: "a1b2c3d4e5f6",
    token: "tok",
    pickup: "west-asheville",
  });
  await page.close();
});

test("surfaces a server rejection without clearing the cart", async () => {
  const page = await cart({
    orderReply: reply(409, { error: "past_cutoff", message: "Ordering has closed for this market." }),
  });
  await clickCheckout(page);

  assert.match(page.text("#tg-cart-checkout"), /Ordering has closed/, "server reason must reach the customer");
  assert.equal(page.$("#tg-cart-checkout").disabled, false, "the customer must be able to retry");
  assert.ok(page.window.localStorage.getItem("tailgate_cart"), "a rejected order must not empty the cart");
  await page.close();
});

test("surfaces a network failure and lets the customer retry", async () => {
  let attempt = 0;
  const page = await cart({
    orderReply: () => {
      attempt += 1;
      if (attempt === 1) throw new Error("connection reset");
      return reply(201, {
        order_ref: "a1b2c3d4e5f6",
        status_token: "tok",
        redirect_url: "https://square.link/u/TESTCHECKOUT",
      });
    },
  });
  await clickCheckout(page);

  assert.match(page.text("#tg-cart-checkout"), /Network error/i);
  assert.equal(page.$("#tg-cart-checkout").disabled, false);

  await clickCheckout(page);
  assert.ok(page.window.localStorage.getItem("tailgate_order"), "the retry must go through");
  await page.close();
});

test("sends an empty honeypot, so a real customer is never silently swallowed", async () => {
  // The honeypot fakes success when filled. If the client sent a non-empty
  // value, every real order would vanish and the customer would see nothing.
  const page = await cart();
  await clickCheckout(page);

  const post = page.calls.find((c) => c.path === "/api/v1/orders");
  assert.equal(page.requestBody(page.calls.indexOf(post)).tg_verify, "");
  await page.close();
});

test("shows an inline confirmation for a rail with no redirect", async () => {
  // The cash rail confirms out of band; there is no redirect_url to follow.
  const page = await cart({
    orderReply: reply(201, {
      order_ref: "a1b2c3d4e5f6",
      status_token: "tok",
      instructions: "Pay at the market.",
      total_cents: 1200,
    }),
  });
  await clickCheckout(page);

  assert.match(page.bodyText(".tg-cart-checkout"), /Pay at the market/);
  assert.ok(page.$('a[href^="/order-status/"]'), "must offer a way to view the order");
  await page.close();
});


/* -------------------------------------------------------------------------
 * delivery checkout (same goal: address quote becomes the disclosed fee)
 * ------------------------------------------------------------------------ */

async function deliveryCheckoutPage() {
  // whole cake deliverable, slice not — what the availability wire carries
  const deliverableItems = [
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
  ];
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": availability({
        deliveryOption: deliveryOptionFixture(),
        items: deliverableItems,
      }),
      "POST /api/v1/quote": {
        ok: true,
        minutes_one_way: 15,
        round_trip_minutes: 30,
        fee_cents: 1000,
        max_one_way_minutes: 30,
        cents_per_hour: 2000,
      },
      "POST /api/v1/orders": reply(201, {
        order_ref: "deliver01",
        status_token: "tok2",
        redirect_url: "https://square.link/u/TESTCHECKOUT",
      }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "whole", qty: 1 }] },
  });
  // the checkout form renders after availability resolves; settle() is not
  // always enough rounds on the page that also mounts the delivery group
  await page.waitFor("#tg-cart-checkout");
  return page;
}


test("delivery checkout posts the delivery contract shape", async () => {
  const page = await deliveryCheckoutPage();
  console.log(
    "PROBE:",
    "roots=", page.eval("document.querySelectorAll('#tg-cart-root').length"),
    "btns=", page.eval("document.querySelectorAll('#tg-cart-checkout').length"),
    "bodyHasBtn=", page.eval("document.body.innerHTML.includes('tg-cart-checkout')"),
    "len=", page.eval("document.body.innerHTML.length"),
    "docId=", page.eval("document.getElementById('tg-cart-name')?.id || 'none'"),
    "calls=", page.calls.map((c) => c.route).join(","),
    "unavail=", page.eval("document.body.innerHTML.includes('unavailable')"),
    "emptyCart=", page.eval("!!document.querySelector('.tg-cart-empty')"),
  );
  page.eval(
    `document.getElementById("tg-cart-name").value = "Jane Doe";
     document.getElementById("tg-cart-contact").value = "jane@example.com";`
  );
  const radio = page.$("input[name='tg-delivery']");
  radio.checked = true;
  radio.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.settle();
  const input = page.$("#tg-delivery-address");
  input.value = "22 Haywood Rd, Asheville, NC 28806";
  page.$("#tg-delivery-check").click();
  await page.settle();
  await clickCheckout(page);

  const post = page.calls.find((c) => c.path === "/api/v1/orders");
  assert.ok(post, "delivery checkout must POST an order");
  assert.deepEqual(page.requestBody(page.calls.indexOf(post)), {
    drop_id: "2026-09-29",
    fulfillment_type: "delivery",
    address: "22 Haywood Rd, Asheville, NC 28806",
    lines: [{ item: "german-cheesecake", unit: "whole", quantity: 1 }],
    name: "Jane Doe",
    contact: "jane@example.com",
    newsletter: false,
    tg_verify: "",
  });
  await page.close();
});

test("delivery checkout is blocked until the address is checked", async () => {
  const page = await deliveryCheckoutPage();
  page.eval(
    `document.getElementById("tg-cart-name").value = "Jane Doe";
     document.getElementById("tg-cart-contact").value = "jane@example.com";`
  );
  const radio = page.$("input[name='tg-delivery']");
  radio.checked = true;
  radio.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.settle();
  await clickCheckout(page);

  assert.equal(page.calls.find((c) => c.path === "/api/v1/orders"), undefined);
  assert.match(page.alerts.join(" "), /check/i);
  await page.close();
});
