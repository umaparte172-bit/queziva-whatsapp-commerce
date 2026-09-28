# Production deployment

This runs as one Node.js service with a PostgreSQL database. The API, the webhooks, the admin
dashboard and the background jobs are all served by the same process.

## 1. Server

- **Server:** a small VPS is plenty, for example 1 vCPU / 1–2 GB RAM (DigitalOcean, AWS Lightsail,
  Hostinger VPS, etc.), running Ubuntu 22.04 or 24.04 LTS.
- **Node.js 20+:** install with nodesource or nvm.
- **PostgreSQL 14+:** on the same server, or a managed one (for example Supabase, Neon or AWS RDS).
  Turn on daily backups.
- **Domain with HTTPS:** for example `orders.queziva.com`. Meta, Razorpay and Shiprocket only call
  HTTPS URLs.

## 2. Database

```sql
CREATE DATABASE queziva;
CREATE USER queziva WITH PASSWORD '<strong password>';
GRANT ALL PRIVILEGES ON DATABASE queziva TO queziva;
-- PostgreSQL 15+: also let the user create tables in the public schema
\c queziva
GRANT ALL ON SCHEMA public TO queziva;
```

Development and tests use SQLite (`prisma/schema.prisma`). Production uses
`prisma/postgres/schema.prisma`, which is generated from it, together with the migrations in
`prisma/postgres/migrations`. The full test suite has been run against PostgreSQL 17.

## 3. Install and build

```bash
git clone <repo> /opt/queziva && cd /opt/queziva
npm ci
cp .env.example .env
nano .env
npm run build:prod
npm run db:deploy
NODE_ENV=production npm run db:seed
```

- **`.env`:** set `NODE_ENV=production`, `DATABASE_URL`, `APP_BASE_URL`, `ADMIN_SESSION_SECRET` and
  the credentials. Leave the integrations on `mock` until their go-live step
  ([go-live-checklist.md](go-live-checklist.md)). All settings are listed in [setup.md](setup.md).
- **`build:prod`** generates the PostgreSQL client, then compiles the server and the dashboard.
- **`db:deploy`** applies the database migrations.
- **`db:seed`** creates the first admin login from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. In
  production it adds no sample products.

Don't set `NODE_ENV=production` in the shell before `npm ci`. The build and migration steps need the
development packages (TypeScript, Vite, the Prisma CLI, tsx), and npm skips those when
`NODE_ENV=production`. The app reads `NODE_ENV` from `.env` at runtime.

npm 11 may ask to approve install scripts for `prisma`, `@prisma/client`, `@prisma/engines` and
`esbuild`. Approve them with `npm install-scripts approve <package>`.

## 4. Run as a service (systemd)

`/etc/systemd/system/queziva.service`:

```ini
[Unit]
Description=Queziva WhatsApp commerce
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/queziva
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=queziva
EnvironmentFile=/opt/queziva/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now queziva
journalctl -u queziva -f
```

Logs are JSON lines, one per event.

Run **one instance**. The background jobs (reminders, timeouts, shipments, tracking polls) are safe
to run on several instances, because each job is claimed exactly once. The admin login throttle,
though, is kept in memory per instance.

## 5. HTTPS reverse proxy (nginx)

```nginx
server {
    server_name orders.queziva.com;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then enable HTTPS with `sudo certbot --nginx -d orders.queziva.com`.

The app trusts one proxy hop (`trust proxy = 1`), so the client IP used by the login throttle comes
from `X-Forwarded-For`.

## 6. Webhooks to register

| Service | Where | URL | Secret or token |
|---|---|---|---|
| Meta (WhatsApp) | Meta App → WhatsApp → Configuration → Webhook, subscribe to **messages** | `https://<domain>/webhooks/whatsapp` | Verify token = `WHATSAPP_VERIFY_TOKEN`; signatures checked with `WHATSAPP_APP_SECRET` |
| Razorpay | Dashboard → Account & Settings → Webhooks | `https://<domain>/webhooks/razorpay` | `RAZORPAY_WEBHOOK_SECRET`. Events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed` |
| Shiprocket | Settings → API → Webhooks | `https://<domain>/webhooks/tracking` | Token = `SHIPROCKET_WEBHOOK_TOKEN`, sent as `x-api-key` |

Shiprocket rejects webhook URLs containing "shiprocket", "kartrocket", "sr" or "kr". Keep the
domain and path free of those.

## 7. Health and monitoring

- **Health check:** `GET /health` returns `200 {"status":"ok","database":"ok",…}`. Point an uptime
  monitor at it (for example UptimeRobot).
- **Problems on orders:** failed WhatsApp sends, payment alerts and delivery issues are recorded on
  the order and shown in red in its history.
- **Processing failures:** webhook events that failed to process stay in the `WebhookEvent` table
  with an `error`. Background jobs that failed three times stay in `ScheduledJob` with status
  `FAILED`.

## 8. Updating

```bash
cd /opt/queziva && git pull && npm ci && npm run build:prod && npm run db:deploy && sudo systemctl restart queziva
```

Admins get the new dashboard on their next page load. `index.html` is never cached, while the
hashed script and style files are cached long-term.

## Changing the database schema (developers)

1. Edit `prisma/schema.prisma` and run `npx prisma db push` locally.
2. Run `npm run db:postgres:sync` to regenerate the PostgreSQL schema. A test fails if you forget.
3. Point `DATABASE_URL` at a development PostgreSQL database and run
   `npm run db:postgres:migration -- --name <change>` to create the migration SQL. Review it and
   commit it.
4. On the server, `npm run db:deploy` applies it.

## Backups

Take a daily `pg_dump` (or use the managed database's backups), and keep at least 14 days.
Everything that matters is in the database: orders, history, payments and shipments.
