/**
 * tailgate front-end — the ordering layer for germanbakingasheville.com.
 *
 * All state is client-side (localStorage); the order. API is the only bridge
 * to the service, and only at two moments: reading availability, and the
 * checkout POST. Prices shown here are display-only — the server recomputes
 * everything authoritatively at order creation.
 *
 * Surfaces:
 *   - add-to-cart steppers on product cards (initAddToCartButtons)
 *   - dietary chips over the Available Now grid (initDietaryFilter)
 *   - cart badge in the nav (updateCartBadge — every page)
 *   - /cart/ page (initCartPage)
 *   - /order-status/ page (initOrderStatusPage)
 */
"use strict";

const TG_API_BASE = (window.TAILGATE_API_BASE || "").replace(/\/$/, "");
const TG_CART_KEY = "tailgate_cart";
const TG_ORDER_KEY = "tailgate_order";

// ---------------------------------------------------------------------------
// cart state (localStorage)
// ---------------------------------------------------------------------------

function tgCartLoad() {
  try {
    return JSON.parse(localStorage.getItem(TG_CART_KEY) || "null") || { items: [] };
  } catch {
    return { items: [] };
  }
}

function tgCartSave(cart) {
  localStorage.setItem(TG_CART_KEY, JSON.stringify(cart));
  tgUpdateCartBadge();
}

function tgCartAdd(slug, unit, qty) {
  const cart = tgCartLoad();
  const existing = cart.items.find((i) => i.slug === slug && i.unit === unit);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.items.push({ slug, unit, qty });
  }
  tgCartSave(cart);
  if (window.gtag) {
    const info = tgAddBoxInfo.get(`${slug}:${unit}`);
    window.gtag("event", "add_to_cart", {
      item: slug,
      unit: unit,
      quantity: qty,
      ...(info && info.priceCents != null ? { value: info.priceCents / 100 } : {}),
    });
  }
}

function tgCartRemove(slug, unit) {
  const cart = tgCartLoad();
  cart.items = cart.items.filter((i) => !(i.slug === slug && i.unit === unit));
  tgCartSave(cart);
}

function tgCartSetQty(slug, unit, qty) {
  const cart = tgCartLoad();
  const item = cart.items.find((i) => i.slug === slug && i.unit === unit);
  if (item) {
    item.qty = Math.max(0, qty);
    if (item.qty === 0) tgCartRemove(slug, unit);
    else tgCartSave(cart);
  }
}

function tgCartCount() {
  return tgCartLoad().items.reduce((sum, i) => sum + i.qty, 0);
}

/** Save the order reference after checkout (drives the nav chip). */
function tgSaveOrder(ref, token, pickupLabel) {
  localStorage.setItem(
    TG_ORDER_KEY,
    JSON.stringify({ ref, token, pickup: pickupLabel, saved_at: Date.now() })
  );
}

// ---------------------------------------------------------------------------
// floating cart button — fixed top-right, appears once the cart has items
// ---------------------------------------------------------------------------

const TG_FLOAT_CART_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">' +
  '<path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.2 14.8l-.1.1c0 .1.1 0 .1 0zM8.1 15h8.3c.8 0 1.5-.5 1.9-1.2l3.6-7.6c.3-.6-.2-1.2-.8-1.2H6.2L5.3 3H2v2h2l3.6 7.6-1.4 2.5c-.7 1.3.2 2.9 1.7 2.9H18v-2H8.1l1.1-2z"/>' +
  "</svg>";

function tgUpdateCartBadge() {
  if (!TG_API_BASE || typeof document === "undefined") return;
  let link = document.getElementById("tg-float-cart");
  if (!link) {
    link = document.createElement("a");
    link.id = "tg-float-cart";
    link.className = "tg-float-cart";
    link.href = "/cart/";
    link.setAttribute("aria-label", "View your pre-order cart");
    link.innerHTML = `${TG_FLOAT_CART_SVG}<span class="tg-float-cart__count" id="tg-float-cart-count"></span>`;
    document.body.appendChild(link);
  }
  const n = tgCartCount();
  link.hidden = n === 0;
  const count = document.getElementById("tg-float-cart-count");
  if (count) count.textContent = n > 0 ? String(n) : "";
}

// ---------------------------------------------------------------------------
// delivery quoting (cart page)
// ---------------------------------------------------------------------------

/** In-memory quote state, kept across cart re-renders. Reset when the cart
 *  page boots. NOTHING here is authoritative: the server re-quotes at order
 *  creation from the same drop, so a stale display cannot misprice an order. */
const tgDeliveryState = {
  dropId: null,
  address: "",
  quote: null, // last /api/v1/quote response
  checked: false, // the "deliver to me" radio
  options: [], // open delivery options seen at render
  zone: null, // zone fallback choice when the quoter is unreachable
  zoneFeeCents: null,
};

function tgResetDeliveryState() {
  tgDeliveryState.dropId = null;
  tgDeliveryState.address = "";
  tgDeliveryState.quote = null;
  tgDeliveryState.checked = false;
  tgDeliveryState.options = [];
  tgDeliveryState.zone = null;
  tgDeliveryState.zoneFeeCents = null;
}

/** Open delivery options across drops, earliest cutoff first. */
function tgDeliveryOptions(availability) {
  const options = [];
  for (const drop of availability.drops) {
    const opt = drop.fulfillment_options.find(
      (o) => o.type === "delivery" && o.status === "open"
    );
    if (opt) options.push({ dropId: drop.drop_id, cutoff: opt.cutoff, delivery: opt.delivery });
  }
  return options.sort((a, b) => new Date(a.cutoff) - new Date(b.cutoff));
}

/** Cart lines whose unit is deliverable on the given drop. */
function tgDeliverableLines(cart, availability, dropId) {
  const drop = availability.drops.find((d) => d.drop_id === dropId);
  if (!drop) return [];
  return cart.items.filter((line) => {
    const item = drop.items.find((i) => i.slug === line.slug);
    const unit = item && item.units.find((u) => u.name === line.unit);
    return Boolean(unit && (unit.fulfillment_types || []).includes("delivery"));
  });
}

/** Quote the chosen drop's delivery fee for an address. Server-cached per
 *  drop+address; the browser keeps its own last answer so re-renders don't
 *  re-bill the provider. */
