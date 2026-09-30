/**
 * DOM test harness for preorder.js.
 *
 * Loads a REAL generated page (site/build.py output) into jsdom and evaluates
 * the REAL preorder.js in the same context, so tests exercise the shipped
 * artifacts rather than a hand-written copy. That is the point: the bug class
 * this exists to catch is a template or script drifting out of step with the
 * other, which a fixture written by hand would reproduce faithfully.
 *
 * Two jsdom details matter here:
 *
 * 1. `runScripts: "outside-only"` gives us `getInternalVMContext()` so we can
 *    eval the source ourselves. V8 keeps a persistent global lexical scope per
 *    context, so declarations from separate runInContext calls are visible to
 *    each other.
 * 2. That same property is how timers are controlled: a shim script declares
 *    top-level `const setTimeout`/`setInterval`, which shadows the window's for
 *    every script that runs afterwards. preorder.js's own `"use strict"` stays
 *    the first statement of its own script, so its semantics are untouched,
 *    while the status-page poller's 5s backoff becomes something a test can
 *    step through instantly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, "..");
const PREORDER_JS = path.join(SITE_ROOT, "preorder.js");

/** Where each surface lives in the built site, and what it needs in the DOM. */
export const PAGES = {
  index: { file: "index.html", url: "https://germanbakingasheville.com/" },
  cart: { file: "cart/index.html", url: "https://germanbakingasheville.com/cart/" },
  status: {
    file: "order-status/index.html",
    url: "https://germanbakingasheville.com/order-status/",
  },
  lookup: { file: "orders/index.html", url: "https://germanbakingasheville.com/orders/" },
};

const TIMER_SHIM = `
const __tgTimers = [];
let __tgNextId = 0;
const setTimeout = (fn, ms, ...args) => {
  const id = ++__tgNextId;
  __tgTimers.push({ id, fn, ms, args, kind: "timeout" });
  return id;
};
const setInterval = (fn, ms, ...args) => {
  const id = ++__tgNextId;
  __tgTimers.push({ id, fn, ms, args, kind: "interval" });
  return id;
};
const clearTimeout = (id) => { __tgTimers.splice(__tgTimers.findIndex((t) => t.id === id), 1); };
const clearInterval = clearTimeout;
`;

/** Inline <script> bodies (no src attribute) from a page. */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

