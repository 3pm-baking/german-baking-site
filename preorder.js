/**
 * tailgate front-end — the ordering layer for germanbakingasheville.com.
 *
 * All state is client-side (localStorage); the order. API is the only bridge
 * to the service, and only at two moments: reading availability, and the
 * checkout POST. Prices shown here are display-only — the server recomputes
 * everything authoritatively at order creation.
 *
 * Surfaces:
 *   - availability widget on the homepage (initPreorderWidget)
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

// ---------------------------------------------------------------------------
// homepage widget: availability strip + add-to-cart on the Available Now grid
// ---------------------------------------------------------------------------

async function initPreorderWidget() {
  const container = document.getElementById("tailgate-widget");
  if (!container || !window.TAILGATE_API_BASE) return;
  try {
    const data = await tgFetchAvailability();
    container.innerHTML = "";
    renderOrderChip(container);
    renderDropStrip(container, data);
  } catch (err) {
    container.innerHTML =
      '<p class="tg-unavailable">Pre-orders are unavailable right now.</p>';
  }
}

/** Nav chip: "your order for pickup — view" (from the last checkout).
 * Without a saved order, falls back to a "Find my order" chip so the
 * recovery flow is discoverable from every page. */
function renderOrderChip(container) {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(TG_ORDER_KEY) || "null");
  } catch {
    saved = null;
  }
  const chip = document.createElement("a");
  chip.className = "tg-chip";
  if (saved && saved.ref) {
    chip.href = `/order-status/?ref=${encodeURIComponent(saved.ref)}&token=${encodeURIComponent(saved.token)}`;
    chip.textContent = `Your order for ${saved.pickup || "pickup"} · view status`;
  } else {
    chip.href = "/orders/";
    chip.textContent = "Find my order";
  }
  container.prepend(chip);
}