async function tgQuoteDelivery(dropId, address) {
  const res = await fetch(`${TG_API_BASE}/api/v1/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drop_id: dropId, address }),
  });
  if (!res.ok) {
    return { ok: false, reason: res.status === 429 ? "unavailable" : "unavailable", message: "Could not check delivery for that address right now." };
  }
  return res.json();
}

/** Human rule text, rendered from the drop's quote policy — numbers from
 *  the server, never baked into the front end. Deliberately short: the
 *  range, the rate, and one worked example. */
function tgDeliveryRuleText(quote) {
  const maxMin = quote.max_one_way_minutes;
  const perHour = tgPrice(quote.cents_per_hour);
  const fee15 = tgPrice(Math.round((quote.cents_per_hour * 2 * 15) / 60));
  return `We deliver within ${maxMin} minutes one way. Delivery is ${perHour}/hour ` +
    `of driving: 15 minutes out is ${fee15}.`;
}

// ---------------------------------------------------------------------------
// availability fetching (shared by widget + cart page)
// ---------------------------------------------------------------------------

async function tgFetchAvailability() {
  const res = await fetch(`${TG_API_BASE}/api/v1/availability`);
  if (!res.ok) throw new Error(`availability ${res.status}`);
  return res.json();
}

function tgFindItem(availability, dropId, slug) {
  const drop = availability.drops.find((d) => d.drop_id === dropId);
  if (!drop) return null;
  return drop.items.find((i) => i.slug === slug) || null;
}

function tgUnitInfo(item, unitName) {
  return (item.units || []).find((u) => u.name === unitName) || null;
}

function tgPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Square collects sales tax on top of the line-item sum, so whenever a rate is
 * configured the sum is a SUBTOTAL, not the amount the customer will pay.
 * Label it "Total" and we under-quote by the tax; label it "Subtotal" with no
 * note and it just looks unfinished. The rate comes from the API (never baked
 * into the page) so there is one source of truth for it.
 */
function tgTotalLabel(taxPercent) {
  return taxPercent == null ? "Total" : "Subtotal";
}

/** "2% added at checkout", or "" when untaxed. */
function tgTaxNote(taxPercent) {
  return taxPercent == null ? "" : `${taxPercent}% added at checkout`;
}

/**
 * Highest quantity the cart's quantity dropdown offers for a line.
 *
 * A number input asks the customer to type on a phone keyboard, which is the
 * wrong shape for a number that is always small: a drop caps each item at its
 * `item_cap` (6), so the whole legal range fits in a dropdown.
 *
 * `remaining` is null when the drop does not cap the item, which still needs a
 * ceiling — a 99-option list nobody scrolls. The quantity already in the cart
 * always survives the ceiling, so the dropdown can never contradict the line it
 * is showing.
 */
const QTY_MAX_UNCAPPED = 12;

function tgQtyMax(item, qty) {
  const remaining = item && typeof item.remaining === "number" ? item.remaining : null;
  const ceiling = remaining == null ? QTY_MAX_UNCAPPED : remaining;
  return Math.max(ceiling, qty, 1);
}


// ---------------------------------------------------------------------------
// add-to-cart on the Available Now grid
// ---------------------------------------------------------------------------

/** Add-to-cart buttons on product cards (Available Now grid). */
async function initAddToCartButtons() {
  if (!window.TAILGATE_API_BASE) return;
  let availability;
  try {
    availability = await tgFetchAvailability();
  } catch {
    return; // fail-soft: buttons stay hidden
  }
  const groups = document.querySelectorAll("[data-tg-add-group]");
  for (const group of groups) {
    const slug = group.dataset.slug;
    const drop = availability.drops.find(
      (d) =>
        d["items"].some((i) => i.slug === slug) &&
        d.fulfillment_options.some((o) => o.type === "pickup" && o.status === "open")
    );
    if (!drop) continue; // not orderable right now — stays hidden
    const item = drop["items"].find((i) => i.slug === slug);
    if (!item || item.sold_out) continue;

    // one stepper box per sellable unit: click to add, − to remove
    group.hidden = false;
    for (const unit of item.units) {
      tgAddBoxInfo.set(`${slug}:${unit.name}`, {
        unitName: unit.name,
        priceCents: unit.price_cents,
      });
      const box = document.createElement("div");
      box.className = "tg-add-box";
      box.dataset.slug = slug;
      box.dataset.unit = unit.name;
      group.appendChild(box);
    }
    // delegated clicks: minus decrements, box body increments
    group.addEventListener("click", (event) => {
      const box = event.target.closest(".tg-add-box");
      if (!box) return;
      if (event.target.closest(".tg-add-box__minus")) {
        const line = tgCartLoad().items.find(
          (i) => i.slug === box.dataset.slug && i.unit === box.dataset.unit
        );
        if (line) tgCartSetQuantity(box.dataset.slug, box.dataset.unit, line.qty - 1);
      } else {
        tgCartAdd(box.dataset.slug, box.dataset.unit, 1);
      }
      tgRefreshAddBoxes();
    });
  }
  tgRefreshAddBoxes();
}

/** Update every unit box with its live cart count and stepper controls. */
function tgRefreshAddBoxes() {
  const cart = tgCartLoad();
  document.querySelectorAll(".tg-add-box").forEach((box) => {
    const line = cart.items.find(
      (i) => i.slug === box.dataset.slug && i.unit === box.dataset.unit
    );
    const qty = line ? line.qty : 0;
    const info = tgAddBoxInfo.get(`${box.dataset.slug}:${box.dataset.unit}`);
    let label = box.dataset.unit;
    if (info) {
      label = info.unitName;
      if (info.priceCents != null) {
        const dollars = info.priceCents / 100;
        const price = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
        label = `${label} · ${price}`;
      }
    }
    box.innerHTML = `
      ${qty > 0 ? '<button type="button" class="tg-add-box__minus" aria-label="Remove one">−</button>' : ""}
      <span class="tg-add-box__label">${label}</span>
      <button type="button" class="tg-add-box__plus" aria-label="Add one">${qty > 0 ? "×" + qty : "+"}</button>`;
    box.classList.toggle("tg-add-box--in-cart", qty > 0);
  });
  tgUpdateCartBadge();
}

// unit metadata for box labels (slug:unit -> {unitName, priceCents})
const tgAddBoxInfo = new Map();

function tgFindDropForItem(availability, slug) {
  for (const drop of availability.drops) {
    if (drop["items"].some((i) => i.slug === slug)) return drop.drop_id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// dietary filter on the Available Now grid
// ---------------------------------------------------------------------------

/**
 * Chips that narrow the page's product lists by dietary need. Any number of
 * them can be lit at once, and an item has to match **all** of them.
 *
 * "All", not "any": someone who needs to be both gluten-free and dairy-free is
 * asking for the intersection, and a union would put back exactly the items
 * they cannot eat. The consequence is that some combinations are legitimately
 * empty, so a list that empties says so where the customer is looking rather
 * than leaving a gap, and the line above names the filters and both counts.
 *
 * One set of chips drives both lists — what is in the case now and what can be
 * baked to order — because both answer the same question ("is there anything I
 * can eat?"), and a customer with a restriction should not have to learn two
 * controls to find out.
 *
 * Filtering is client-side because the answer is already in the page: every item
 * carries its own badges as `data-badges`, set from the same product file the
 * item was built from. Only badges something on the page actually carries get a
 * chip, so no combination starts from a chip that could only ever return zero.
 */
function initDietaryFilter() {
  const group = document.querySelector("[data-diet-filter-group]");
  if (!group) return;

  const chips = [...group.querySelectorAll(".diet-filter__chip")];
  const status = group.querySelector("[data-diet-status]");
  const active = new Set();

  const sections = [
    { name: "available now", selector: ".product-card", host: ".products__grid", tag: "p" },
    { name: "by request", selector: ".previously__item", host: ".previously__list", tag: "li" },
  ]
    .map((section) => {
      const el = document.querySelector(section.host);
      if (!el) return null;
      const items = [...el.querySelectorAll(section.selector)];
      if (!items.length) return null;
      // A list emptied by the filter explains itself in place. The customer is
      // looking at that list when they notice, not at the chips.
      const note = document.createElement(section.tag);
      note.className = "diet-empty";
      note.textContent = "Nothing matches this filter.";
      note.hidden = true;
      el.append(note);
      return { ...section, el, items, note };
    })
    .filter(Boolean);
  if (!sections.length) return;

  function apply() {
    const shown = sections.map((section) => {
      let count = 0;
      for (const item of section.items) {
        const badges = tgBadges(item);
        const match = [...active].every((slug) => badges.includes(slug));
        item.hidden = !match;
        if (match) count += 1;
      }
      section.note.hidden = active.size === 0 || count > 0;
      return count;
    });

    for (const chip of chips) {
      chip.setAttribute("aria-pressed", String(active.has(chip.dataset.diet)));
    }

    if (status) {
      // No filter: the status line itself is the answer to "is a filter
      // applied?", so it goes away rather than restating both full lists.
      status.textContent = "";
      status.hidden = active.size === 0;
      if (active.size) {
        // The chip labels, in the order the chips render, so the line reads the
        // way the controls do.
        const names = chips
          .filter((chip) => active.has(chip.dataset.diet))
          .map((chip) => chip.textContent.trim());
        const counts = sections
          .map((section, i) => `${shown[i]} of ${section.items.length} ${section.name}`)
          .join(", ");
        const summary = document.createElement("span");
        summary.textContent = `${names.join(" + ")} — ${counts}`;
        status.append(summary);
        if (shown.every((count) => count === 0)) {
          const hint = document.createElement("span");
          hint.className = "diet-filter__hint";
          hint.textContent = " — try turning one off";
          status.append(hint);
        }
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "diet-filter__clear";
        clear.textContent = "Show all";
        clear.addEventListener("click", () => {
          active.clear();
          apply();
        });
        status.append(clear);
      }
    }

    tgDietInUrl(active);
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const slug = chip.dataset.diet;
      if (active.has(slug)) {
        active.delete(slug);
      } else {
        active.add(slug);
      }
      apply();
    });
  }

  // A filtered view is worth being able to share, so it survives a reload and
  // lives in the URL: /?diet=gf,dairy-free. A single value is the same thing
  // with one name in it, so `?diet=gf` links keep working.
  const requested = (new URLSearchParams(window.location.search).get("diet") || "")
    .split(",")
    .filter((slug) => chips.some((chip) => chip.dataset.diet === slug));
  requested.forEach((slug) => active.add(slug));
  apply();
}

/** Record the active filters in the URL so a refresh (or a shared link) keeps them. */
function tgDietInUrl(active) {
  const url = new URL(window.location.href);
  if (active.size) {
    url.searchParams.set("diet", [...active].join(","));
  } else {
    url.searchParams.delete("diet");
  }
  window.history.replaceState({}, "", url);
}

/** Badge a product claims, plus everything that badge implies.
 *
 * A vegan bake is dairy-free by definition, so "Dairy-Free" has to match it.
 * Without this, a customer who ticks both chips gets an empty page for a
 * combination the bakery actually has — the vegan apricot tart satisfies both.
 * A product's own badges are authoritative; this only ever adds to them.
 */
const TG_BADGE_IMPLIES = {
  vegan: ["dairy-free"],
};

function tgBadges(el) {
  const claimed = (el.dataset.badges || "").split(/\s+/).filter(Boolean);
  const withImplied = new Set(claimed);
  for (const badge of claimed) {
    for (const implied of TG_BADGE_IMPLIES[badge] || []) {
      withImplied.add(implied);
    }
  }
  return [...withImplied];
}

// ---------------------------------------------------------------------------
// /cart/ page
// ---------------------------------------------------------------------------

async function initCartPage() {
  const root = document.getElementById("tg-cart-root");
  if (!root || !window.TAILGATE_API_BASE) return;

  // URL params prefill the cart (shared links, newsletter CTAs)
  prefillFromParams();

  let availability;
  try {
    availability = await tgFetchAvailability();
  } catch (err) {
    root.innerHTML = '<p class="tg-unavailable">Pre-orders are unavailable right now.</p>';
    return;
  }

  try {
    const cart = reconcileCart(tgCartLoad(), availability);
    renderCart(root, cart, availability);
  } catch (err) {
    window.TG_INIT_ERR = String(err && err.stack || err);
    throw err;
  }
}

/** Prefill from query params: ?item=slug&unit=name&qty=N */
function prefillFromParams() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("item");
  if (!slug) return;
  const unit = params.get("unit") || "slice";
  const qty = Math.max(1, parseInt(params.get("qty") || "1", 10) || 1);
  const cart = tgCartLoad();
  const existing = cart.items.find((i) => i.slug === slug && i.unit === unit);
  if (existing) {
    existing.qty = Math.max(existing.qty, qty);
  } else {
    cart.items.push({ slug, unit, qty });
  }
  tgCartSave(cart);
  // clean the URL so refresh doesn't re-add
  window.history.replaceState({}, "", window.location.pathname);
}

/** Clamp quantities to remaining capacity; flag sold-out lines. */
function reconcileCart(cart, availability) {
  const issues = [];
  const validItems = [];
  for (const line of cart.items) {
    // resolve to the earliest OPEN drop carrying this item — never a closed one
    const drop = availability.drops.find(
      (d) =>
        d["items"].some((i) => i.slug === line.slug) &&
        d.fulfillment_options.some((o) => o.type === "pickup" && o.status === "open")
    );
    const item = drop && drop["items"].find((i) => i.slug === line.slug);
    if (!drop || !item || item.sold_out) {
      issues.push({ slug: line.slug, reason: "sold_out" });
      continue;
    }
    // Nothing left to sell is the same outcome as sold out, and the cart's
    // quantity dropdown has no 0: a clamped-to-0 line would render a row whose
    // dropdown disagrees with the quantity stored against it.
    if (item.remaining !== null && item.remaining <= 0) {
      issues.push({ slug: line.slug, reason: "sold_out" });
      continue;
    }
    if (item.remaining !== null && line.qty > item.remaining) {
      issues.push({ slug: line.slug, reason: "clamped", to: item.remaining });
      line.qty = item.remaining;
    }
    validItems.push({ ...line, dropId: drop.drop_id });
  }
  const reconciled = { items: validItems };
  tgCartSave(reconciled);
  return { cart: reconciled, issues };
}

function renderCart(root, { cart, issues }, availability) {
  root.innerHTML = "";

  if (issues.length > 0) {
    const note = document.createElement("p");
    note.className = "tg-cart-note";
    note.textContent =
      "Heads up: " +
      issues
        .map((i) =>
          i.reason === "sold_out"
            ? "one item sold out since you added it"
            : `quantity reduced to ${i.to}`
        )
        .join("; ") +
      ".";
    root.appendChild(note);
  }

  if (cart.items.length === 0) {
    // append, never assign: an innerHTML assignment here would wipe the
    // "sold out" note above, leaving the customer with an empty cart and no
    // idea why it emptied.
    const empty = document.createElement("p");
    empty.className = "tg-cart-empty";
    empty.innerHTML =
      'Your cart is empty. <a href="/#products">Browse what\'s baking →</a>';
    root.appendChild(empty);
    tgUpdateCartBadge();
    return;
  }

  const table = document.createElement("table");
  table.className = "tg-cart-table";
  let totalCents = 0;
  for (const line of cart.items) {
    const item = findItemAnywhere(availability, line.slug);
    const unit = item && item.units.find((u) => u.name === line.unit);
    if (!unit) continue;
    const lineTotal = unit.price_cents * line.qty;
    totalCents += lineTotal;
    const row = document.createElement("tr");
    row.className = "tg-cart-row";
    const max = tgQtyMax(item, line.qty);
    let options = "";
    for (let q = 1; q <= max; q++) {
      options += `<option value="${q}"${q === line.qty ? " selected" : ""}>${q}</option>`;
    }
    row.innerHTML = `
      <td class="tg-cart-item">${item.name} <span class="tg-cart-unit">(${unit.name})</span></td>
      <td class="tg-cart-price">${tgPrice(unit.price_cents)}</td>
      <td class="tg-cart-qty"><select class="tg-cart-qty-select" data-slug="${line.slug}" data-unit="${line.unit}"
            aria-label="Quantity for ${item.name} (${unit.name})">${options}</select></td>
      <td class="tg-cart-line-total" data-line-total>${tgPrice(lineTotal)}</td>
      <td><button type="button" class="tg-cart-remove" data-slug="${line.slug}" data-unit="${line.unit}">×</button></td>
    `;
    table.appendChild(row);
  }
  const taxPercent = availability.tax_percent;
  const totalRow = document.createElement("tfoot");
  totalRow.innerHTML = `
    <tr><th>${tgTotalLabel(taxPercent)}</th><th></th><th></th><th class="tg-cart-total">${tgPrice(totalCents)}</th><th></th></tr>
    ${taxPercent == null ? "" : `<tr class="tg-cart-tax"><th>Sales tax</th><th></th><th></th><th class="tg-cart-tax-note">${tgTaxNote(taxPercent)}</th><th></th></tr>`}`;
  table.appendChild(totalRow);
  root.appendChild(table);

  // pickup options from open drops — radio cards with live countdown
  const pickupOptions = [];
  for (const drop of availability.drops) {
    const opt = drop.fulfillment_options.find((o) => o.type === "pickup" && o.status === "open");
    if (!opt) continue;
    for (const p of opt.pickup_points) {
      pickupOptions.push({
        dropId: drop.drop_id,
        cutoff: opt.cutoff,
        pickupAt: opt.pickup_at,
        point: p,
      });
    }
  }
  pickupOptions.sort((a, b) => new Date(a.cutoff) - new Date(b.cutoff));
  if (pickupOptions.length > 0) {
    const group = document.createElement("fieldset");
    group.className = "tg-cart-field tg-pickup-options";
    const legend = document.createElement("legend");
    legend.textContent = "Pickup at";
    group.appendChild(legend);
    const addPickupCard = (o, i) => {
      const cd = tgCountdown(o.cutoff);
      const day = tgRelativeDay(o.pickupAt || o.cutoff);
      const win = tgPickupWindow(o.point, o.pickupAt);
      const label = document.createElement("label");
      label.className = "tg-pickup-option" + (cd.soon ? " tg-pickup-option--soon" : "");
      label.innerHTML = `
        <input type="radio" name="tg-pickup" value="${o.dropId}|${o.point.slug}" ${i === 0 ? "checked" : ""}>
        <span class="tg-pickup-market">${tgShortMarketName(o.point.label)}</span>
        <span class="tg-pickup-when">${[day, win].filter(Boolean).join(" · ")}</span>
        <span class="tg-pickup-countdown" data-cutoff="${o.cutoff}">${cd.text}</span>
        <span class="tg-pickup-deadline">Order by ${formatCutoff(o.cutoff)}</span>
      `;
      return label;
    };
    // the imminent markets are what nearly everyone picks; the long tail
    // (three weeks out) collapses behind a details toggle so the checkout
    // form stays within one screen
    const visible = pickupOptions.slice(0, 3);
    visible.forEach((o, i) => group.appendChild(addPickupCard(o, i)));
    if (pickupOptions.length > visible.length) {
      const more = document.createElement("details");
      more.className = "tg-more-pickup";
      more.innerHTML = `<summary>${pickupOptions.length - visible.length} later pickup dates</summary><div class="tg-more-pickup-list"></div>`;
      const list = more.querySelector(".tg-more-pickup-list");
      pickupOptions.slice(visible.length).forEach((o, i) => list.appendChild(addPickupCard(o, i + visible.length)));
      group.appendChild(more);
      // the countdown ticker queries the whole fieldset, hidden cards
      // included, so collapsed dates still tick
    }
    root.appendChild(group);
    tgStartPickupTicker(group);
  }

  // delivery option — address-based quoting with the pickup cards kept
  // intact as the fail-soft alternative
  tgRenderDeliveryGroup(root, availability, cart);

  // contact + newsletter + checkout
  const form = document.createElement("div");
  form.className = "tg-cart-checkout";
  form.innerHTML = `
    <label class="tg-cart-field"><span>Name</span> <input type="text" id="tg-cart-name" maxlength="200" required></label>
    <label class="tg-cart-field"><span>Email or phone</span> <input type="text" id="tg-cart-contact" maxlength="200" required></label>
    <input type="text" name="tg_verify" class="tg-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    ${availability.newsletter_enabled ? `
    <label class="tg-cart-field tg-cart-newsletter">
      <input type="checkbox" id="tg-cart-newsletter">
      Also send me the monthly newsletter
    </label>` : ""}
    <button type="button" id="tg-cart-checkout" class="tg-cart-checkout-btn">Checkout</button>
    <p class="tg-cart-fineprint">Payment via Square: cards, Apple Pay, Google Pay, Cash App.</p>
  `;
  root.appendChild(form);

  // wire quantity changes + remove buttons
  root.querySelectorAll(".tg-cart-qty select").forEach((input) => {
    input.addEventListener("change", () => {
      tgCartSetQuantity(input.dataset.slug, input.dataset.unit, parseInt(input.value, 10) || 1);
      rerenderCart(root, availability);
    });
  });
  root.querySelectorAll(".tg-cart-remove").forEach((button) => {
    button.addEventListener("click", () => {
      tgCartRemove(button.dataset.slug, button.dataset.unit);
      rerenderCart(root, availability);
    });
  });

  // checkout
  const checkoutButton = root.querySelector("#tg-cart-checkout");
  checkoutButton.addEventListener("click", () => checkout(root, availability));
}

function findItemAnywhere(availability, slug) {
  for (const drop of availability.drops) {
    const item = drop["items"].find((i) => i.slug === slug);
    if (item) return item;
  }
  return null;
}

/** The delivery fieldset: one radio card per open delivery drop, an address
 *  box that quotes the fee, and the rule spelled out in the drop's own
 *  numbers. Purely additive over the pickup cards — an unreachable quote
 *  service degrades to "can't check right now", never to a broken cart. */
function tgRenderDeliveryGroup(root, availability, cart) {
  const options = tgDeliveryOptions(availability);
  if (options.length === 0) {
    tgDeliveryState.checked = false;
    tgDeliveryState.dropId = null;
    return;
  }
  // seed/pin the state to the first open option; a stale drop from a
  // previous render resolves here
  tgDeliveryState.dropId = options[0].dropId;
  tgDeliveryState.options = options;
  const deliverable = tgDeliverableLines(
    tgCartLoad(),
    availability,
    tgDeliveryState.dropId
  );
  if (deliverable.length === 0) return; // nothing in the cart can be delivered

  const first = options[0];
  // the per-drop delivery minimum counts deliverable items only — slices
  // riding along for pickup never meet it on their own
  const deliverableTotalCents = deliverable.reduce((sum, line) => {
    const item = findItemAnywhere(availability, line.slug);
    const unit = item && item.units.find((u) => u.name === line.unit);
    return sum + (unit ? unit.price_cents * line.qty : 0);
  }, 0);
  const minCents = first.delivery ? first.delivery.min_order_cents : null;
  const belowMinimum = minCents != null && deliverableTotalCents < minCents;
  if (belowMinimum) tgDeliveryState.checked = false; // greyed: not selectable

  const group = document.createElement("fieldset");
  group.className = "tg-cart-field tg-delivery-options";
  const legend = document.createElement("legend");
  legend.textContent = "Or deliver to me";
  group.appendChild(legend);
  const ruleText = first.delivery && first.delivery.quote ? tgDeliveryRuleText(first.delivery.quote) : "";
  const minNote =
    belowMinimum && minCents != null
      ? `Delivery needs a minimum of ${tgPrice(minCents)} in whole items — slices only deliver with them.`
      : "";
  const label = document.createElement("label");
  label.className =
    "tg-delivery-option" + (belowMinimum ? " tg-delivery-option--disabled" : "");
  label.innerHTML = `
    <input type="radio" name="tg-delivery" value="${first.dropId}" ${tgDeliveryState.checked ? "checked" : ""} ${belowMinimum ? "disabled" : ""}>
    <span class="tg-delivery-label">Deliver to me</span>
    <span class="tg-delivery-rule">${ruleText}${minNote ? ` ${minNote}` : ""}</span>
  `;
  group.appendChild(label);

  const addressRow = document.createElement("div");
  addressRow.className = "tg-delivery-address";
  addressRow.hidden = !tgDeliveryState.checked;
  addressRow.innerHTML = `
    <input type="text" id="tg-delivery-address" maxlength="200"
      placeholder="Your street address, city, ZIP"
      value="${tgDeliveryState.address.replace(/"/g, "&quot;")}">
    <button type="button" id="tg-delivery-check">Check</button>
    <p class="tg-delivery-status" data-delivery-status>
      ${tgDeliveryState.quote ? "" : "Enter your address to check the delivery fee and time."}
    </p>
  `;
  group.appendChild(addressRow);
  root.appendChild(group);

  const radio = label.querySelector("input");
  radio.addEventListener("change", () => {
    tgDeliveryState.checked = radio.checked;
    if (radio.checked) {
      // pickup and delivery are exclusive choices
      const checkedPickup = root.querySelector("input[name='tg-pickup']:checked");
      if (checkedPickup) checkedPickup.checked = false;
      const quote = tgDeliveryState.quote;
      if (quote && quote.ok) tgShowDeliveryResult(root, quote);
      else tgQuoteRequested(root);
    }
    addressRow.hidden = !radio.checked;
  });

  const addressInput = addressRow.querySelector("#tg-delivery-address");
  addressInput.addEventListener("input", () => {
    tgDeliveryState.address = addressInput.value;
  });
  addressInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      addressRow.querySelector("#tg-delivery-check").click();
    }
  });

  const checkButton = addressRow.querySelector("#tg-delivery-check");
  checkButton.addEventListener("click", async () => {
    const address = addressInput.value.trim();
    if (address.length < 5) return;
    checkButton.disabled = true;
    checkButton.textContent = "Checking…";
    try {
      const quote = await tgQuoteDelivery(tgDeliveryState.dropId, address);
      tgDeliveryState.quote = quote;
      tgShowDeliveryResult(root, quote);
    } catch {
      tgShowDeliveryResult(root, { ok: false, reason: "unavailable" });
    } finally {
      checkButton.disabled = false;
      checkButton.textContent = "Check";
    }
  });

  // a later pickup click unselects delivery
  root.querySelectorAll("input[name='tg-pickup']").forEach((pickupRadio) => {
    pickupRadio.addEventListener("change", () => {
      if (pickupRadio.checked) {
        tgDeliveryState.checked = false;
        radio.checked = false;
        tgRemoveDeliveryTotal(root);
        const status = root.querySelector("[data-delivery-status]");
        if (status) status.textContent = "Enter your address to check the delivery fee and time.";
      }
    });
  });

  // re-show the cached quote after a re-render
  if (tgDeliveryState.checked && tgDeliveryState.quote) {
    tgShowDeliveryResult(root, tgDeliveryState.quote);
  }
}

