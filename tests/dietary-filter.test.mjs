/**
 * Dietary chips over the page's product lists.
 *
 * A customer with a dietary need is looking for one answer: "is there anything
 * I can eat?" Hiding everything else is the point, so the tests are about what
 * is left visible and about the customer being able to tell a filter is on — a
 * lit chip alone is easy to miss on a phone, and a silently halved list reads
 * as a short lineup rather than a choice.
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

/** Items of one product list, as {slug, badges[], hidden}.
 *
 * Each list is scoped to its own container: the chips drive both the Available
 * Now grid and the "Previously Available" list, so an unscoped query would let
 * one list's items answer about the other.
 */
function items(page, list = "products__grid") {
  const selector = list === "products__grid" ? ".product-card" : ".previously__item";
  const nameOf = (el) => (el.id || el.textContent || "").trim().split("\n")[0];
  return page
    .$$(selector)
    .filter((el) => el.closest(`.${list}`))
    .map((el) => ({
      slug: nameOf(el),
      badges: (el.dataset.badges || "").split(/\s+/).filter(Boolean),
      hidden: el.hidden,
    }));
}

const availableNow = (page) => items(page, "products__grid");
const byRequest = (page) => items(page, "previously__list");
const visible = (list) => list.filter((item) => !item.hidden);
const matches = (list, diet) => list.filter((item) => item.badges.includes(diet));

/** Whether every visible item carries all of the named diets, and there is one. */
const allVisibleHave = (list, ...diets) => {
  const shown = visible(list);
  return shown.length > 0 && shown.every((i) => diets.every((d) => i.badges.includes(d)));
};

const chip = (page, diet) => page.$(`.diet-filter__chip[data-diet="${diet}"]`);

const click = (page, el) =>
  el.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));

test("the chips sit above the product lists, not below them", async () => {
  const page = homepage();
  await page.settle();

  const chips = page.$$(".diet-filter__chip");
  assert.ok(chips.length > 0, "the page must offer a dietary filter");
  const filter = page.$("[data-diet-filter-group]");
  for (const list of [page.$(".products__grid"), page.$(".previously__list")]) {
    assert.ok(
      filter.compareDocumentPosition(list) & page.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "the filter belongs above the lists it filters"
    );
  }
  await page.close();
});

test("a chip is only offered when something on the page carries the badge", async () => {
  const page = homepage();
  await page.settle();

  const all = [...availableNow(page), ...byRequest(page)];
  for (const el of page.$$(".diet-filter__chip")) {
    const diet = el.dataset.diet;
    assert.ok(
      matches(all, diet).length > 0,
      `"${diet}" filters to nothing — a dead chip reads as "we have nothing for you"`
    );
  }
  await page.close();
});

