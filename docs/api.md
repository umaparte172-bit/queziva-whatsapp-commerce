# API reference

All request and response bodies are JSON. Money is always given in **paise** (₹1 = 100).

## Errors

Every error has the same shape:

```json
{ "error": { "code": "CONFLICT", "message": "Order was updated by someone else – reload and try again", "details": {} } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON` | Bad input (`details` lists the fields) |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | Not signed in, or a wrong password |
| 404 | `NOT_FOUND` | |
| 409 | `CONFLICT` | Stale `expectedVersion`, or the action isn't allowed in the current state |
| 409 | `INVALID_TRANSITION` | The order can't move to that status (`details.from/to`) |
| 409 | `OUTSIDE_SERVICE_WINDOW` | A free-form WhatsApp message was attempted after 24 hours |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Admin writes must be sent as JSON |
| 429 | `RATE_LIMITED` | Too many failed sign-ins (10 per 15 minutes per IP) |
| 502 | `WHATSAPP_API_ERROR`, `RAZORPAY_API_ERROR`, `SHIPROCKET_API_ERROR` | The external service failed. The message explains why (for example, 24-hour window or insufficient wallet balance). |

---

## Public endpoints

### `GET /health`

`200 {"status":"ok","database":"ok","integrations":{"whatsapp":"live",…}}`, or `503` if the
database is down.

### WhatsApp: `GET /webhooks/whatsapp`

Meta's subscription check. If `hub.mode=subscribe` and `hub.verify_token` matches
`WHATSAPP_VERIFY_TOKEN`, it replies with `hub.challenge`; otherwise `403`.

### WhatsApp: `POST /webhooks/whatsapp`

- **Checks:** the `X-Hub-Signature-256` header (`sha256=` + HMAC of the raw body with the App
  Secret). Anything else gets `401`.
- **Processing:** each event is stored once in `WebhookEvent`, so redeliveries are ignored and
  events that failed earlier are retried.
- **Response:** `200 {"received":true,"processed":n,"duplicates":n,"ignored":n,"failed":n}`. If any
  event failed, the response is `500` instead, so Meta redelivers it; events already handled are skipped.

| WhatsApp event | What happens |
|---|---|
| `order` (catalogue cart) | New order request (status NEW); the customer gets an acknowledgement |
| `interactive.button_reply` / template `button` | Accept or cancel a revised order, share address, review and pay (button ids `qz:<action>:<orderId>:<round>`) |
| `interactive.nfm_reply` (`address_message`) | Delivery address, then validation and a Shiprocket quote |
| `text` | Logged on the customer's open (or recently completed) order |
| `statuses` (sent/delivered/read/failed) | Message delivery status; failures are shown on the order |
| `statuses` with `type: payment` | Payment. **Verified with the Razorpay API** before the order is marked paid. |

### Razorpay: `POST /webhooks/razorpay`

- **Checks:** the `X-Razorpay-Signature` header (HMAC of the raw body with the webhook secret);
  otherwise `401`.
- **Deduplication:** by `X-Razorpay-Event-Id`.
- **Events:**
  - `payment.captured`, `payment.failed`, `order.paid`: the payment is looked up with Razorpay and
    matched by `notes.reference_id`, or by the Razorpay order's `receipt`.
  - `refund.processed`, `refund.failed`: recorded on the order.
- **Responses:** `200 {"result":"processed"|"duplicate"|"ignored"}`, or `500` if processing failed,
  so Razorpay redelivers.

### Shiprocket: `POST /webhooks/tracking`

- **Checks:** the `x-api-key` header must equal `SHIPROCKET_WEBHOOK_TOKEN`; otherwise `401`.
- **Matching:** the shipment is found by `awb`, or by `order_id` (our QZ order ID).
- **Status:** read from `current_status`, with the time from `current_timestamp` (Indian time).
- **Returns:** payloads with `is_return: 1` are treated as returns.
- **Response:** always `200` once authenticated. Failures are stored, and the tracking poll recovers
  them.

---

## Admin API (`/api/admin`)

**Authentication:**
- `POST /api/admin/auth/login` sets an HttpOnly, SameSite=Strict session cookie (`qz_admin`).
- Every other endpoint needs that cookie. Without it, the response is `401`.
- Write requests must be sent as JSON.

**Concurrency:** every change to an order sends the `expectedVersion` from the last read. If
someone else changed the order in between, the response is `409 CONFLICT`. Change endpoints return
the full, refreshed order. If something around the change failed, such as the WhatsApp message, the
response includes a `warning`.

### Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ admin }` and the cookie |
| POST | `/auth/logout` | `{}` | clears the cookie |
| GET | `/auth/me` | | `{ admin, simulator }` |

