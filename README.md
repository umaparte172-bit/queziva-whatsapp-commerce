# Queziva – WhatsApp Native Commerce

Native WhatsApp ordering → admin review → customer approval → address → Shiprocket shipping →
native WhatsApp Pay (Razorpay) → Shiprocket shipment → tracking → delivery follow-ups.

## Documentation

| Document | For |
|---|---|
| [docs/admin-guide.md](docs/admin-guide.md) | The Queziva team: using the order dashboard day to day |
| [docs/go-live-checklist.md](docs/go-live-checklist.md) | Switching to live WhatsApp, Razorpay and Shiprocket, including the ₹1 acceptance test |
| [docs/whatsapp-templates.md](docs/whatsapp-templates.md) | The 11 message templates to submit to Meta |
| [docs/deployment.md](docs/deployment.md) | Server, PostgreSQL, systemd, nginx, webhooks, updates, backups |
| [docs/setup.md](docs/setup.md) | Local development and the full `.env` reference |
| [docs/api.md](docs/api.md) | Webhook endpoints and the admin API |
| [docs/database.md](docs/database.md) | Data model and order statuses |

The sections below explain how each part of the workflow behaves.

## Quick start

```bash
npm install
cp .env.example .env
npx prisma db push
npm run db:seed
npm run dev
```

Check `http://localhost:3000/health`.

Run the tests with `npm test`.

## Admin dashboard

```bash
npm run admin:build
npm run dev
```

Open `http://localhost:3000/admin` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
The seed script creates this first login.

To add or reset a login:

```bash
npm run admin:create -- someone@queziva.com "a-strong-password" "Their Name"
```

When working on the dashboard UI, run `npm run admin:dev` alongside `npm run dev`. It serves the UI on
`http://localhost:5173/admin/` with live reload and forwards API calls to the server.

What the dashboard supports:
- **Orders** can be filtered by status (with counts), by stock issues, or found by ID, phone or name.
  The list refreshes every 30 seconds.
- **Order page:**
  - Items show requested vs approved quantity, with live stock.
  - Quantities can be changed; products can be added, replaced or removed.
  - Discounts and internal notes can be added.
  - The order can be approved or cancelled (a reason is required).
  - The full history is shown.
- **Approving:**
  - An unchanged order goes straight to address collection.
  - A changed order goes to the customer for approval first.
  - Approval is blocked while any item is short on stock.
- **Products & stock:** add and edit products, set stock inline, and turn products on or off.

Sessions use a signed, HttpOnly, SameSite=Strict cookie. Passwords are hashed with scrypt, and
failed sign-ins are rate-limited.

## Mock vs live

Each integration can be switched on its own in `.env`:

```
WHATSAPP_MODE=mock    # or live
RAZORPAY_MODE=mock
SHIPROCKET_MODE=mock
```

In `mock` mode, nothing leaves the server, so the whole flow can be built and demoed without
credentials. When an integration is switched to `live`, the server refuses to start until
that integration's credentials are set in `.env`.

## Demo: customer simulator

While WhatsApp runs in mock mode, the dashboard has a **Customer simulator** page. It's a
WhatsApp-like phone where you play the customer:

- **Customer actions:** send a cart from the catalogue, tap reply buttons (including template
  quick replies), fill in the native address form, pay (or fail to pay) on the order card, and
  type messages.
- **Courier updates:** send the updates Shiprocket would send (picked up, in transit, out for
  delivery, delivered, delivery failed, return to origin).
- **Skip ahead** 13, 49 or 73 hours to trigger reminders, timeouts and the feedback follow-up.

Every action goes through the same webhook processing as real traffic. Keep the order open in a
second tab to watch the admin side update.

**To demo the client's scenario:** order 2 × Pearl Drop Earrings (only 1 in stock) and 1 necklace.
Then in the dashboard, reduce the earrings to 1 and send the revised order. After that, the
customer accepts, shares their address and pays; the admin sends the payment request between
those last two steps.

`tests/scenario.test.ts` runs the same story automatically through the real HTTP interfaces.

With `WHATSAPP_MODE=live` the simulator routes are not mounted at all.

## WhatsApp webhook (go-live)