/** Render the quote result into the delivery status line and the total row.
 *  All customer-safe: a quote failure says what to do (pick up), not "error 500". */
function tgShowDeliveryResult(root, quote) {
  const status = root.querySelector("[data-delivery-status]");
  if (!status) return;
  tgRemoveDeliveryTotal(root);
  const checkoutButton = root.querySelector("#tg-cart-checkout");
  if (quote.ok) {
    status.textContent =
      `${quote.minutes_one_way} min away · ${tgPrice(quote.fee_cents)} delivery`;
    checkoutButton.disabled = false;
    const table = root.querySelector(".tg-cart-table tfoot");
    if (table) {
      const row = document.createElement("tr");
      row.className = "tg-cart-delivery";
      // row IS the <tr>; assigning another would be discarded by the parser
      row.innerHTML = `<th class="tg-delivery-row-label">Delivery fee</th><th></th><th></th><th class="tg-delivery-fee">${tgPrice(quote.fee_cents)}</th><th></th>`;
      table.appendChild(row);
    }
  } else if (quote.reason === "too_far") {
    status.textContent =
      `${quote.minutes_one_way} minutes away is outside our ` +
      `${quote.max_one_way_minutes || 30}-minute delivery range. Pickup is still open.`;
    checkoutButton.disabled = false;
  } else {
    status.textContent =
      "Could not check delivery from that address right now. You can still order for pickup.";
    checkoutButton.disabled = false;
    tgRenderZoneFallback(root);
  }
}