### Orders

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/orders` | `?status=NEW,PENDING_REVIEW&q=&stockIssues=1&page=1&pageSize=25` | `q` matches request or order ID, phone, or name (not case-sensitive) |
| GET | `/orders/summary` | | `{ counts: {STATUS: n}, stockIssues: n }` |
| GET | `/orders/:id` | | Full order: items with live stock, events, payments, shipments, `permissions`, `actions`, `stockProblems` |
| PATCH | `/orders/:id/items/:itemId` | `{ expectedVersion, quantity }` | Before approval only |
| POST | `/orders/:id/items` | `{ expectedVersion, productId, quantity }` | Adds a product |
| POST | `/orders/:id/items/:itemId/replace` | `{ expectedVersion, productId, quantity? }` | |
| POST | `/orders/:id/items/:itemId/remove` | `{ expectedVersion }` | The last item can't be removed |
| PUT | `/orders/:id/discount` | `{ expectedVersion, discountPaise, reason? }` | Allowed until payment is requested |
| PUT | `/orders/:id/address` | `{ expectedVersion, name, phone, house, street, landmark?, city, state, pincode }` | Allowed while waiting for an address, or during the final review (re-quoted) |
| GET | `/orders/:id/shipping-options` | | Live courier options, with the customer charge for each |
| PUT | `/orders/:id/shipping` | `{ expectedVersion, courierId }` or `{ expectedVersion, manualChargePaise, reason }` | |
| POST | `/orders/:id/notes` | `{ note }` | Internal note |
| POST | `/orders/:id/actions/:action` | `{ expectedVersion, reason? }` | See below |
| POST | `/orders/:id/close` | `{ expectedVersion, reason, restock, refund }` | **Close – not delivered**, for SHIPPED / IN_TRANSIT / OUT_FOR_DELIVERY (lost parcel, RTO). Cancels the order, optionally restocks and refunds. |
| POST | `/orders/:id/test-payment` | `{ outcome: "captured"\|"failed" }` | **Test mode only** |

**Actions.** The order's `actions` field lists which ones are currently available:

| Action | Available when | Effect |
|---|---|---|
| `start_review` | NEW | Pending review. Not listed in `actions`: the dashboard calls it by itself when the order is opened. |
| `approve` | NEW / PENDING_REVIEW / MODIFIED | Stock checked. Unchanged order: address request. Changed order: revised order sent for approval. |
| `resend` | Waiting for customer approval, address or payment | Sends the current request to the customer again |
| `quote_shipping` | Address saved, not yet quoted | Gets a Shiprocket rate, then Ready for payment |
| `request_payment` | READY_FOR_PAYMENT | Sends the native `order_details` Pay Now |
| `withdraw_payment` | PAYMENT_REQUESTED | Back to Ready for payment; the old Pay card is disabled |
| `create_shipment` | PAID / PROCESSING with the shipment unfinished | Retries the Shiprocket order, AWB and pickup |
| `refresh_tracking` | Shipped statuses | Fetches the latest tracking from Shiprocket |
| `mark_delivered` | SHIPPED / IN_TRANSIT / OUT_FOR_DELIVERY | Manual delivery confirmation |
| `retry_refund` | A refund is pending or failed | Refunds whatever Razorpay hasn't refunded yet (never more) |
| `cancel` | Not yet picked up | `reason` is required. Before payment: cancel and notify the customer. After payment: cancel the shipment, refund in full, return stock and notify the customer. |

### Products

| Method | Path | Body / query |
|---|---|---|
| GET | `/products` | `?q=&includeInactive=1` |
| POST | `/products` | `{ sku, retailerId?, name, pricePaise, stock, gstRateBps?, hsnCode?, weightGrams?, lengthCm?, breadthCm?, heightCm?, active? }` |
| PATCH | `/products/:id` | Any of the fields above |

`retailerId` is the Content ID of the item in the Meta catalogue. It defaults to the SKU.

### Settings

| Method | Path | Body |
|---|---|---|
| GET | `/settings` | |
| PUT | `/settings` | `{ notify: { SHIPPED, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERY_ATTEMPT_FAILED, DELIVERED }, feedback: { enabled, delayHours }, instagramHandle, reviewUrl }` (partial updates allowed) |

### Customer simulator (test mode only)

These routes exist only while WhatsApp, Razorpay and Shiprocket are **all** `mock`, and only for
`91999XXXXXXX` numbers. Fast-forward only runs jobs for simulator orders. Every call
returns the simulator state.

| Method | Path | Body |
|---|---|---|
| GET | `/simulator?waId=` | |
| POST | `/simulator/cart` | `{ waId, name, items: [{ retailerId, quantity }] }` |
| POST | `/simulator/text` | `{ waId, text }` |
| POST | `/simulator/button` | `{ waId, id, title, onTemplate }` |
| POST | `/simulator/address` | `{ waId, values: { name, phone_number, in_pin_code, house_number, address, city, state, … } }` |
| POST | `/simulator/pay` | `{ waId, outcome }` |
| POST | `/simulator/courier` | `{ waId, status }` |
| POST | `/simulator/fast-forward` | `{ waId, hours }` |
