# Go-live checklist

Go live **one integration at a time**. Each one has its own `*_MODE` switch, and switching it back
to `mock` is the rollback.

## A. Access and accounts (from Queziva)

- [ ] **Meta Business Manager:** developer added as partner or admin, with access to the WABA,
      catalogue and Meta App
- [ ] **Business verification** is complete, and the display name is approved
- [ ] **Phone number** is registered on the Cloud API (not only the WhatsApp Business app)
- [ ] **Catalogue** is connected to that number, with cart enabled
- [ ] **Payment configuration:** the Razorpay one is **Active** in WhatsApp Manager. Note its
      **exact name**.
- [ ] **Razorpay:** live API keys, and **auto-capture turned on** (Settings → Payment capture).
      Without it, payments stay "authorized" and orders never become paid.
- [ ] **Shiprocket:** an API user is created, the pickup address is set up, and the **wallet is
      recharged**
- [ ] A billing email for Shiprocket orders (`SHIPROCKET_FALLBACK_EMAIL`)
- [ ] **Business decisions:**
  - [ ] Are prices GST-inclusive? (`PRICES_INCLUDE_GST`)
  - [ ] Free-shipping threshold or flat rate?
  - [ ] Courier choice: cheapest, fastest or recommended?
  - [ ] Instagram handle and review link

## B. Message templates

- [ ] All 11 templates in [whatsapp-templates.md](whatsapp-templates.md) submitted in WhatsApp
      Manager (category Utility, language English)
- [ ] All 11 **approved**. If any names differ from the document, they're set in `.env`
      (`TEMPLATE_*`).

## C. Server

- [ ] Deployed as described in [deployment.md](deployment.md): PostgreSQL, `npm run build:prod`,
      `npm run db:deploy`, systemd, nginx and HTTPS
- [ ] `https://<domain>/health` shows `"database":"ok"`
- [ ] First admin login created. Extra logins added with
      `npm run admin:create -- <email> <password> <name>`.
- [ ] `ADMIN_SESSION_SECRET` is 32+ random characters, and `APP_BASE_URL` starts with `https://`
- [ ] Daily database backups are turned on

## D. Products

- [ ] Every product sold on WhatsApp exists under **Products & stock**, with its **catalogue ID
      equal to the item's Content ID** in the Meta catalogue. Carts with unknown IDs are flagged on
      the order.
- [ ] Current stock is entered
- [ ] Packed weight and box size are set, since they drive the Shiprocket rates
- [ ] Prices match the catalogue. A mismatch is flagged on the order, and the customer is charged
      the catalogue price they saw.

## E. Switch on, one integration at a time

### 1. Shiprocket (`SHIPROCKET_MODE=live`)

- [ ] Fill in the `SHIPROCKET_*` settings and restart
- [ ] Register the tracking webhook: `https://<domain>/webhooks/tracking`, token =
      `SHIPROCKET_WEBHOOK_TOKEN`
- [ ] **Check:** WhatsApp is still in mock mode, so the Customer simulator still works. Send a cart
      to a real pincode, approve it, and share an address. The quote on the order should show real
      Shiprocket couriers and rates. If needed, compare with Shiprocket's rate calculator.

### 2. Razorpay (`RAZORPAY_MODE=live`)

- [ ] Fill in the `RAZORPAY_*` settings and restart
- [ ] Create the webhook: `https://<domain>/webhooks/razorpay` with the secret, and the events
      `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`

### 3. WhatsApp (`WHATSAPP_MODE=live`)

- [ ] Fill in the `WHATSAPP_*` settings and restart. The server refuses to start with WhatsApp live
      unless Razorpay and Shiprocket are already live, which is why this step comes last. Once
      WhatsApp is live, the Customer simulator disappears from the dashboard.
- [ ] Meta App → WhatsApp → Configuration → Webhook: callback
      `https://<domain>/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`
- [ ] Subscribe the webhook to the **messages** field
- [ ] From a team member's phone, send "Hi" to the business number. It should appear in the server
      log.

## F. Live acceptance test (₹1)

This is the client's scenario, run live. Use a team member's phone.

1. **Test product.** Add a product "Test item" at **₹1 with stock 1** to both the Meta catalogue
   and **Products & stock**, with the same Content ID.
2. **Cart.** From the phone, open the catalogue and send a cart with **Test item × 2**.
   - Expected: an acknowledgement arrives saying "No payment is needed right now".
   - Expected: the order shows up under **Needs review** with "2 requested, only 1 in stock".
3. **Revise.** The admin reduces the quantity to **1** and clicks **Send revised order to
   customer**.
   - Expected: the phone receives the revised order with **Accept Updated Order / Cancel Order**.
4. **Accept.** Tap **Accept Updated Order**.
   - Expected: WhatsApp's address form arrives.
5. **Address.** Fill in a real address.
   - Expected: "We've saved your delivery address". The order is **Ready for payment**, with a
     real Shiprocket quote.
6. **Final amount.** The admin opens **Change shipping** and sets the charge to **₹0** (reason:
   "Live test"). The total should now be **₹1**.
7. **Payment request.** Click **Send payment request**.
   - Expected: the phone gets the native order card with **Pay Now** for ₹1.
8. **Pay.** Pay with UPI.
   - Expected: "🎉 Payment Successful" with a **QZ…** order ID.
   - Expected: the order is **Paid**, then **Processing**.
   - Expected: the payment shows **verified with Razorpay** and appears in the Razorpay dashboard.
9. **Shipment.**
   - Expected: a Shiprocket order exists with the QZ order ID, an AWB, a pickup request and a
     manifest.
   - Check in the Razorpay dashboard that the payment's order **receipt** equals the order's
     payment reference (e.g. `RQ…-1`). The system uses it to match payments that arrive without notes.
10. **Refund.** Choose one:
    - (a) Click **Cancel & refund**. Expected: the Shiprocket order is cancelled, ₹1 is refunded,
      and the customer gets the refund message.
    - (b) Let the parcel ship to the team member, and check the dispatch, out-for-delivery and
      delivered messages. The feedback message follows after the configured delay.
11. **Template path.** The next day, more than 24 hours after the phone last messaged, repeat steps
    2–3.
    - Expected: the revised order arrives as the **`qz_order_update` template**, and tapping its
      button carries on normally.

Afterwards, delete the test product, or set it to inactive.

## G. After go-live

- [ ] An uptime monitor is watching `/health`
- [ ] For the first week, check the order history for red alerts (failed messages, payment alerts,
      delivery issues)
- [ ] Check that `WebhookEvent` rows with an `error`, and `ScheduledJob` rows with status `FAILED`,
      stay at zero

**Rollback:** set the affected `*_MODE` back to `mock` and restart. Orders and their history stay
as they are.
