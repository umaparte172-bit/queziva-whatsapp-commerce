# WhatsApp message templates to submit

WhatsApp only allows free-form messages within **24 hours** of the customer's last message.
The system sends normal interactive messages whenever it can. When the window has closed,
it sends these pre-approved **templates** instead, for example when an order is reviewed the
next day or for a reminder. When the customer taps a template button, the window opens again,
and the conversation carries on as normal.

## How to submit

Create each template in **WhatsApp Manager → Message templates → Create template**:

- **Category:** Utility
- **Language:** English (`en`)
- **Name:** exactly as below. If you choose a different name, set it in `.env`.
- **Sample values:** enter one for every `{{n}}` variable (Meta requires this for review).

Approval usually takes from a few minutes to 24 hours.

Rules the texts below already follow:
- The body does not start or end with a variable.
- Quick-reply button text is 25 characters or fewer.
- Variables are filled in by the system; the button actions are attached when each message is sent.

---

## 1. `qz_order_update` — revised order needs approval

`.env`: `TEMPLATE_ORDER_UPDATE=qz_order_update`

**Body**

```
Hi {{1}}, we've reviewed your Queziva order {{2}}.

What changed: {{3}}
Updated product total: {{4}}

Please confirm to continue. No payment is needed yet.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Request ID | RQ260928001 |
| `{{3}}` | What changed (one line) | Pearl Drop Earrings: 2 requested, only 1 available |
| `{{4}}` | New product total | ₹647 |

**Buttons:** Quick reply `Accept Updated Order` and Quick reply `Cancel Order`. Keep this order,
because the first button is Accept.

---

## 2. `qz_address_request` — order confirmed, please share your address

`.env`: `TEMPLATE_ADDRESS_REQUEST=qz_address_request`

**Body**

```
Hi {{1}}, your Queziva order {{2}} is confirmed ✨

Please tap below to share your delivery address so we can calculate shipping.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Request ID | RQ260928001 |

**Buttons:** Quick reply `Share Address`. Tapping it opens WhatsApp's native address form.

---

## 3. `qz_order_cancelled` — order cancelled

`.env`: `TEMPLATE_ORDER_CANCELLED=qz_order_cancelled`

**Body**

```
Hi {{1}}, your Queziva order {{2}} has been cancelled. {{3}}

You're welcome to order again anytime from our catalogue.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Request ID | RQ260928001 |
| `{{3}}` | Short reason | No payment was taken. |

**Buttons:** none.

---

## 4. `qz_payment_request` — order ready, review and pay

`.env`: `TEMPLATE_PAYMENT_REQUEST=qz_payment_request`

**Body**

```
Hi {{1}}, your Queziva order {{2}} is ready. Total payable: {{3}} (including shipping).

Tap below to review your order and pay securely on WhatsApp.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Request ID | RQ260928001 |
| `{{3}}` | Final amount | ₹706 |

**Buttons:** Quick reply `Review & Pay`. Tapping it opens the chat, and the native WhatsApp
order card with **Pay Now** is sent straight away.

---

## 5. `qz_order_confirmed` — payment successful

`.env`: `TEMPLATE_ORDER_CONFIRMED=qz_order_confirmed`

This is only needed when the customer pays more than 24 hours after their last message. Usually
the confirmation is sent as a normal message, which also updates their order card.

**Body**

```
Hi {{1}}, your payment was successful 🎉

Order ID: {{2}}
Amount paid: {{3}}

Your Queziva order is confirmed. We'll share tracking details as soon as it ships.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Queziva order ID | QZ260928001 |
| `{{3}}` | Amount paid | ₹706 |

**Buttons:** none.

---

## Shipping updates

These are usually sent days after the customer's last message, so the templates below are
what customers actually receive. Which updates are sent is chosen in the dashboard under
**Settings**.

Four of these templates have a **Track Shipment** button. Its URL uses a variable:
- **Button type:** Visit website → Dynamic
- **URL:** `https://shiprocket.co/tracking/{{1}}`
- **Sample:** `1409118223`

The system fills in the AWB.

### 6. `qz_order_dispatched`

```
Hi {{1}}, your Queziva order {{2}} has been dispatched 📦

Courier: {{3}}
AWB: {{4}}

Tap below to track your shipment.
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |
| `{{2}}` | Queziva order ID | QZ260928001 |
| `{{3}}` | Courier | Delhivery |
| `{{4}}` | AWB | 1409118223 |

**Button:** Visit website, `Track Shipment` (dynamic URL as above).

### 7. `qz_in_transit`

This template is only used if "In transit" updates are switched on; they're off by default.

```
Hi {{1}}, your Queziva order {{2}} is on its way 🚚 Tap below to see where it is.
```

**Button:** Visit website, `Track Shipment` (dynamic URL).

### 8. `qz_out_for_delivery`

```
Hi {{1}}, your Queziva order {{2}} is out for delivery today 🛵 Please keep your phone handy for the courier.
```

**Button:** Visit website, `Track Shipment` (dynamic URL).

### 9. `qz_delivery_attempt`

```
Hi {{1}}, the courier couldn't deliver your Queziva order {{2}} today. They will try again – reply here if you'd like to share delivery instructions.
```

**Buttons:** none.

### 10. `qz_order_delivered`

```
Hi {{1}}, your Queziva order {{2}} has been delivered 🎉

We hope you love your jewellery! 💎

📹 Please record a continuous unboxing video while opening your parcel. This helps us in case of any issue with the shipment.
```

**Buttons:** none.

---

## 11. `qz_feedback_request` — feedback and Instagram

Sent after the delay set in **Settings** (48 hours after delivery by default).

```
Hi {{1}}! 💎 How are you liking your Queziva jewellery?

We'd love to hear your feedback – just reply to this message. And tag us on Instagram when you wear your pieces, we love sharing our customers' looks!
```

| Variable | Filled with | Sample |
|---|---|---|
| `{{1}}` | Customer first name | Priya |

**Button:** Visit website, `Follow on Instagram`, with a **static** URL
`https://instagram.com/<your handle>`.

---

## Summary

| # | Template | When |
|---|---|---|
| 1 | `qz_order_update` | Revised order needs approval |
| 2 | `qz_address_request` | Order confirmed, address needed |
| 3 | `qz_order_cancelled` | Order cancelled or refunded |
| 4 | `qz_payment_request` | Final amount ready, Pay Now |
| 5 | `qz_order_confirmed` | Payment successful |
| 6 | `qz_order_dispatched` | Picked up by the courier |
| 7 | `qz_in_transit` | Optional transit updates |
| 8 | `qz_out_for_delivery` | Out for delivery |
| 9 | `qz_delivery_attempt` | Delivery attempt failed |
| 10 | `qz_order_delivered` | Delivered, with the unboxing video request |
| 11 | `qz_feedback_request` | Feedback and Instagram follow-up |
