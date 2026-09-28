# Setup and configuration

## Requirements

- **Node.js 20 or newer** (developed on Node 24)
- **Development:** nothing else. The database is a local SQLite file.
- **Production:** PostgreSQL 14 or newer (see [deployment.md](deployment.md))

## Local development

```bash
npm install
cp .env.example .env
npx prisma db push
npm run db:seed
npm run admin:build
npm run dev
```

The last three commands do the following:
- `db:seed` adds sample products and the first admin login from `ADMIN_EMAIL` and
  `ADMIN_PASSWORD`.
- `admin:build` builds the dashboard.
- `dev` starts the API and the dashboard at http://localhost:3000/admin.

Useful commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the full test suite (SQLite) |
| `npm run typecheck` | Type-checks the server and the dashboard |
| `npm run admin:dev` | Runs the dashboard with live reload at http://localhost:5173/admin/ (run `npm run dev` too) |
| `npm run admin:create -- <email> <password> [name]` | Adds an admin login, or resets a password |
| `npm run db:studio` | Opens a database browser |

When `WHATSAPP_MODE`, `RAZORPAY_MODE` and `SHIPROCKET_MODE` are all `mock`, nothing leaves the
machine. Use the **Customer simulator** page in the dashboard to play the customer.

### Running the tests against PostgreSQL

The suite normally uses SQLite. To run it against PostgreSQL:

1. Create an **empty, throwaway** database.
2. Switch the generated client to PostgreSQL, then run the tests with `TEST_DATABASE_URL` pointing
   at that database:

   ```bash
   npx prisma generate --schema prisma/postgres/schema.prisma
   TEST_DATABASE_URL=postgresql://user@localhost:5432/queziva_test npx vitest run
   ```

   The test setup applies the production migrations to that database.
3. Switch the client back to SQLite afterwards with `npx prisma generate`.

## Configuration reference (`.env`)

Required settings are checked at startup. If an integration is set to `live` without its
credentials, or production has no session secret, the server refuses to start and lists what's
missing.

### App

| Setting | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` on the server |
| `PORT` | `3000` | |
| `APP_BASE_URL` | `http://localhost:3000` | Public HTTPS address; webhook URLs are built from it. With `https://`, cookies are marked Secure. |
| `LOG_LEVEL` | `info` | `debug` for troubleshooting |
| `TIMEZONE` | `Asia/Kolkata` | Used for order ID dates |
| `DATABASE_URL` | `file:./dev.db` | Production: `postgresql://…` |
| `BRAND_NAME` | `Queziva` | Used in customer messages |

### Orders and pricing

| Setting | Default | Notes |
|---|---|---|
| `ORDER_ID_PREFIX` | `QZ` | Final order ID, e.g. QZ260928001 (prefix + YYMMDD + daily number) |
| `REQUEST_ID_PREFIX` | `RQ` | ID given when a cart arrives, e.g. RQ260928001 |
| `PRICES_INCLUDE_GST` | `true` | `true`: catalogue prices include GST, which is shown but not added. `false`: GST is added on top. |
| `DEFAULT_GST_RATE_BPS` | `300` | 3% (jewellery), in basis points. Can be set per product. |

### Integrations

| Setting | Default | Notes |
|---|---|---|
| `WHATSAPP_MODE` / `RAZORPAY_MODE` / `SHIPROCKET_MODE` | `mock` | Razorpay and Shiprocket can go `live` on their own. `WHATSAPP_MODE=live` requires both of them to be `live` too, so real customers can never be sent a mock payment or shipment. |

### WhatsApp (required when `WHATSAPP_MODE=live`)

| Setting | Notes |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token (`whatsapp_business_messaging`, `whatsapp_business_management`, `catalog_management`) |
| `WHATSAPP_PHONE_NUMBER_ID` | From WhatsApp Manager → Phone numbers |
| `WHATSAPP_WABA_ID` | WhatsApp Business Account ID |
| `WHATSAPP_CATALOG_ID` | The Meta catalogue connected to the number |
| `WHATSAPP_APP_SECRET` | Meta App → Settings → Basic. Used to verify webhook signatures. |
| `WHATSAPP_VERIFY_TOKEN` | Any random string; enter the same value when subscribing the webhook |
| `WHATSAPP_PAYMENT_CONFIGURATION` | Exact name of the Razorpay payment configuration in WhatsApp Manager |
| `WHATSAPP_GRAPH_VERSION` | Graph API version, default `v23.0` |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Default `en` |
| `TEMPLATE_*` | Template names, if they differ from [whatsapp-templates.md](whatsapp-templates.md) |

### Razorpay (required when `RAZORPAY_MODE=live`)

| Setting | Notes |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Dashboard → Account & Settings → API Keys (live keys for production) |
| `RAZORPAY_WEBHOOK_SECRET` | The secret entered when creating the webhook |

### Shiprocket (required when `SHIPROCKET_MODE=live`)

| Setting | Default | Notes |
|---|---|---|
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | | The **API user** (Settings → API → Create API user), not the main login |
| `SHIPROCKET_PICKUP_LOCATION` | `Primary` | Pickup address nickname, exactly as in Shiprocket |
| `SHIPROCKET_PICKUP_PINCODE` | `110001` | Pincode of that pickup address |
| `SHIPROCKET_WEBHOOK_TOKEN` | | Token entered on the Shiprocket webhook; it arrives as `x-api-key` |
| `SHIPROCKET_FALLBACK_EMAIL` | | **Required when Shiprocket is live.** Billing email on Shiprocket orders (WhatsApp gives no customer email) |
| `SHIPROCKET_API_BASE` | Shiprocket v1 API | Normally left as is |

### Shipping rules

| Setting | Default | Notes |
|---|---|---|
| `SHIPPING_COURIER_STRATEGY` | `cheapest` | `cheapest`, `fastest` or `recommended` (Shiprocket's pick) |
| `FREE_SHIPPING_ABOVE_RUPEES` | `0` | Free shipping when the product total after discount reaches this; `0` turns it off |
| `SHIPPING_FLAT_RATE_RUPEES` | empty | A fixed charge to customers; empty charges the courier rate |
| `PACKAGING_WEIGHT_GRAMS` | `50` | Added to the product weights |
| `SHIPPING_ROUND_TO_RUPEE` | `true` | ₹58.40 → ₹59 |

### Customer response times (hours; 0 turns it off)

| Setting | Default |
|---|---|
| `APPROVAL_REMINDER_HOURS` / `APPROVAL_TIMEOUT_HOURS` | 12 / 48 |
| `ADDRESS_REMINDER_HOURS` / `ADDRESS_TIMEOUT_HOURS` | 12 / 72 |
| `PAYMENT_REMINDER_HOURS` / `PAYMENT_EXPIRY_HOURS` | 12 / 48 |

### Admin

| Setting | Default | Notes |
|---|---|---|
| `ADMIN_SESSION_SECRET` | dev value | **Required** (32+ random characters, `openssl rand -hex 32`) whenever `NODE_ENV=production`, any integration is `live`, or `APP_BASE_URL` is https. The server refuses to start otherwise. |
| `ADMIN_SESSION_HOURS` | `12` | How long a login lasts |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | | Used only by `npm run db:seed` to create the first login |

### Settings in the dashboard (not `.env`)

Found under **Settings**:
- Which shipping updates customers receive.
- The feedback delay, and whether to send feedback at all.
- The Instagram handle.
- The review link.