1. In `.env`, set `WHATSAPP_MODE=live` and fill in the `WHATSAPP_*` values.
2. In Meta App → WhatsApp → Configuration → Webhook:
   - **Callback URL:** `https://<APP_BASE_URL>/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
3. Subscribe to the **messages** field.

Every POST is checked against `X-Hub-Signature-256`, using the App Secret. Each event is
stored once in `WebhookEvent`, so Meta's duplicate deliveries are ignored.

**24-hour rule:** free-form messages (text, buttons, `order_details`) can only be sent within
24 hours of the customer's last message. After that, the app must use an approved template.
`sendToCustomer` enforces this rule. `sendWithFallback` switches to the template automatically.
Submit the templates listed in [docs/whatsapp-templates.md](docs/whatsapp-templates.md)
before going live.

## Customer approval and address flow

1. **Admin approves.**
   - If the order is unchanged, the customer is asked for their delivery address using WhatsApp's
     native address form. It's prefilled with their name and number, or with the address from
     their last order.
   - If the order was changed, the customer receives the revised order with
     **[Accept Updated Order] [Cancel Order]** buttons. Each button carries the order ID and an
     approval round, so a tap on an outdated version is rejected and the latest one is sent again.
2. **Customer accepts** and is asked for the address. **Customer cancels** and the order is
   cancelled with a confirmation message.
3. **Address submitted.** It's validated (10-digit mobile, 6-digit pincode, required fields) and
   saved on the order and the customer. If anything is invalid, the form is sent again with the
   problem fields highlighted. Customers who type their address are pointed to the form, and an
   admin can also enter the address by hand on the order page.
4. **Reminders and auto-cancel** run from the `ScheduledJob` table:
   - Approval: reminder after 12 h, cancel after 48 h.
   - Address: reminder after 12 h, cancel after 72 h.

   These times are set in `.env`; 0 turns a reminder or cancel off.

Free-text messages from a customer with an open order are shown in that order's history.

## Shipping (Shiprocket)

When the address is saved, shipping is calculated automatically:

1. **Parcel.** The size comes from each product's packed weight and box size, plus
   `PACKAGING_WEIGHT_GRAMS`: the largest item's footprint, with every item's height stacked.
2. **Courier.** Shiprocket's serviceability API returns live options from `SHIPROCKET_PICKUP_PINCODE`
   to the customer's pincode. One is picked by `SHIPPING_COURIER_STRATEGY`
   (`cheapest` / `fastest` / `recommended`).
3. **Customer charge:**
   - Normally the courier rate, rounded up to whole rupees.
   - Free when the product total reaches `FREE_SHIPPING_ABOVE_RUPEES`.
   - A fixed amount if `SHIPPING_FLAT_RATE_RUPEES` is set.
   - What the courier actually costs the store is kept separately, as `shippingCostPaise`.
4. **Status.** The order moves to **Ready for payment** so an admin can check the final amount.

During the final review, an admin can:
- Pick another courier from the live options.
- Set the shipping charge by hand, with a reason. A manual charge is never recalculated
  automatically.
- Change the discount. Free shipping is re-checked afterwards.
- Change the address, which is quoted again. Customers can also send a new address form at this
  stage.

If no courier delivers to the pincode, the customer is asked for another address, with the
pincode field flagged. If Shiprocket is unreachable, the address is kept and a **Calculate
shipping** button appears.

The live client caches the login token (Shiprocket tokens last 10 days; it refreshes after 9, or
on a 401). It retries outages, and it already covers the calls used after payment: create order,
assign AWB, request pickup and tracking.

In mock mode, pincode `744101` is not serviceable and `999999` simulates Shiprocket being down.

## Payments (native WhatsApp Pay via Razorpay)

1. **Admin sends the payment request.** The admin clicks **Send payment request** on an order that
   is Ready for payment. This creates a `Payment` row with a unique `reference_id`
   (`QZP-RQ260928001-1`) and sends a native `order_details` message with Pay Now, using the
   Razorpay payment configuration.
   - The amounts reconcile exactly: items = subtotal, and subtotal − discount + shipping + tax =
     total.
   - With GST-inclusive prices, tax is sent as 0 and described as "Inclusive of GST (₹…)".
   - Outside the 24-hour window, the `qz_payment_request` template goes out instead. Its
     **Review & Pay** button brings up the Pay Now message.
2. **Customer pays inside WhatsApp.** Two independent signals may arrive: WhatsApp's payment
   status webhook and Razorpay's `payment.captured` webhook. Both go to `confirmPayment`, which:
   - Re-fetches the payment from the Razorpay API. **Nothing is ever marked paid from webhook
     content alone.**
   - Requires `captured`, INR, the exact requested amount, an open request, and an order that is
     still waiting for payment.
   - Applies each payment once, however many webhooks arrive.
3. **Once the payment is verified:**
   - The order becomes **PAID** and gets its `QZ…` order ID.
   - Stock goes down (if another sale already took it, an alert is added).
   - The customer gets the confirmation as an `order_status` update. Outside the window it goes as
     the `qz_order_confirmed` template instead.
   - The shipment job is queued.
4. **Shipment** (`shipment.create` job, retried up to 3 times):
   - It creates the Shiprocket order, assigns the AWB with the courier chosen at quote time
     (falling back to Shiprocket's pick if that courier won't take it), and requests pickup.
   - Each step is saved, so a retry never creates a second Shiprocket order.
   - The order moves to **Processing**. If every attempt fails, the admin gets **Retry shipment**.

**Payment problems:**

| Situation | What happens |
|---|---|
| Payment attempt failed | Recorded; the customer is told they can try again |
| Wrong amount, withdrawn or expired request, cancelled or already-paid order | Refunded automatically, with an alert on the order |
| Unknown or forged payment ID | Rejected, because the Razorpay lookup fails |

**Other admin actions:**
- **Withdraw payment request** marks the request cancelled and sends `order_status: canceled`,
  which disables the old Pay button.
- **Cancel & refund**, available until pickup, cancels the Shiprocket order, refunds in full,
  returns the stock and tells the customer.
- **Retry refund** appears when a refund failed (or is still pending). It checks Razorpay first and
  only refunds what hasn't been refunded yet, so it can't refund twice.
- **Close – not delivered**, for shipped orders that will never arrive (lost, RTO), cancels the
  order with a reason. The admin chooses whether to restock and whether to refund.

**Reminders and expiry:** a reminder goes out after `PAYMENT_REMINDER_HOURS`, and the order is
cancelled after `PAYMENT_EXPIRY_HOURS`. The same expiry is set on the order card itself.

**Razorpay webhook:** set it up at `https://<APP_BASE_URL>/webhooks/razorpay` with
`RAZORPAY_WEBHOOK_SECRET`, for the events `payment.captured`, `payment.failed`, `order.paid`,
`refund.processed` and `refund.failed`.

