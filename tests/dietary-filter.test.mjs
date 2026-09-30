/**
 * Dietary chips over the Available Now grid.
 *
 * A customer with a dietary need is looking for one answer: "is there anything
 * here I can eat?" Hiding the rest of the grid is the point, so the tests are
 * about what is left visible and about the customer being able to tell a
 * filter is on — a lit chip alone is easy to miss on a phone, and a silently
 * halved grid reads as a short lineup rather than a choice.
 *
 * Slugs and badges come out of the built homepage, so a product that loses its
 * badge cannot leave a chip that filters to nothing behind it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { availability, marketsMap, mount } from "./harness.mjs";

function homepage(search = "") {
  return mount({
    page: "index",
    routes: { "GET /api/v1/availability": { drops: [] } },
    search,
  });
}

/** Cards in the Available Now grid, as {slug, badges[], hidden}.
 *
 * Scoped to the grid on purpose: the page also carries the "Previously
 * Available" list, and those cards are not what the chips filter.
 */
function gridCards(page) {
  return page
    .$$(".product-card")
    .filter((el) => el.closest(".products__grid"))
    .map((el) => ({
      slug: el.id,
      badges: (el.dataset.badges || "").split(/\s+/).filter(Boolean),
      hidden: el.hidden,
    }));
}

const chip = (page, diet) => page.$(`.diet-filter__chip[data-diet="${diet}"]`);

const click = (page, el) =>
  el.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));

test("the chips sit above the product grid, not below it", async () => {
  const page = homepage();
  await page.settle();

  const chips = page.$$(".diet-filter__chip");
  assert.ok(chips.length > 0, "the grid must offer a dietary filter");
  const filter = page.$("[data-diet-filter-group]");
  assert.ok(
    filter.compareDocumentPosition(page.$(".products__grid")) &
      page.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the filter belongs above the grid it filters"
  );
  await page.close();
});

test("a chip is only offered when something in the grid carries the badge", async () => {
  const page = homepage();
  await page.settle();

  for (const el of page.$$(".diet-filter__chip")) {
    const diet = el.dataset.diet;
    const matches = gridCards(page).filter((card) => card.badges.includes(diet));
    assert.ok(
      matches.length > 0,
      `"${diet}" filters to nothing — a dead chip reads as "we have nothing for you"`
    );
  }
  await page.close();
});

test("clicking a chip lights it and hides everything that does not match", async () => {
  const page = homepage();
  await page.settle();

  const before = gridCards(page);
  const gf = chip(page, "gf");
  click(page, gf);
  await page.settle();

  assert.equal(gf.getAttribute("aria-pressed"), "true", "the chosen chip is lit");
  const after = gridCards(page);
  const shown = after.filter((c) => !c.hidden);
  assert.ok(shown.length > 0);
  assert.ok(shown.length < before.length, "the grid is actually narrowed");
  for (const card of shown) {
    assert.ok(card.badges.includes("gf"), `${card.slug} is gluten-free?`);
  }
  for (const card of after.filter((c) => c.hidden)) {
    assert.ok(!card.badges.includes("gf"), `${card.slug} does not claim gluten-free`);
  }
  await page.close();
});

test("only one chip is lit at a time", async () => {
  const page = homepage();
  await page.settle();

  click(page, chip(page, "gf"));
  click(page, chip(page, "vegan"));
  await page.settle();

  const lit = page.$$('.diet-filter__chip[aria-pressed="true"]');
  assert.equal(lit.length, 1, "a second chip replaces the first rather than adding to it");
  await page.close();
});

test("the status line says a filter is applied and how much is left", async () => {
  const page = homepage();
  await page.settle();

  const status = page.$("[data-diet-status]");
  assert.equal(status.hidden, true, "no filter applied, nothing to announce");

  click(page, chip(page, "gf"));
  await page.settle();

  assert.equal(status.hidden, false, "a filtered grid has to announce itself");
  const shown = gridCards(page).filter((c) => !c.hidden).length;
  const total = gridCards(page).length;
  assert.match(status.textContent, new RegExp(`${shown} of ${total}`));
  assert.match(status.textContent, /Gluten-Free/, "and names the filter that is on");
  await page.close();
});

test("Show all clears the filter and puts every card back", async () => {
  const page = homepage();
  await page.settle();
  const total = gridCards(page).length;

  click(page, chip(page, "gf"));
  await page.settle();
  const clear = page.$(".diet-filter__clear");
  assert.ok(clear, "a way out of the filter");
  click(page, clear);
  await page.settle();

  assert.equal(gridCards(page).filter((c) => !c.hidden).length, total);
  assert.equal(chip(page, "gf").getAttribute("aria-pressed"), "false");
  assert.equal(page.$("[data-diet-status]").hidden, true);
  await page.close();
});

test("clicking the lit chip again clears it", async () => {
  const page = homepage();
  await page.settle();
  const total = gridCards(page).length;

  const gf = chip(page, "gf");
  click(page, gf);
  await page.settle();
  click(page, gf);
  await page.settle();

  assert.equal(gridCards(page).filter((c) => !c.hidden).length, total);
  assert.equal(gf.getAttribute("aria-pressed"), "false");
  await page.close();
});

test("a filtered view survives a reload, and a bogus diet is ignored", async () => {
  const filtered = homepage("?diet=dairy-free");
  await filtered.settle();
  assert.equal(chip(filtered, "dairy-free").getAttribute("aria-pressed"), "true");
  assert.equal(filtered.$("[data-diet-status]").hidden, false);
  await filtered.close();

  const bogus = homepage("?diet=gluten-ish");
  await bogus.settle();
  assert.equal(bogus.$$('.diet-filter__chip[aria-pressed="true"]').length, 0);
  assert.ok(bogus.$("[data-diet-status]").hidden);
  await bogus.close();
});

test("the filter stays on the grid — a cart line is not a card that can vanish", async () => {
  const page = mount({
    page: "cart",
    routes: { "GET /api/v1/availability": availability() },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "slice", qty: 1 }] },
  });
  await page.settle();

  assert.equal(page.$("[data-diet-filter-group]"), null, "no chips away from the grid");
  assert.ok(page.$(".tg-cart-row"), "the cart still lists the line");
  await page.close();
});
