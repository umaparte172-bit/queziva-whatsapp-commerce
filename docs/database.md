# Data model

The schema is in `prisma/schema.prisma`. Conventions:
- **Money** is stored in integer paise.
- **GST rates** are in basis points (300 = 3%).
- **IDs** are CUIDs.
- **Timestamps** are in UTC.

## Tables

| Table | Holds |
|---|---|
| **Product** | SKU, catalogue `retailerId`, name, price, **stock**, GST rate, HSN, packed weight and box size, active flag |
| **Customer** | WhatsApp ID (phone), name, `lastInboundAt` (for the 24-hour window), `savedAddress` (to prefill the next order) |
| **Order** | One order request, from the cart to completion (see below) |
| **OrderItem** | One line: product snapshot (SKU, name, unit price, GST), `requestedQuantity` (the customer's cart, never changed), `quantity` (approved), flags for added, removed or replacement lines |
| **OrderEvent** | **Append-only audit trail:** every status change, edit, message, payment and shipment event, with the actor (admin, customer or system) |
| **Payment** | One row per payment request: `referenceId` (`QZP-RQ…-n`), amount, status, Razorpay payment and order IDs, method, verification time, refunds |
| **Shipment** | Shiprocket order and shipment IDs, courier, AWB, tracking URL, latest courier status and time, pickup request time, milestones already sent to the customer |
| **Message** | Every WhatsApp message in and out, with its payload and delivery status |
| **WebhookEvent** | Every inbound webhook event, stored once per source and event ID (makes processing idempotent) |
| **ScheduledJob** | Background jobs: reminders, timeouts, shipment creation, feedback, tracking polls |
| **AdminUser** | Dashboard logins (scrypt password hashes) |
| **Counter** | Daily sequences for RQ and QZ numbers |
| **Setting** | Dashboard-editable settings (notifications, feedback, Instagram) |

## Order fields

- **Identity:**
  - `requestNumber` (RQ…) is assigned when the cart arrives.
  - `orderNumber` (QZ…) is assigned **once payment is verified**.
  - `version` is used to detect concurrent edits.
  - `approvalRound` identifies the revised order being approved.
- **Amounts:** `subtotalPaise`, `discountPaise` (+ reason), `shippingPaise` (what the customer
  pays), `shippingCostPaise` (what the courier costs), `taxPaise`, `pricesIncludeGst`, `totalPaise`.
- **Delivery:** `shipName`, `shipPhone`, `shipHouse`, `shipStreet`, `shipLandmark`, `shipCity`,
  `shipState`, `shipPincode`. Shipping quote: courier ID and name, delivery estimate, parcel
  weight, and when it was quoted.
- **Lifecycle timestamps:** `reviewStartedAt`, `approvedAt`, `paymentRequestedAt`, `paidAt`,
  `processingAt`, `shippedAt`, `deliveredAt`, `completedAt`, `cancelledAt` (+ `cancelReason`).
- **Audit:** `rawRequest` keeps the original WhatsApp cart payload exactly as received.

## Order statuses

```
NEW → PENDING_REVIEW ─┬─► AWAITING_ADDRESS                           (approved unchanged)
                      └─► MODIFIED → AWAITING_CUSTOMER_APPROVAL ─► AWAITING_ADDRESS
AWAITING_ADDRESS → READY_FOR_PAYMENT → PAYMENT_REQUESTED → PAID → PROCESSING
→ SHIPPED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED → COMPLETED
Any status before pickup → CANCELLED (after payment: refund)
```

The rules are defined in `src/domain/orderStatus.ts`: which status can follow which, and who may
make each change. Key ones:
- Payment can only be requested from READY_FOR_PAYMENT. That needs items, a complete address, a
  shipping quote and a correct total.
- A changed order needs the **customer's** acceptance.
- Only the system can mark an order PAID, and only when a Razorpay-verified payment for the full
  amount exists.