test("clicking a chip lights it and hides everything that does not match", async () => {
  const page = homepage();
  await page.settle();

  const before = availableNow(page);
  const gf = chip(page, "gf");
  click(page, gf);
  await page.settle();

  assert.equal(gf.getAttribute("aria-pressed"), "true", "the chosen chip is lit");
  const after = availableNow(page);
  const shown = visible(after);
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

test("the chips filter the by-request list too", async () => {
  const page = homepage();
  await page.settle();

  const before = byRequest(page);
  assert.ok(before.length > 0, "the page must have a by-request list to filter");
  click(page, chip(page, "gf"));
  await page.settle();

  const after = byRequest(page);
  const shown = visible(after);
  assert.ok(shown.length < before.length, "the by-request list is narrowed too");
  for (const item of shown) {
    assert.ok(item.badges.includes("gf"), `${item.slug} is gluten-free?`);
  }
  await page.close();
});

test("several chips can be lit at once", async () => {
  const page = homepage();
  await page.settle();

  click(page, chip(page, "gf"));
  click(page, chip(page, "dairy-free"));
  await page.settle();

  assert.equal(page.$$('.diet-filter__chip[aria-pressed="true"]').length, 2);
  assert.match(page.text("[data-diet-status]"), /Gluten-Free \+ Dairy-Free/);
  await page.close();
});

test("two chips mean both, not either", async () => {
  // A customer who needs to be both gluten-free and dairy-free wants the
  // intersection. A union would put back the items they cannot eat.
  const page = homepage();
  await page.settle();

  const all = [...availableNow(page), ...byRequest(page)];

  click(page, chip(page, "gf"));
  await page.settle();
  const gfOnly = [...visible(availableNow(page)), ...visible(byRequest(page))].length;
  click(page, chip(page, "dairy-free"));
  await page.settle();
  const both = [...visible(availableNow(page)), ...visible(byRequest(page))];

  const expected = all.filter((i) => i.badges.includes("gf") && i.badges.includes("dairy-free"));
  assert.equal(both.length, expected.length, "the intersection, item for item");
  assert.ok(both.length <= gfOnly, "adding a requirement can only narrow the results");
  for (const item of both) {
    assert.ok(item.badges.includes("gf") && item.badges.includes("dairy-free"), item.slug);
  }
  await page.close();
});

test("an empty combination explains itself in the list that emptied", async () => {
  const page = homepage();
  await page.settle();

  click(page, chip(page, "dairy-free"));
  click(page, chip(page, "vegan"));
  await page.settle();

  const lists = [
    { items: availableNow(page), note: page.$(".products__grid .diet-empty") },
    { items: byRequest(page), note: page.$(".previously__list .diet-empty") },
  ];
  for (const { items: list, note } of lists) {
    assert.ok(note, "each list can explain itself");
    assert.equal(note.hidden, visible(list).length > 0, "the note is for the empty case only");
  }
  const emptied = lists.filter(({ items: list }) => visible(list).length === 0);
  for (const { note } of emptied) {
    assert.match(note.textContent, /nothing matches this filter/i);
  }
  if (emptied.length === 0) return; // nothing empties today; no gap to explain

  const status = page.text("[data-diet-status]");
  assert.match(status, /try turning one off/i, "and how to widen the search");
  assert.ok(page.$(".diet-filter__clear"), "one click back to everything");
  await page.close();
});

test("turning one chip off widens the results again", async () => {
  const page = homepage();
  await page.settle();
  const total = availableNow(page).length + byRequest(page).length;

  click(page, chip(page, "dairy-free"));
  click(page, chip(page, "vegan"));
  await page.settle();
  click(page, chip(page, "vegan"));
  await page.settle();

  assert.equal(chip(page, "vegan").getAttribute("aria-pressed"), "false");
  const shown = [...visible(availableNow(page)), ...visible(byRequest(page))];
  assert.ok(shown.length > 0);
  assert.ok(shown.length <= total);
  for (const item of shown) {
    assert.ok(item.badges.includes("dairy-free"), item.slug);
  }
  await page.close();
});

test("Show all clears every chip at once", async () => {
  const page = homepage();
  await page.settle();
  const total = availableNow(page).length + byRequest(page).length;

  click(page, chip(page, "gf"));
  click(page, chip(page, "dairy-free"));
  await page.settle();
  click(page, page.$(".diet-filter__clear"));
  await page.settle();

  assert.equal(page.$$('.diet-filter__chip[aria-pressed="true"]').length, 0);
  assert.equal(visible(availableNow(page)).length + visible(byRequest(page)).length, total);
  assert.equal(page.$("[data-diet-status]").hidden, true);
  assert.equal(page.$(".diet-empty").hidden, true, "no leftover empty-list note");
  await page.close();
});

test("the status line names the filters and reports both lists", async () => {
  const page = homepage();
  await page.settle();

  const status = page.$("[data-diet-status]");
  assert.equal(status.hidden, true, "no filter applied, nothing to announce");

  click(page, chip(page, "gf"));
  await page.settle();

  assert.equal(status.hidden, false, "a filtered page has to announce itself");
  assert.match(status.textContent, /Gluten-Free/, "and names the filter that is on");
  for (const [list, name] of [
    [availableNow(page), "available now"],
    [byRequest(page), "by request"],
  ]) {
    const shown = visible(list).length;
    assert.match(
      status.textContent,
      new RegExp(`${shown} of ${list.length} ${name}`),
      "the customer can tell the by-request list was filtered too"
    );
  }
  await page.close();
});

test("a filtered view survives a reload, and a bogus diet is ignored", async () => {
  const filtered = homepage("?diet=gf,dairy-free");
  await filtered.settle();
  assert.equal(chip(filtered, "gf").getAttribute("aria-pressed"), "true");
  assert.equal(chip(filtered, "dairy-free").getAttribute("aria-pressed"), "true");
  assert.equal(allVisibleHave(availableNow(filtered), "gf", "dairy-free"), true);
  assert.equal(filtered.$("[data-diet-status]").hidden, false);
  await filtered.close();

  const single = homepage("?diet=vegan");
  await single.settle();
  assert.equal(chip(single, "vegan").getAttribute("aria-pressed"), "true");
  assert.equal(single.$$('.diet-filter__chip[aria-pressed="true"]').length, 1);
  await single.close();

  const bogus = homepage("?diet=gluten-ish,nope");
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
