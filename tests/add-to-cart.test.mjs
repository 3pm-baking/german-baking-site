/**
 * Add-to-cart steppers on product cards, and the floating cart badge.
 *
 * The steppers are injected by preorder.js from the availability payload, so
 * they are the one place where "the site shows a product" and "the site can
 * take an order for it" are the same code path.
 *
 * Slugs are read out of the built homepage rather than hardcoded, so these
 * tests keep working as the catalog changes and — more to the point — keep
 * failing if the storefront ever offers something the ordering layer can't
 * take an order for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, cardSlugs, mount } from "./harness.mjs";

/** Mount the homepage with an availability payload built for the real catalog. */
function index({ items, mutate, cart } = {}) {
  // load:false so the slugs can be read out of the grid before the first
  // availability fetch — otherwise the boot fetch races the route swap.
  const page = mount({
    page: "index",
    routes: { "GET /api/v1/availability": { drops: [] } },
    cart,
    load: false,
  });
  const slugs = cardSlugs(page);
  const payload = availability({ items: items(slugs) });
  if (mutate) mutate(payload);
  page.setRoute("GET /api/v1/availability", payload, { rerun: false });
  page.load();
  return { page, slugs, payload };
}

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

test("the built homepage carries add-groups to fill", async () => {
  const { page, slugs } = index({ items: twoUnits });
  assert.ok(slugs.length > 0, "the product grid must expose add-to-cart hooks");
  await page.close();
});

test("renders one stepper box per sellable unit, with its price", async () => {
  const { page, slugs } = index({ items: twoUnits });
  await page.settle();

  assert.equal(page.$$(".tg-add-box").length, 3); // 2 units + 1 unit

  const slice = page.$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`);
  assert.ok(slice, "slice stepper must render");
  assert.match(slice.textContent, /slice · \$6/);
  assert.match(slice.textContent, /\+/, "an empty stepper offers a plus");

  const whole = page.$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="whole"]`);
  assert.match(whole.textContent, /whole · \$45/);
  await page.close();
});

test("reveals the add groups it was able to fill", async () => {
  const { page, slugs } = index({ items: twoUnits });
  await page.settle();

  assert.equal(page.$(`[data-tg-add-group][data-slug="${slugs[0]}"]`).hidden, false);
  assert.equal(page.$(`[data-tg-add-group][data-slug="${slugs[1]}"]`).hidden, false);
  await page.close();
});

test("a sold-out product gets no stepper", async () => {
  const { page, slugs } = index({
    items: twoUnits,
    mutate: (p) => {
      p.drops[0].items[0].sold_out = true;
      p.drops[0].items[0].remaining = 0;
    },
  });
  await page.settle();

  assert.equal(page.$(`.tg-add-box[data-slug="${slugs[0]}"]`), null);
  assert.equal(page.$(`[data-tg-add-group][data-slug="${slugs[0]}"]`).hidden, true);
  await page.close();
});

test("a product not in any open drop gets no stepper", async () => {
  const { page } = index({ items: twoUnits, mutate: (p) => (p.drops[0].fulfillment_options[0].status = "closed") });
  await page.settle();

  assert.equal(page.$$(".tg-add-box").length, 0);
  await page.close();
});

test("stays hidden and breaks nothing when availability fails", async () => {
  // fail-soft: the storefront must render regardless of the ordering service
  const page = mount({
    page: "index",
    routes: {
      "GET /api/v1/availability": () => {
        throw new Error("service down");
      },
    },
  });
  await page.settle();

  assert.equal(page.$$(".tg-add-box").length, 0);
  for (const group of page.$$("[data-tg-add-group]")) assert.equal(group.hidden, true);
  assert.ok(page.$("#products"), "the product grid must survive an API outage");
  await page.close();
});

test("clicking a stepper adds to the cart and the badge", async () => {
  const { page, slugs } = index({ items: twoUnits });
  await page.settle();

  const box = page.$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`);
  box.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();

  assert.deepEqual(JSON.parse(page.window.localStorage.getItem("tailgate_cart")), {
    items: [{ slug: slugs[0], unit: "slice", qty: 1 }],
  });
  assert.equal(page.text("#tg-float-cart-count"), "1");
  assert.equal(page.$("#tg-float-cart").hidden, false);
  assert.match(page.$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`).textContent, /×1/);
  await page.close();
});

test("clicking again increments, and the minus decrements", async () => {
  const { page, slugs } = index({ items: twoUnits });
  await page.settle();

  const box = page.$(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"]`);
  const click = (selector) =>
    page.$(selector).dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));

  box.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle();
  click(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"] .tg-add-box__label`);
  await page.settle();
  assert.equal(page.text("#tg-float-cart-count"), "2");

  click(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"] .tg-add-box__minus`);
  await page.settle();
  assert.equal(page.text("#tg-float-cart-count"), "1");

  click(`.tg-add-box[data-slug="${slugs[0]}"][data-unit="slice"] .tg-add-box__minus`);
  await page.settle();
  assert.equal(page.text("#tg-float-cart-count"), "");
  assert.equal(page.$("#tg-float-cart").hidden, true, "an empty cart hides the button");
  await page.close();
});

test("the badge totals quantities across lines and units", async () => {
  const { page, slugs } = index({ items: twoUnits });
  await page.settle();

  page.eval(`tgCartAdd(${JSON.stringify(slugs[0])}, "slice", 2); tgCartAdd(${JSON.stringify(slugs[1])}, "slice", 3);`);
  await page.settle();

  assert.equal(page.text("#tg-float-cart-count"), "5");
  await page.close();
});

test("a pre-existing cart is reflected in the steppers on load", async () => {
  const page = mount({
    page: "index",
    routes: { "GET /api/v1/availability": { drops: [] } },
    load: false,
  });
  const slugs = cardSlugs(page);
  const [first] = slugs;
  page.setRoute("GET /api/v1/availability", availability({ items: twoUnits(slugs) }), {
    rerun: false,
  });
  page.window.localStorage.setItem(
    "tailgate_cart",
    JSON.stringify({ items: [{ slug: first, unit: "slice", qty: 2 }] })
  );
  page.load();
  await page.settle();

  assert.match(page.$(`.tg-add-box[data-slug="${first}"][data-unit="slice"]`).textContent, /×2/);
  assert.equal(page.text("#tg-float-cart-count"), "2");
  await page.close();
});

test("corrupt cart state does not break the page", async () => {
  const page = mount({
    page: "index",
    routes: { "GET /api/v1/availability": { drops: [] } },
  });
  page.window.localStorage.setItem("tailgate_cart", "{not json");
  page.eval("tgUpdateCartBadge(); tgRefreshAddBoxes();");
  await page.settle();

  assert.equal(page.text("#tg-float-cart-count"), "");
  assert.ok(page.$("#products"));
  await page.close();
});