/** Quote-unreachable fallback when the drop carries zone pricing: the fee
 *  comes from the same tiers the server would charge. Absent tiers, nothing
 *  renders — delivery simply cannot be quoted here. */
function tgRenderZoneFallback(root) {
  const delivery =
    tgDeliveryState.options.length > 0 ? tgDeliveryState.options[0].delivery : null;
  if (!delivery || !delivery.fee_tiers || delivery.fee_tiers.length === 0) return;
  if (root.querySelector("#tg-delivery-zone")) return; // already rendered
  const host = root.querySelector(".tg-delivery-address");
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <label class="tg-delivery-zone-label">Or choose your area
      <select id="tg-delivery-zone">
        ${delivery.fee_tiers.map(([zone, cents]) => `<option value="${zone}">${zone.replace(/-/g, " ")} · ${tgPrice(cents)}</option>`).join("")}
        <option value="" ${delivery.default_fee_cents ? "" : "selected"}>Other · ${tgPrice(delivery.default_fee_cents)}</option>
      </select>
    </label>
  `;
  host.appendChild(wrap);
  wrap.querySelector("#tg-delivery-zone").addEventListener("change", (ev) => {
    const zone = ev.target.value;
    const tiers = Object.fromEntries(delivery.fee_tiers);
    tgDeliveryState.zoneFeeCents = tiers[zone] != null ? tiers[zone] : delivery.default_fee_cents;
    tgDeliveryState.zone = zone;
    const row = root.querySelector(".tg-cart-table tfoot");
    if (row) {
      tgRemoveDeliveryTotal(root);
      const tr = document.createElement("tr");
      tr.className = "tg-cart-delivery";
      tr.innerHTML = `<th class="tg-delivery-row-label">Delivery fee</th><th></th><th></th><th class="tg-delivery-fee">${tgPrice(tgDeliveryState.zoneFeeCents)}</th><th></th>`;
      row.appendChild(tr);
    }
  });
}

function tgRemoveDeliveryTotal(root) {
  root.querySelectorAll(".tg-cart-delivery").forEach((el) => el.remove());
}

/** A freshly-requested quote clears the old display. */
function tgQuoteRequested(root) {
  const status = root.querySelector("[data-delivery-status]");
  if (status) status.textContent = "";
  tgRemoveDeliveryTotal(root);
}

function tgCartSetQuantity(slug, unit, qty) {
  const cart = tgCartLoad();
  const item = cart.items.find((i) => i.slug === slug && i.unit === unit);
  if (item) {
    item.qty = qty;
    if (qty <= 0) cart.items = cart.items.filter((i) => i !== item);
    tgCartSave(cart);
  }
}

function rerenderCart(root, availability) {
  const reconciled = reconcileCart(tgCartLoad(), availability);
  renderCart(root, reconciled, availability);
}

function tgCartClear() {
  localStorage.removeItem(TG_CART_KEY);
  tgUpdateCartBadge();
}

/* --- purchase attribution ----------------------------------------------
 *
 * Square redirects a paying customer back to /order-status/?ref=..&token=..
 * (tailgate/src/tailgate/service.py builds that redirect_url), and
 * renderOrderStatus fires `purchase` from there. Two additions on top of the
 * original implementation:
 *
 *   - a localStorage flag set at checkout_click, reported as the
 *     `checkout_initiated` parameter. The status page is also reachable via
 *     "lost your order link", so a purchase fired from a browser that never
 *     went through checkout is a *later check-in*, not a return-from-payment.
 *     GA4 cannot tell those apart on its own, and `transaction_id` dedup does
 *     not help across sessions.
 *   - the flag is reported rather than used to suppress the event, so a
 *     cross-device check-in still records a purchase instead of silently
 *     losing it.
 *
 * The flag does not make GA4 a reliable count of orders: a customer who closes
 * the tab after paying never fires anything. tailgate's database is the ground
 * truth; `expenses preorders reconcile` is what measures the gap.
 */

const TG_CHECKOUT_FLAG = "tailgate_checkout_initiated";

function tgMarkCheckoutInitiated() {
  try {
    localStorage.setItem(TG_CHECKOUT_FLAG, "1");
  } catch {
    // Private mode or storage disabled. The purchase event still fires; it
    // just reports checkout_initiated=false.
  }
}

function tgConsumeCheckoutFlag() {
  try {
    const wasSet = localStorage.getItem(TG_CHECKOUT_FLAG) === "1";
    localStorage.removeItem(TG_CHECKOUT_FLAG);
    return wasSet;
  } catch {
    return false;
  }
}

async function checkout(root, availability) {
  const cart = tgCartLoad();
  if (cart.items.length === 0) return;
  const name = root.querySelector("#tg-cart-name").value.trim();
  const contact = root.querySelector("#tg-cart-contact").value.trim();
  const newsletterInput = root.querySelector("#tg-cart-newsletter");
  if (!name || !contact) {
    alert("Please fill in your name and contact.");
    return;
  }

  // delivery radio checked → delivery checkout; slots ineligible lines
  // (slices) out — the server would reject them, and they never counted
  // toward the minimum either
  const deliveryRadio = root.querySelector("input[name='tg-delivery']:checked");
  if (deliveryRadio && tgDeliveryState.checked) {
    const dropId = deliveryRadio.value;
    const deliverable = tgDeliverableLines(cart, availability, dropId);
    if (deliverable.length === 0) {
      alert("None of the items in your cart can be delivered — choose pickup instead.");
      return;
    }
    const quote = tgDeliveryState.quote;
    const zoneFee = tgDeliveryState.zoneFeeCents;
    // a valid quote or a chosen zone must exist; the server re-quotes
    // authoritatively and re-enforces the minimum
    const needsQuote = !quote || !quote.ok;
    if (needsQuote && zoneFee == null) {
      alert("Please enter and check your delivery address first.");
      return;
    }
    // read the live input — the module state is not authoritative here, a
    // customer who edits the address after checking must not repost a
    // stale one
    const addressInput = root.querySelector("#tg-delivery-address");
    const address = (addressInput ? addressInput.value : tgDeliveryState.address).trim();
    tgDeliveryState.address = address;
    if (address.length < 5) {
      alert("Please enter the delivery address.");
      return;
    }
    const button = root.querySelector("#tg-cart-checkout");
    button.disabled = true;
    button.textContent = "Starting checkout…";
    if (window.gtag) window.gtag("event", "checkout_click", { items: deliverable.length, fulfillment: "delivery" });
    tgMarkCheckoutInitiated();
    try {
      const response = await fetch(`${TG_API_BASE}/api/v1/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drop_id: dropId,
          fulfillment_type: "delivery",
          address,
          lines: deliverable.map((i) => ({ item: i.slug, unit: i.unit, quantity: i.qty })),
          name,
          contact,
          newsletter: newsletterInput ? newsletterInput.checked : false,
          tg_verify: (root.querySelector("input[name='tg_verify']") || {}).value || "",
        }),
      });
      const data = await response.json();
      if (response.status === 201) {
        localStorage.setItem(
          TG_ORDER_KEY,
          JSON.stringify({ ref: data.order_ref, token: data.status_token, pickup: "delivery" })
        );
        tgCartClear();
        if (data.redirect_url) {
          window.location.href = data.redirect_url; // → Square hosted checkout
          return;
        }
        root.querySelector(".tg-cart-checkout").innerHTML = `
          <p class="tg-cart-note">Order reserved. ${data.instructions || "pay on delivery"}.</p>
          <p><a href="/order-status/?ref=${encodeURIComponent(data.order_ref)}&token=${encodeURIComponent(data.status_token)}">View your order status →</a></p>`;
        return;
      }
      // server-side rules (too far, minimum, cutoff, limit) surface verbatim
      button.disabled = false;
      button.textContent = data.message || "Something went wrong. Try again.";
    } catch (err) {
      button.disabled = false;
      button.textContent = "Network error, try again";
    }
    return;
  }

  const pickupInput = root.querySelector("input[name='tg-pickup']:checked");
  const pickupValue = pickupInput ? pickupInput.value : "";
  if (!pickupValue) {
    alert("Choose pickup or delivery to continue.");
    return;
  }
  const [dropId, pickupSlug] = pickupValue.split("|");
  const button = root.querySelector("#tg-cart-checkout");
  button.disabled = true;
  button.textContent = "Starting checkout…";
  if (window.gtag) {
    window.gtag("event", "checkout_click", { items: cart.items.length });
  }
  // Remember that THIS browser started a checkout. Square sends the customer
  // back to /order-status/ after paying, and that redirect is the only place a
  // purchase can be attributed to a session. Without this flag we cannot tell
  // "paid and just came back" from "opened the link again a week later".
  tgMarkCheckoutInitiated();
  try {
    const response = await fetch(`${TG_API_BASE}/api/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drop_id: dropId,
        fulfillment_type: "pickup",
        pickup_point: pickupSlug,
        lines: cart.items.map((i) => ({ item: i.slug, unit: i.unit, quantity: i.qty })),
        name,
        contact,
        newsletter: newsletterInput ? newsletterInput.checked : false,
        tg_verify: (root.querySelector("input[name='tg_verify']") || {}).value || "",
      }),
    });
    const data = await response.json();
    if (response.status === 201) {
      localStorage.setItem(
        TG_ORDER_KEY,
        JSON.stringify({ ref: data.order_ref, token: data.status_token, pickup: pickupSlug })
      );
      tgCartClear();
      if (data.redirect_url) {
        window.location.href = data.redirect_url; // → Square hosted checkout
        return;
      }
      // manual rail (e.g. pay at pickup): show confirmation inline
      root.querySelector(".tg-cart-checkout").innerHTML = `
        <p class="tg-cart-note">Order reserved. ${data.instructions || "pay at pickup"}.</p>
        <p><a href="/order-status/?ref=${encodeURIComponent(data.order_ref)}&token=${encodeURIComponent(data.status_token)}">View your order status →</a></p>`;
      return;
    }
    // order-level errors (sold out, cutoff, limit)
    button.disabled = false;
    button.textContent = data.message || "Something went wrong. Try again.";
  } catch (err) {
    button.disabled = false;
    button.textContent = "Network error, try again";
  }
}

// ---------------------------------------------------------------------------
// /order-status/ page
// ---------------------------------------------------------------------------

async function initOrderStatusPage() {
  const root = document.getElementById("tg-status-root");
  if (!root || !window.TAILGATE_API_BASE) return;
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref");
  const token = params.get("token");
  if (!ref || !token) {
    root.innerHTML = "<p>Missing order link information.</p>";
    return;
  }
  // map item slugs -> display names and pickup slugs -> point details
  // via the availability data
  let nameMap = {};
  let pointMap = {};
  try {
    const availability = await tgFetchAvailability();
    for (const drop of availability.drops) {
      for (const item of drop["items"]) nameMap[item.slug] = item.name;
      for (const opt of drop.fulfillment_options) {
        for (const p of opt.pickup_points) pointMap[p.slug] = p;
      }
    }
  } catch {
    // fail-soft: slugs are still readable
  }
  const loadOrder = async () => {
    const res = await fetch(
      `${TG_API_BASE}/api/v1/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`
    );
    if (res.status === 403 || res.status === 404) {
      root.innerHTML = "<p>This order link is not valid.</p>";
      return null;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  };
  try {
    const order = await loadOrder();
    if (!order) return;
    renderOrderStatus(root, order, ref, token, nameMap, pointMap);
    // Square's webhook can land after the customer reaches this page, so a
    // pending order re-checks until it flips to paid (or a terminal state).
    const pending = order.status === "pending";
    if (pending) {
      let delay = 5000;
      const poll = async () => {
        try {
          const fresh = await loadOrder();
          if (!fresh) return;
          if (fresh.status !== order.status) {
            renderOrderStatus(root, fresh, ref, token, nameMap, pointMap);
            return;
          }
        } catch {
          // transient network/API hiccup — keep polling
        }
        delay = Math.min(delay * 2, 30000);
        setTimeout(poll, delay);
      };
      setTimeout(poll, delay);
    }
  } catch (err) {
    root.innerHTML = '<p class="tg-unavailable">Could not load your order right now.</p>';
  }
}

/** "See you at the market" card: market name, date/time, Maps link, hours.
 *  The market name comes from the ORDER, not from /availability: availability
 *  is unreachable exactly when it matters (the day after pickup, once the drop
 *  has aged out of the publish window), and a card that falls back to the raw
 *  slug would print "Pickup: west-asheville" at a customer. Fail-soft is
 *  "less detail", never "raw identifier". */
function tgPickupCard(order, points = {}, token = "") {
  const point = points[order.pickup_point];
  const label = order.pickup_label || (point && point.label);
  if (!label) return "";
  const market = window.TAILGATE_MARKETS && window.TAILGATE_MARKETS[label];
  let when = "";
  if (order.pickup_at) {
    try {
      const date = new Date(order.pickup_at).toLocaleDateString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      const win = tgPickupWindow(point || {}, order.pickup_at);
      when = `<p class="tg-market-card__when">${[date, win].filter(Boolean).join(" · ")}</p>`;
    } catch {
      when = "";
    }
  }
  const mapsLink =
    market && market.address
      ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(market.address)}"
          target="_blank" rel="noopener noreferrer" class="tg-market-card-map"
          onclick="gtag('event', 'maps_click', {market: '${label.replace(/'/g, "\\'")}'});">${market.address}</a>`
      : "";
  const siteLink =
    market && market.url
      ? `<a href="${market.url}" target="_blank" rel="noopener noreferrer">Market website →</a>`
      : "";
  const schedule = market && market.schedule_display
    ? `<p class="tg-market-card-schedule">${market.schedule_display}</p>`
    : "";
  const heading =
    order.status === "paid" || order.status === "fulfilled"
      ? `See you at ${label}`
      : `Pickup at ${label}`;
  const calLink = order.pickup_at
    ? `<a href="${TG_API_BASE}/api/v1/orders/${encodeURIComponent(order.order_ref)}/calendar.ics?token=${encodeURIComponent(token)}"
          class="tg-market-card-cal" download="pickup.ics">Add to calendar</a>`
    : "";
  return `
    <div class="tg-market-card">
      <p class="tg-market-card-heading">${heading}</p>
      ${when}
      ${mapsLink ? `<p class="tg-market-card-address">${mapsLink}</p>` : ""}
      ${schedule}
      ${siteLink ? `<p class="tg-market-card-link">${siteLink}</p>` : ""}
      ${calLink ? `<p class="tg-market-card-cal-row">${calLink}</p>` : ""}
    </div>
  `;
}

/** GA4 purchase event when an order is (or flips to) paid. Guarded by
 * sessionStorage so polling re-renders don't re-fire; GA4 also dedupes
 * purchase events by transaction_id. No PII: ref, value, items only.
 *
 * `no_show` is included because the money was still taken — excluding it would
 * make GA4 disagree with tailgate's paid count for a reason that has nothing to
 * do with tracking, which is exactly the kind of drift the reconciliation
 * should be reserved for. */
function tgTrackPurchase(order, nameMap = {}) {
  if (!window.gtag) return;
  if (order.status !== "paid" && order.status !== "fulfilled" && order.status !== "no_show") return;
  const key = `tg_purchase_${order.order_ref}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // storage blocked — GA4's transaction_id dedup still applies
  }
  window.gtag("event", "purchase", {
    transaction_id: order.order_ref,
    value: order.total_cents / 100,
    currency: "USD",
    market: order.pickup_label || order.pickup_point,
    // False means this browser never started a checkout: a later status check
    // rather than a return from payment. Reported, not suppressed.
    checkout_initiated: tgConsumeCheckoutFlag(),
    items: order.lines.map((line) => ({
      item_id: line.item_slug,
      item_name: line.item_name || nameMap[line.item_slug] || line.item_slug,
      item_variant: line.unit_name,
      price: line.unit_price_cents / 100,
      quantity: line.quantity,
    })),
  });
}

function renderOrderStatus(root, order, ref, token, nameMap = {}, points = {}) {
  tgTrackPurchase(order, nameMap);
  const statusLabels = {
    pending: "Awaiting payment",
    paid: "Paid! See you at pickup.",
    fulfilled: "Picked up ✓",
    no_show: "Missed pickup",
    canceled: "Canceled",
    expired: "Expired",
  };
  // The order carries its own display names, resolved server-side from the
  // drop's catalog. nameMap (from /availability) is only a backstop for
  // responses predating that field — never the primary source, and never a
  // reason to print a slug at a customer.
  const displayName = (line) => line.item_name || nameMap[line.item_slug] || line.item_slug;
  const rows = order.lines
    .map((line) => `<tr><td>${displayName(line)} (${line.unit_name})</td><td>×${line.quantity}</td></tr>`)
    .join("");
  const cancellable = order.cancellable && window.TAILGATE_API_BASE;
  const cancelDeadline = order.cancellation_deadline
    ? `<p class="tg-muted">Cancellations close <strong>${formatCutoff(order.cancellation_deadline)}</strong>.</p>`
    : `<p class="tg-muted">Cancellations close at the order deadline.</p>`;
  const waiting =
    order.status === "pending"
      ? `<p class="tg-muted tg-status-waiting">Confirming your payment — this page updates automatically, no need to refresh.</p>`
      : "";
  root.innerHTML = `
    <p><span class="tg-badge${order.status === "paid" ? " tg-badge--paid" : ""}${order.status === "pending" ? " tg-badge--pending" : ""}">${statusLabels[order.status] || order.status}</span></p>
    <table class="tg-cart-table">
      ${rows}
      <tfoot>
        <tr><th>${tgTotalLabel(order.tax_percent)}</th><th>$${(order.total_cents / 100).toFixed(2)}</th></tr>
        ${order.tax_percent == null ? "" : `<tr class="tg-cart-tax"><th>Sales tax</th><th>${tgTaxNote(order.tax_percent)}</th></tr>`}
      </tfoot>
    </table>
    ${waiting}
    ${tgPickupCard(order, points, token)}
    ${cancellable ? `
      <button type="button" id="tg-cancel-order" class="tg-cancel-btn">Cancel order</button>
      ${cancelDeadline}
      <p class="tg-muted tg-status-hint">Lost this link? <a href="/orders/">Get a fresh one by email</a>.</p>` : ""}
  `;
  if (cancellable) {
    root.querySelector("#tg-cancel-order").addEventListener("click", async () => {
      const res = await fetch(
        `${TG_API_BASE}/api/v1/orders/${encodeURIComponent(ref)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }
      );
      if (res.ok) {
        renderOrderStatus(root, { ...order, status: "canceled" }, ref, token, nameMap, points);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.message || "Could not cancel. Contact us and we'll help.");
      }
    });
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