/** True when the page tags preorder.js. */
export function referencesPreorderJs(html) {
  return /<script[^>]*\bsrc=["'][^"']*preorder\.js/.test(html);
}

const REPLY = Symbol("tg-reply");

/**
 * Route a non-200 response. Explicit wrapper rather than sniffing for a
 * `status` key, because the API's own payloads have one (`order.status`).
 */
export function reply(status, body) {
  return { [REPLY]: true, status, body };
}

function isReply(value) {
  return Boolean(value && typeof value === "object" && value[REPLY]);
}

/**
 * Load a built page and run preorder.js against it.
 *
 * @param {object} opts
 * @param {string} opts.page       key from PAGES
 * @param {object} [opts.routes]   "METHOD /path" -> payload | handler | () => Response
 * @param {object} [opts.globals] extra window globals (TAILGATE_MARKETS, gtag, ...)
 * @param {boolean} [opts.cart]    pre-seed localStorage with this cart
 * @param {string} [opts.search]   query string for the page URL
 * @param {boolean} [opts.load]    evaluate preorder.js (default true)
 * @param {boolean} [opts.passthrough] use the real fetch instead of the route
 *   stub — for tests that point the page at a live server
 */
export function mount({
  page,
  routes = {},
  globals = {},
  cart,
  search = "",
  load = true,
  passthrough = false,
}) {
  const spec = PAGES[page];
  if (!spec) throw new Error(`unknown page "${page}" — expected one of ${Object.keys(PAGES)}`);

  const file = path.join(SITE_ROOT, spec.file);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${spec.file} not found.\n` +
        `These tests run against the real build output. Run \`make build\` (or \`uv run python build.py\`) first.`
    );
  }

  const source = fs.readFileSync(file, "utf8");
  if (load && !referencesPreorderJs(source)) {
    throw new Error(`${spec.file} does not load preorder.js — the ordering layer is not wired in`);
  }

  const dom = new JSDOM(source, {
    runScripts: "outside-only",
    url: spec.url + search,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  // `runScripts: "outside-only"` means the page's own inline scripts did not
  // run, so the build-time globals are applied here — read out of the real
  // generated HTML rather than assumed, so a template that stops baking
  // TAILGATE_API_BASE fails here rather than quietly on the live site.
  for (const script of inlineScripts(source)) {
    if (/window\.TAILGATE_/.test(script)) {
      vm.runInContext(script, ctx, { filename: `${spec.file}:inline` });
    }
  }

  // The API base is baked at build time. Read it out of the page rather than
  // hardcoding, so these tests notice if a build bakes the wrong one.
  const apiBase = window.TAILGATE_API_BASE;
  if (!apiBase) {
    throw new Error(
      `${spec.file} does not define window.TAILGATE_API_BASE — the ordering layer is not wired into that page`
    );
  }

  // Seed the baked base, then let `globals` override it. Order matters: a test
  // that points at a local server must not silently keep talking to the
  // production host that the build baked in.
  window.TAILGATE_API_BASE = apiBase;
  for (const [key, value] of Object.entries(globals)) window[key] = value;

  // --- fetch stub ---------------------------------------------------------
  const calls = [];
  if (passthrough) {
    // Real network: the page talks to a live server. Wrap it only to record
    // what was requested.
    const real = globalThis.fetch;
    window.fetch = (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: (init?.method || "GET").toUpperCase(),
        path: url.pathname,
        url: url.href,
        body: init?.body,
        route: `${(init?.method || "GET").toUpperCase()} ${url.pathname}`,
      });
      return real(input, init);
    };
  } else {
    window.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = (init.method || "GET").toUpperCase();
      const route = `${method} ${url.pathname}`;
      calls.push({ method, path: url.pathname, url: url.href, body: init.body, route });

      const handler = routes[route];
      if (handler === undefined) {
        throw new Error(
          `unrouted fetch: ${route}\n` +
            `Known routes: ${Object.keys(routes).join(", ") || "(none)"}`
        );
      }
      const value = typeof handler === "function" ? await handler() : handler;
      if (value instanceof Response) return value;
      if (isReply(value)) {
        const { status, body } = value;
        return Response.json(body, { status });
      }
      return Response.json(value);
    };
  }

  // jsdom has no alert(); the code under test calls it on validation failure.
  const alerts = [];
  window.alert = (message) => alerts.push(message);

  // --- localStorage pre-seed --------------------------------------------
  if (cart) window.localStorage.setItem("tailgate_cart", JSON.stringify(cart));

  // --- evaluate -----------------------------------------------------------
  vm.runInContext(TIMER_SHIM, ctx, { filename: "tg-timer-shim.js" });
  const preorderSource = fs.readFileSync(PREORDER_JS, "utf8");
  // jsdom is still "loading" when we eval, so preorder.js would park boot()
  // behind a DOMContentLoaded that lands on a later tick — every listener
  // attach then races the test. Report "complete" instead so boot runs inline,
  // exactly once, the way it does for a script at the end of <body>.
  Object.defineProperty(window.document, "readyState", {
    configurable: true,
    get: () => "complete",
  });
  const evaluateScript = () =>
    vm.runInContext(preorderSource, ctx, { filename: "preorder.js" });
  if (load) evaluateScript();
  const page_ = {
    window,
    ctx,
    alerts,
    calls,
    apiBase,

    /** First matching element, or null. */
    $(selector) {
      return window.document.querySelector(selector);
    },
    $$(selector) {
      return [...window.document.querySelectorAll(selector)];
    },
    /** Trimmed innerText of the first match, or "" when absent. */
    text(selector) {
      return window.document.querySelector(selector)?.textContent?.trim() ?? "";
    },
    /** All innerTexts matching a selector. */
    texts(selector) {
      return [...window.document.querySelectorAll(selector)].map((el) => el.textContent.trim());
    },
    /** .value of the first match (inputs have no textContent). */
    value(selector) {
      return window.document.querySelector(selector)?.value;
    },
    /** Rendered text of a root element, whitespace collapsed — for asserting
     *  on what a customer actually reads. */
    bodyText(selector) {
      const el = window.document.querySelector(selector);
      return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    },
    has(selector) {
      return Boolean(window.document.querySelector(selector));
    },

    /** Evaluate an expression inside the page context. */
    eval(expression) {
      return vm.runInContext(expression, ctx);
    },

    /**
     * Evaluate preorder.js now. Use with `load: false` when a route depends on
     * something read out of the page itself (e.g. which product slugs the grid
     * offers) — otherwise the boot-time fetch races the route swap and the
     * steppers render twice.
     */
    load() {
      evaluateScript();
      return page_;
    },

    /** Let pending microtasks and already-resolved promises run. */
    async settle(times = 6) {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    },

    /**
     * Wait for a selector to appear, polling with real timers.
     *
     * `settle()` is enough for a stubbed fetch (the response is a resolved
     * promise), but a passthrough fetch does real I/O and will not have landed
     * after any fixed number of microtask turns — use this whenever the page
     * is talking to a live server.
     */
    async waitFor(selector, { timeout = 10000, interval = 25 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const el = window.document.querySelector(selector);
        if (el) return el;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${timeout}ms waiting for ${selector}\n` +
              `Root contains: ${window.document.querySelector("body")?.innerHTML.slice(0, 400)}`
          );
        }
        await new Promise((r) => setTimeout(r, interval));
      }
    },

    /** Number of timers the code under test has scheduled. */
    pendingTimers() {
      return vm.runInContext("__tgTimers.length", ctx);
    },

    /**
     * Run the earliest pending timer callback, then settle. Stops at
     * `limit` iterations so a self-rescheduling poll can't hang the run.
     */
    async runTimer(limit = 1) {
      for (let i = 0; i < limit; i++) {
        const has = vm.runInContext(
          "(() => { if (!__tgTimers.length) return false; __tgTimers.shift().fn(); return true; })()",
          ctx
        );
        await this.settle(2);
        if (!has) return i;
      }
      return limit;
    },

    /** Body of the nth recorded fetch call, parsed. */
    requestBody(index) {
      const call = calls[index];
      return call?.body ? JSON.parse(call.body) : undefined;
    },

    /** Swap a route after mount, then optionally re-run the ordering layer. */
    setRoute(route, value, { rerun = true } = {}) {
      routes[route] = value;
      if (rerun) vm.runInContext("initAddToCartButtons()", ctx);
      return page_;
    },

    /**
     * Flush anything still in flight, then tear the window down. Closing
     * mid-fetch leaves preorder.js resuming against a dead document, which
     * node reports as async activity after the test ended.
     */
    async close() {
      await this.settle(3);
      window.close();
    },
  };

  return page_;
}

/** Product slugs the built homepage actually offers, in DOM order. */
export function cardSlugs(page) {
  return page.$$("[data-tg-add-group]").map((el) => el.dataset.slug);
}

/**
 * Build an availability payload in the exact shape the API emits.
 *
 * Deliberately built here rather than imported from tailgate: the site is a
 * standalone public submodule and must not depend on the private service repo.
 * tailgate/tests/integration pins the server side of this same contract.
 */
export function availability({
  dropId = "2026-09-29",
  taxPercent = null,
  newsletterEnabled = false,
  items = defaultItems(),
  pickupPoints = defaultPickupPoints(),
  cutoff = "2026-09-27T13:48:00+00:00",
  pickupAt = "2026-09-29T15:30:00+00:00",
  status = "open",
} = {}) {
  return {
    generated_at: "2026-09-25T10:00:00+00:00",
    tax_percent: taxPercent,
    newsletter_enabled: newsletterEnabled,
    drops: [
      {
        drop_id: dropId,
        items: items.map((item) => ({
          slug: item.slug,
          name: item.name,
          capacity: item.capacity ?? null,
          remaining: item.remaining ?? null,
          sold_out: item.sold_out ?? false,
          units: item.units.map((unit) => ({
            name: unit.name,
            price_cents: unit.price_cents,
            price: (unit.price_cents / 100).toFixed(2),
            fulfillment_types: unit.fulfillment_types ?? ["pickup"],
          })),
        })),
        fulfillment_options: [
          {
            type: "pickup",
            cutoff,
            pickup_at: pickupAt,
            status,
            next_open_drop_id: null,
            pickup_points: pickupPoints,
            delivery: null,
          },
        ],
      },
    ],
  };
}

export function defaultItems() {
  return [
    {
      slug: "german-cheesecake",
      name: "German Cheesecake",
      capacity: 20,
      remaining: 6,
      units: [
        { name: "slice", price_cents: 600 },
        { name: "whole", price_cents: 4500 },
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
}

export function defaultPickupPoints() {
  return [
    {
      slug: "west-asheville",
      label: "West Asheville Tailgate Market",
      window_start: "15:30",
      window_end: "18:30",
    },
  ];
}

/** An order-status response in the shape the API emits. */
export function orderStatus({
  orderRef = "a1b2c3d4e5f6",
  status = "paid",
  totalCents = 6000,
  taxPercent = null,
  lines = [
    {
      item_slug: "german-cheesecake",
      item_name: "German Cheesecake",
      unit_name: "slice",
      quantity: 2,
      unit_price_cents: 600,
    },
  ],
  pickupPoint = "west-asheville",
  pickupLabel = "West Asheville Tailgate Market",
  pickupAt = "2026-09-29T15:30:00+00:00",
  cancellable = true,
  cancellationDeadline = "2026-09-27T13:48:00+00:00",
  dropId = "2026-09-29",
} = {}) {
  return {
    order_ref: orderRef,
    status,
    lines,
    total_cents: totalCents,
    drop_id: dropId,
    pickup_point: pickupPoint,
    pickup_label: pickupLabel,
    pickup_at: pickupAt,
    cancellable,
    cancellation_deadline: cancellationDeadline,
    tax_percent: taxPercent,
  };
}

/** Markets map as build.py bakes it from content/locations/*.yml. */
export function marketsMap() {
  return {
    "West Asheville Tailgate Market": {
      address: "1 Market St, Asheville, NC 28801",
      url: "https://www.westashevillefarmersmarket.com",
      schedule_display: "Tuesdays 3:30–6:30 PM",
    },
  };
}