function renderDropStrip(container, data) {
  for (const drop of data.drops) {
    const open = drop.fulfillment_options.some((o) => o.status === "open");
    const section = document.createElement("div");
    section.className = "tg-strip" + (open ? "" : " tg-strip--closed");
    section.id = `tg-drop-${drop.drop_id}`;

    const label = document.createElement("p");
    label.className = "tg-strip__label";
    const badge = document.createElement("span");
    badge.className = "tg-badge" + (open ? "" : " tg-badge--closed");
    badge.textContent = open ? "Pre-order open" : "Orders closed";
    label.appendChild(badge);
    section.appendChild(label);
    container.appendChild(section);
  }
}

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

  const cart = reconcileCart(tgCartLoad(), availability);
  renderCart(root, cart, availability);
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
    root.innerHTML =
      '<p class="tg-cart-empty">Your cart is empty. <a href="/#products">Browse what\'s baking →</a></p>';
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
    row.innerHTML = `
      <td class="tg-cart-item">${item.name} <span class="tg-cart-unit">(${unit.name})</span></td>
      <td class="tg-cart-price">${tgPrice(unit.price_cents)}</td>
      <td class="tg-cart-qty"><input type="number" min="0" value="${line.qty}"
            data-slug="${line.slug}" data-unit="${line.unit}" aria-label="Quantity"></td>
      <td class="tg-cart-line-total" data-line-total>${tgPrice(lineTotal)}</td>
      <td><button type="button" class="tg-cart-remove" data-slug="${line.slug}" data-unit="${line.unit}">×</button></td>
    `;
    table.appendChild(row);
  }
  const totalRow = document.createElement("tfoot");
  totalRow.innerHTML = `<tr><th>Total</th><th></th><th></th><th class="tg-cart-total">${tgPrice(totalCents)}</th><th></th></tr>`;
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
    pickupOptions.forEach((o, i) => {
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
      group.appendChild(label);
    });
    root.appendChild(group);
    tgStartPickupTicker(group);
  }

  // contact + newsletter + checkout
  const form = document.createElement("div");
  form.className = "tg-cart-checkout";
  form.innerHTML = `
    <label class="tg-cart-field"><span>Name</span> <input type="text" id="tg-cart-name" maxlength="200" required></label>
    <label class="tg-cart-field"><span>Email or phone</span> <input type="text" id="tg-cart-contact" maxlength="200" required></label>
    ${window.TAILGATE_NEWSLETTER ? `
    <label class="tg-cart-field tg-cart-newsletter">
      <input type="checkbox" id="tg-cart-newsletter">
      Also send me the monthly newsletter
    </label>` : ""}
    <button type="button" id="tg-cart-checkout" class="tg-cart-checkout-btn">Checkout</button>
    <p class="tg-cart-fineprint">Payment via Square: cards, Apple Pay, Google Pay, Cash App.</p>
  `;
  root.appendChild(form);

  // wire quantity changes + remove buttons
  root.querySelectorAll(".tg-cart-qty input").forEach((input) => {
    input.addEventListener("change", () => {
      tgCartSetQuantity(input.dataset.slug, input.dataset.unit, parseInt(input.value, 10) || 0);
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

async function checkout(root, availability) {
  const cart = tgCartLoad();
  if (cart.items.length === 0) return;
  const name = root.querySelector("#tg-cart-name").value.trim();
  const contact = root.querySelector("#tg-cart-contact").value.trim();
  const pickupInput = root.querySelector("input[name='tg-pickup']:checked");
  const pickupValue = pickupInput ? pickupInput.value : "";
  if (!pickupValue) return;
  const [dropId, pickupSlug] = pickupValue.split("|");
  const newsletterInput = root.querySelector("#tg-cart-newsletter");
  if (!name || !contact) {
    alert("Please fill in your name and contact.");
    return;
  }
  const button = root.querySelector("#tg-cart-checkout");
  button.disabled = true;
  button.textContent = "Starting checkout…";
  if (window.gtag) {
    window.gtag("event", "checkout_click", { items: cart.items.length });
  }
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
  try {
    const res = await fetch(
      `${TG_API_BASE}/api/v1/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`
    );
    if (res.status === 403 || res.status === 404) {
      root.innerHTML = "<p>This order link is not valid.</p>";
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const order = await res.json();
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
    renderOrderStatus(root, order, ref, token, nameMap, pointMap);
  } catch (err) {
    root.innerHTML = '<p class="tg-unavailable">Could not load your order right now.</p>';
  }
}

/** "See you at the market" card: market name, date/time, Maps link, hours.
 * Falls back to the plain pickup line when data is missing (fail-soft). */
function tgPickupCard(order, points = {}) {
  const point = points[order.pickup_point];
  const market = point && window.TAILGATE_MARKETS && window.TAILGATE_MARKETS[point.label];
  if (!point || !market) {
    return order.pickup_point ? `<p class="tg-muted">Pickup: ${order.pickup_point}</p>` : "";
  }
  let when = "";
  if (order.pickup_at) {
    try {
      const date = new Date(order.pickup_at).toLocaleDateString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      const win = tgPickupWindow(point, order.pickup_at);
      when = `<p class="tg-market-card__when">${[date, win].filter(Boolean).join(" · ")}</p>`;
    } catch {
      when = "";
    }
  }
  const mapsLink = market.address
    ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(market.address)}"
          target="_blank" rel="noopener noreferrer" class="tg-market-card-map"
          onclick="gtag('event', 'maps_click', {market: '${point.label.replace(/'/g, "\\'")}'});">${market.address}</a>`
    : "";
  const siteLink = market.url
    ? `<a href="${market.url}" target="_blank" rel="noopener noreferrer">Market website →</a>`
    : "";
  const schedule = market.schedule_display
    ? `<p class="tg-market-card-schedule">${market.schedule_display}</p>`
    : "";
  const heading =
    order.status === "paid" || order.status === "fulfilled"
      ? `See you at ${point.label}`
      : `Pickup at ${point.label}`;
  return `
    <div class="tg-market-card">
      <p class="tg-market-card-heading">${heading}</p>
      ${when}
      ${mapsLink ? `<p class="tg-market-card-address">${mapsLink}</p>` : ""}
      ${schedule}
      ${siteLink ? `<p class="tg-market-card-link">${siteLink}</p>` : ""}
    </div>
  `;
}

function renderOrderStatus(root, order, ref, token, nameMap = {}, points = {}) {
  const statusLabels = {
    pending: "Awaiting payment",
    paid: "Paid! See you at pickup.",
    fulfilled: "Picked up ✓",
    no_show: "Missed pickup",
    canceled: "Canceled",
    expired: "Expired",
  };
  const displayName = (slug) => nameMap[slug] || slug;
  const rows = order.lines
    .map(
      (line) =>
        `<tr><td>${displayName(line.item_slug)} (${line.unit_name})</td><td>×${line.quantity}</td></tr>`
    )
    .join("");
  const cancellable = order.cancellable && window.TAILGATE_API_BASE;
  const cancelDeadline = order.cancellation_deadline
    ? `<p class="tg-muted">Cancellations close <strong>${formatCutoff(order.cancellation_deadline)}</strong>.</p>`
    : `<p class="tg-muted">Cancellations close at the order deadline.</p>`;
  root.innerHTML = `
    <p><span class="tg-badge${order.status === "paid" ? " tg-badge--paid" : ""}">${statusLabels[order.status] || order.status}</span></p>
    <table class="tg-cart-table">
      ${rows}
      <tfoot><tr><th>Total</th><th>$${(order.total_cents / 100).toFixed(2)}</th></tr></tfoot>
    </table>
    ${tgPickupCard(order, points)}
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
    if (document.getElementById("tailgate-widget")) initPreorderWidget();
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
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const res = await fetch(`${TG_API_BASE}/api/v1/orders/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: email }),
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
