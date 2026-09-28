#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?release id is required}"
production_url="${2:?production URL is required}"
deploy_root=/opt/queziva
release_dir="$deploy_root/releases/$release_id"
archive="/tmp/queziva-$release_id.tgz"

if [[ ! "$release_id" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Release id must be a full Git commit SHA.' >&2
  exit 2
fi

if [[ ! -f "$deploy_root/shared/.env" ]]; then
  echo "$deploy_root/shared/.env is missing; complete the VPS bootstrap first." >&2
  exit 2
fi

mkdir -p "$release_dir"
tar -xzf "$archive" -C "$release_dir"
ln -sfn "$deploy_root/shared/.env" "$release_dir/.env"

cd "$release_dir"
npm ci
npm run build:prod
npm run db:deploy

ln -sfn "$release_dir" "$deploy_root/current.next"
mv -Tf "$deploy_root/current.next" "$deploy_root/current"
sudo -n systemctl restart queziva

for attempt in {1..12}; do
  if curl --fail --silent --show-error --max-time 10 "${production_url%/}/health" >/dev/null; then
    rm -f "$archive"
    echo "Release $release_id is healthy."
    exit 0
  fi
  sleep 5
done

echo 'Deployment completed, but the public health check did not recover.' >&2
sudo -n systemctl status queziva --no-pager || true
exit 1