## Tracking, delivery and follow-up

**Shiprocket webhook:** in Shiprocket → Settings → API → Webhooks, set the URL to
`https://<APP_BASE_URL>/webhooks/tracking` and the token to `SHIPROCKET_WEBHOOK_TOKEN`, which
Shiprocket sends as `x-api-key`. Shiprocket rejects URLs containing "shiprocket", "kartrocket",
"sr" or "kr", which is why the path is `/tracking`.

**How updates move the order:**
- Courier statuses are grouped into steps:

  | Courier status | Order step |
  |---|---|
  | Picked up / shipped | **Shipped** |
  | In transit / at a hub | **In transit** |
  | Out for delivery | **Out for delivery** |
  | Delivered | **Delivered** |

- Skipped steps are filled in; for example, a missed "picked up" still records **Shipped**.
- Duplicate updates are ignored. Updates older than the latest courier scan are recorded in the
  history but don't change the status.
- Returns (RTO), lost, damaged, courier cancellations and pickup problems create an alert on the
  order and don't message the customer.

**Customer notifications:**
- Choose which ones go out in **Settings**: dispatched, in transit (off by default), out for
  delivery, failed delivery attempt, delivered.
- Each goes out at most once. Within the 24-hour window it's an interactive message with a
  **Track Shipment** button; otherwise it's the approved template, with the AWB in the tracking
  link.
- The delivered message includes the unboxing-video request.

**Follow-up:** after the configured delay (48 hours by default), the feedback message goes out:
review link, Instagram handle and a **Follow on Instagram** button. The order then becomes
**Completed**. Replies from the customer land in that order's history.

**Safety net:** every 4 hours, shipments that haven't had a courier update in 3 hours are checked
with Shiprocket's tracking API. Admins can also use **Refresh tracking** or **Mark as delivered**
on an order.

**Test mode:** when WhatsApp and Razorpay are both mocked, orders waiting for payment show
**Simulate successful / failed payment**. These buttons go through the same verification path as a
real payment.

## Project layout

| Path | Purpose |
|---|---|
| `prisma/schema.prisma` | Database schema. Money is integer paise; GST rates are basis points (300 = 3%). |
| `src/domain/orderStatus.ts` | Order state machine: who may move an order between which statuses |
| `src/domain/pricing.ts` | Subtotal / discount / GST / shipping / total |
| `src/services/orders.ts` | Creating order requests, recalculating totals, status transitions (with preconditions + audit) |
| `src/services/audit.ts` | Append-only order history |
| `src/integrations/` | WhatsApp, Razorpay and Shiprocket clients (`mock.ts` / `live.ts` behind one interface) |
| `src/integrations/whatsapp/payloads.ts` | Exact Cloud API JSON for text, buttons, templates, address form, `order_details`, `order_status` |
| `src/services/whatsappInbound.ts` | Webhook processing: cart → order, delivery statuses, payment statuses |
| `src/services/messaging.ts` | Outbound messages: logging and the 24-hour window check |
| `src/messages/copy.ts` | Customer-facing message wording |

## Business rules enforced in code

- Payment can only be requested from `READY_FOR_PAYMENT`. That status requires items, a
  complete address, a shipping quote and an up-to-date total.
- A modified order cannot be approved by admin directly. The customer must accept it.
- Only the system can mark an order `PAID`, and only when a captured, verified payment for the
  full amount exists.
- The customer's original quantities (`requestedQuantity`) are never overwritten.
- Every status change is written to `OrderEvent` in the same transaction, with optimistic locking.

## Production database

Local development uses SQLite. Production uses the generated PostgreSQL schema and committed
migrations under `prisma/postgres`; do not change the provider in the development schema by hand.
Use `npm run build:prod` to generate the PostgreSQL client and `npm run db:deploy` to apply
migrations. See [docs/deployment.md](docs/deployment.md) for the complete procedure.
