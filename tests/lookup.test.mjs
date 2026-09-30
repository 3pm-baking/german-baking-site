/**
 * /orders/ — "find my order", the device-independent recovery path.
 *
 * This page is the only way back to an order from a different browser, so its
 * copy is security-relevant as well as convenient: the response must not
 * reveal whether an address has an order, or a stranger could enumerate
 * customers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount, reply } from "./harness.mjs";

function lookup({ lookupReply } = {}) {
  const page = mount({
    page: "lookup",
    routes: {
      "POST /api/v1/orders/lookup":
        lookupReply ??
        reply(200, {
          sent: true,
          message: "If an order exists for that email, we've sent the link(s).",
          orders: [],
        }),
    },
  });
  page.eval(`document.getElementById("tg-lookup-email").value = "jane@example.com";`);
  return page;
}

const submit = async (page) => {
  page.$("#tg-lookup-form").dispatchEvent(
    new page.window.Event("submit", { bubbles: true, cancelable: true })
  );
  await page.settle();
};

test("posts the entered contact to the lookup endpoint", async () => {
  const page = lookup();
  await submit(page);

  const call = page.calls.find((c) => c.path === "/api/v1/orders/lookup");
  assert.ok(call, "must call the lookup endpoint");
  assert.equal(call.method, "POST");
  assert.equal(page.requestBody(page.calls.indexOf(call)).contact, "jane@example.com");
  await page.close();
});

test("sends an empty honeypot so a real customer is never swallowed", async () => {
  const page = lookup();
  await submit(page);

  const call = page.calls.find((c) => c.path === "/api/v1/orders/lookup");
  assert.equal(page.requestBody(page.calls.indexOf(call)).tg_verify, "");
  await page.close();
});

test("does nothing when no email was entered", async () => {
  const page = mount({
    page: "lookup",
    routes: { "POST /api/v1/orders/lookup": reply(200, { sent: true, orders: [] }) },
  });
  await submit(page);

  assert.equal(page.calls.length, 0, "an empty form must not call the API");
  await page.close();
});

test("shows the same confirmation whether or not an order matched", async () => {
  // Enumeration safety: the wording must be identical for a known and an
  // unknown address, or the endpoint leaks who has pre-orders.
  const withOrder = reply(200, {
    sent: true,
    message: "If an order exists for that email, we've sent the link(s).",
    orders: [
      {
        status: "paid",
        total_cents: 6000,
        contact_masked: "j***@example.com",
        items: ["German Cheesecake (slice) × 2"],
      },
    ],
  });
  const withoutOrder = reply(200, {
    sent: true,
    message: "If an order exists for that email, we've sent the link(s).",
    orders: [],
  });

  const a = lookup({ lookupReply: withOrder });
  await submit(a);
  const b = lookup({ lookupReply: withoutOrder });
  await submit(b);

  assert.equal(
    a.text("#tg-lookup-result").includes("we've sent the link"),
    b.text("#tg-lookup-result").includes("we've sent the link")
  );
  assert.match(b.text("#tg-lookup-result"), /we've sent the link/);
  await page_close_all(a, b);
});

/** Summaries may only show the masked contact, never the raw address. */
test("shows the masked contact, never the raw one", async () => {
  const page = lookup({
    lookupReply: reply(200, {
      sent: true,
      message: "sent",
      orders: [
        { status: "paid", total_cents: 6000, contact_masked: "j***@example.com", items: [] },
      ],
    }),
  });
  await submit(page);

  const text = page.text("#tg-lookup-result");
  assert.match(text, /j\*\*\*@example\.com/);
  assert.doesNotMatch(text, /jane@example\.com/);
  await page.close();
});

test("summarises each order with a status and amount", async () => {
  const page = lookup({
    lookupReply: reply(200, {
      sent: true,
      message: "sent",
      orders: [
        {
          status: "paid",
          total_cents: 6000,
          contact_masked: "j***@example.com",
          items: ["German Cheesecake (slice) × 2"],
        },
      ],
    }),
  });
  await submit(page);

  assert.match(page.bodyText("#tg-lookup-result"), /Paid/);
  assert.match(page.bodyText("#tg-lookup-result"), /\$60\.00/);
  assert.match(page.bodyText("#tg-lookup-result"), /German Cheesecake/);
  await page.close();
});

test("an awaited payment reads as pending, not paid", async () => {
  const page = lookup({
    lookupReply: reply(200, {
      sent: true,
      message: "sent",
      orders: [
        { status: "pending", total_cents: 6000, contact_masked: "j***@e.com", items: [] },
      ],
    }),
  });
  await submit(page);

  assert.match(page.bodyText("#tg-lookup-result"), /Awaiting payment/);
  await page.close();
});

test("re-enables the button after a rate-limited rejection", async () => {
  const page = lookup({ lookupReply: reply(429, { detail: "Too many requests" }) });
  await submit(page);

  assert.equal(page.$("#tg-lookup-btn").disabled, false, "the customer must be able to retry");
  assert.equal(page.text("#tg-lookup-btn"), "Email me my links");
  assert.match(page.text("#tg-lookup-result"), /too many requests/i);
  await page.close();
});

test("survives a network failure and offers a retry", async () => {
  const page = lookup({
    lookupReply: () => {
      throw new Error("connection reset");
    },
  });
  await submit(page);

  assert.match(page.text("#tg-lookup-result"), /network error/i);
  assert.equal(page.$("#tg-lookup-btn").disabled, false);
  await page.close();
});

test("shows the result even when the response is not JSON", async () => {
  const page = lookup({ lookupReply: new Response("<html>502</html>", { status: 200 }) });
  await submit(page);

  assert.equal(page.$("#tg-lookup-result").hidden, false);
  assert.equal(page.$("#tg-lookup-btn").disabled, false);
  await page.close();
});


async function page_close_all(...pages) {
  for (const page of pages) await page.close();
}
