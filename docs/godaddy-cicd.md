# GoDaddy VPS CI/CD

This deployment requires a Linux **GoDaddy VPS**, not shared/cPanel hosting. The application runs
a persistent Node process, PostgreSQL migrations and background jobs.

## 1. DNS and server prerequisites

Create an A record such as `orders` pointing to the VPS public IPv4 address. Install Node.js 20+,
PostgreSQL 14+, nginx, Certbot, Git, curl and build tools on the VPS. Complete the PostgreSQL,
nginx and TLS setup in [deployment.md](deployment.md).

Create a non-root deployment user and directories:

```bash
sudo adduser deploy
sudo install -d -o deploy -g deploy /opt/queziva/releases /opt/queziva/shared
sudo -u deploy nano /opt/queziva/shared/.env
```

Keep all production credentials only in `/opt/queziva/shared/.env`. Never store the application
`.env` in GitHub Actions.

Install the GitHub Actions public key in `/home/deploy/.ssh/authorized_keys`. Give that user only
the service restart permission it needs:

```bash
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart queziva, /usr/bin/systemctl status queziva --no-pager' | sudo tee /etc/sudoers.d/queziva-deploy
sudo chmod 440 /etc/sudoers.d/queziva-deploy
```

Update the systemd unit from [deployment.md](deployment.md) to use:

```ini
WorkingDirectory=/opt/queziva/current
ExecStart=/usr/bin/node /opt/queziva/current/dist/index.js
EnvironmentFile=/opt/queziva/shared/.env
```

The first deployment creates the `current` symlink. Start or enable the service after that first
deployment if it has not existed before.

## 2. GitHub production environment

In the GitHub repository, create an environment named `production`. Restrict it to the `main`
branch and optionally require an approving reviewer.

Add this environment variable:

| Variable | Example |
|---|---|
| `PRODUCTION_URL` | `https://orders.example.com` |

Add these environment secrets:

| Secret | Value |
|---|---|
| `GODADDY_VPS_HOST` | VPS hostname or IPv4 address |
| `GODADDY_VPS_PORT` | SSH port, normally `22` |
| `GODADDY_VPS_USER` | `deploy` |
| `GODADDY_VPS_SSH_PRIVATE_KEY` | Private Ed25519 deployment key |
| `GODADDY_VPS_KNOWN_HOSTS` | Output of `ssh-keyscan -H <host>` verified against the VPS fingerprint |

## 3. Pipeline behavior

`.github/workflows/ci.yml` validates every push and pull request. A push to `main` also runs
`.github/workflows/deploy-godaddy.yml`, which validates again and then:

1. uploads a source archive without `.env`, database files or build output;
2. installs exact lockfile dependencies in an immutable release directory;
3. builds with the PostgreSQL Prisma client;
4. applies committed migrations;
5. atomically moves `/opt/queziva/current` to the new release;
6. restarts `queziva` and checks the public `/health` endpoint.

Releases are retained for manual rollback. To roll back application code, point `current` at a
previous release and restart the service. Database migrations must remain backward-compatible;
the pipeline does not automatically reverse migrations.
