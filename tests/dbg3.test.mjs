import test from "node:test";
import assert from "node:assert/strict";
import { availability, deliveryOptionFixture, marketsMap, mount, reply } from "./harness.mjs";

test("dbg3 in checkout file", async () => {
  const page = mount({
    page: "cart",
    routes: {
      "GET /api/v1/availability": availability({ deliveryOption: deliveryOptionFixture() }),
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
        status_url: "https://order.example.com/order/deliver01?token=tok2",
        redirect_url: "https://square.link/u/TESTCHECKOUT",
        total_cents: 5500,
      }),
    },
    globals: { TAILGATE_MARKETS: marketsMap() },
    cart: { items: [{ slug: "german-cheesecake", unit: "whole", qty: 1 }] },
  });
  await page.settle();
  console.log("DD-N:", !!page.$("#tg-cart-name"), ":ERR:", page.eval("window.TG_INIT_ERR") || "none");
  await page.close();
});