if (typeof document !== "undefined") {
  const boot = () => {
    tgUpdateCartBadge();
    initDietaryFilter();
    if (document.getElementById("tg-cart-root")) initCartPage();
    if (document.getElementById("tg-status-root")) initOrderStatusPage();
    if (document.getElementById("tg-lookup-form")) initLookupPage();
    if (document.querySelector("[data-tg-add-group]")) initAddToCartButtons();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

// ---------------------------------------------------------------------------
// /orders/ page — find-my-order recovery
// ---------------------------------------------------------------------------

function initLookupPage() {
  const form = document.getElementById("tg-lookup-form");
  if (!form || !window.TAILGATE_API_BASE) return;
  const result = document.getElementById("tg-lookup-result");
  const button = document.getElementById("tg-lookup-btn");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("tg-lookup-email").value.trim();
    if (!email) return;
    const hp = form.querySelector("input[name='tg_verify']");
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const res = await fetch(`${TG_API_BASE}/api/v1/orders/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: email, tg_verify: hp ? hp.value : "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        let html = `<p>${data.message || "If an order exists for that email, we've sent the link(s)."}</p>`;
        for (const order of data.orders || []) {
          html += `
            <div class="tg-lookup-order">
              <p class="tg-lookup-order-status">${order.status === "paid" ? "Paid" : "Awaiting payment"} · $${(order.total_cents / 100).toFixed(2)}</p>
              ${order.items.map((i) => `<p class="tg-lookup-order-item">${i}</p>`).join("")}
              <p class="tg-muted">Link sent to ${order.contact_masked}</p>
            </div>`;
        }
        result.innerHTML = html;
      } else {
        result.textContent = data.detail || data.message || "Something went wrong. Try again.";
      }
    } catch {
      result.textContent = "Network error, try again";
    }
    result.hidden = false;
    button.disabled = false;
    button.textContent = "Email me my links";
  });
}

/** Human cutoff: "Sunday, Sep 27 at 1:48 PM" — date always included. */
function formatCutoff(iso) {
  try {
    return (
      new Date(iso).toLocaleString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      }) +
      " at " +
      new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// pickup-option helpers (all presentation math is client-side; the API only
// publishes raw ISO timestamps)
// ---------------------------------------------------------------------------

/** "West Asheville Tailgate Market" → "West Asheville". */
function tgShortMarketName(label) {
  return label.replace(/\s+Tailgate Market$/i, "");
}

/** "15:30" → "3:30 PM". */
function tgFormatClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Pickup window for display: "3:30–6:30 PM" from window fields, else the
 * single pickup_at time, else null (fail-soft — segment is omitted). */
function tgPickupWindow(point, pickupAtIso) {
  if (point.window_start && point.window_end) {
    return `${tgFormatClock(point.window_start)}–${tgFormatClock(point.window_end)}`;
  }
  if (pickupAtIso) {
    try {
      return new Date(pickupAtIso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return null;
    }
  }
  return null;
}

/** Relative day label: "This Tuesday" when the date falls within the next
 * 7 days, else "Tue, Oct 6". */
function tgRelativeDay(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const weekAhead = new Date(now);
    weekAhead.setDate(weekAhead.getDate() + 7);
    if (d >= now && d <= weekAhead) {
      return `This ${d.toLocaleDateString([], { weekday: "long" })}`;
    }
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/** Countdown to an order cutoff: "2d 4h left" → "5h left" (<24h) →
 * "45m left" (<1h) → "Closed". `soon` is true inside the last 24h. */
function tgCountdown(cutoffIso, now = new Date()) {
  let ms;
  try {
    ms = new Date(cutoffIso).getTime() - now.getTime();
  } catch {
    return { text: "", soon: false };
  }
  if (Number.isNaN(ms)) return { text: "", soon: false };
  if (ms <= 0) return { text: "Closed", soon: true };
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return { text: `${mins}m left`, soon: true };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `${hours}h left`, soon: true };
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return { text: remH ? `${days}d ${remH}h left` : `${days}d left`, soon: false };
}

/** Live countdown ticker: updates only the countdown chips every 30s so the
 * radio selection survives. Cleared and replaced on each cart re-render. */
let tgPickupTickerId = null;
function tgStartPickupTicker(group) {
  if (tgPickupTickerId) clearInterval(tgPickupTickerId);
  const tick = () => {
    group.querySelectorAll(".tg-pickup-countdown").forEach((el) => {
      const cd = tgCountdown(el.dataset.cutoff);
      el.textContent = cd.text;
      const card = el.closest(".tg-pickup-option");
      if (card) card.classList.toggle("tg-pickup-option--soon", cd.soon);
    });
  };
  tgPickupTickerId = setInterval(tick, 30000);
}
