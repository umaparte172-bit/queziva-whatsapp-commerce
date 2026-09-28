# Queziva orders – team guide

A plain-language guide to the order dashboard. Sign in at `https://<your domain>/admin`.

## The order journey

| Step | Who | What you see |
|---|---|---|
| Customer sends a cart from the WhatsApp catalogue | Customer | **New** order. The customer is told no payment is needed yet. |
| You check stock and approve, or change the order | You | Opening an order marks it **Pending review** |
| If you changed something, the customer accepts or cancels | Customer | **Customer approval** |
| Customer shares their address in WhatsApp | Customer | **Awaiting address** |
| Shipping is calculated with Shiprocket automatically | System | **Ready for payment** |
| You check the final amount and send the payment request | You | **Waiting for payment** |
| Customer pays inside WhatsApp; the payment is checked with Razorpay | Customer | **Paid**. The QZ order ID is created and the confirmation sent. |
| Shiprocket order, AWB and pickup are created automatically | System | **Processing** |
| The courier updates tracking; the customer gets updates | Courier | **Shipped → In transit → Out for delivery → Delivered** |
| Feedback and Instagram message after the set delay | System | **Completed** |

## Daily work

**Orders page.** The **Needs review** tab shows new orders. The **Stock issues** tab shows orders
asking for more than you have. The number next to "Orders" in the sidebar counts orders waiting for review.
The list refreshes every 30 seconds.

**Reviewing an order:**
- Each line shows what the customer **requested**, the **quantity** being sent, and the **stock**.
- Use **− / +** to change a quantity. **Replace** swaps in another product; **Remove** drops a
  line; **+ Add product** adds one.
- **Approve order** is available when nothing changed. The customer is then asked for their address.
- **Send revised order to customer** appears when you changed something. The customer sees exactly
  what changed and must accept before paying.
- You can't approve while stock is short: reduce the quantity, or update the stock first.
- **Add discount** gives an amount off, with a reason that only the team sees.
- **Internal note** is visible only to the team.

**Final review (Ready for payment):**
- Check the amount: products, discount, shipping, and GST.
- **Change shipping** lets you pick another courier, or set the customer's shipping charge by hand
  (for example free shipping for a repeat customer).
- The **Delivery** card has **Edit** if the address needs correcting; shipping is then recalculated.
- **Send payment request** sends the customer the order card with **Pay Now**.

**Waiting for the customer:**
- **Resend WhatsApp message** sends the current request again.
- Reminders go automatically after 12 hours. Orders are cancelled if there's no reply: 48 hours
  for approval, 72 hours for the address, 48 hours for payment.
- To change a payment request, click **Withdraw payment request**. The old Pay button stops
  working, and you can edit again.

**After payment**, everything is automatic. If Shiprocket fails (for example, the wallet balance
is low), the order history shows the error and a **Retry shipment** button appears. Once the
courier is assigned, the pickup is requested and the Shiprocket manifest is generated for you.

## When something goes wrong

| Situation | What to do |
|---|---|
| An entry with a red dot in the order history | It's an alert, and the text says what happened: a message not delivered, a payment problem, a delivery issue. |
| Customer typed their address instead of using the form | Their message is in the history. Click **Enter manually** on the Delivery card. |
| "No courier delivers to this pincode" | The customer was already asked for another address. |
| Customer wants to cancel after paying | **Cancel & refund**, possible until the courier picks the parcel up. It cancels the shipment, refunds in full through Razorpay and puts the stock back. |
| Customer paid the wrong amount, paid twice, or paid after the order changed | The system refunded it automatically, and there's an alert on the order. |
| An alert says a refund failed | Usually a temporary Razorpay problem. Click **Retry refund**. It only refunds what hasn't been refunded yet, so clicking it twice can't refund twice. |
| Parcel lost, or returned to you (RTO) and the order is over | **Close – not delivered**. You choose whether to put the stock back and whether to refund the customer. The reason is saved in the history. |
| Parcel returning to you (RTO), lost or damaged | Alert on the order. Handle it with the courier in Shiprocket, then use **Close – not delivered** once it's settled. |
| Tracking looks stuck | **Refresh tracking**. If the customer confirms they have it, use **Mark as delivered**. |
| "Updated by someone else – reload" | A teammate changed the order at the same time. It reloads; check and try again. |

## Products & stock

- **Catalogue ID** must be the product's Content ID in the WhatsApp catalogue. That's how carts
  are matched to products.
- Edit **stock** straight in the list: type the number and press Enter. Stock goes down
  automatically when an order is paid, and back up when a paid order is refunded.
- **Packed weight and box size** decide the Shiprocket rate, so keep them accurate.
- Set a product **inactive** to hide it from the admin product picker.

## Settings

- **Shipping updates on WhatsApp:** choose which courier updates customers receive. "In transit"
  is off by default, because couriers send it often.
- **Feedback and Instagram:** turn the follow-up on or off, and set how many hours after delivery
  it goes out, your Instagram handle, and an optional review link.

## The 24-hour rule

WhatsApp only allows normal messages within 24 hours of the customer's last message. After that,
the system automatically sends the pre-approved template version, and when the customer taps its
button the conversation continues. You don't need to do anything.
