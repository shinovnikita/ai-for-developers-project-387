#!/usr/bin/env bash
set -euo pipefail

image=call-calendar:smoke
docker build --tag "$image" .

directory=$(mktemp -d)
container=
cleanup() {
  if [[ -n "$container" ]]; then
    if [[ "$1" != 0 ]]; then
      docker logs "$container" >&2 || true
    fi
    docker rm --force "$container" >/dev/null
  fi
  rm -rf "$directory"
}
trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port=8080
container=$(docker run --detach --env "PORT=$port" --publish "127.0.0.1::$port" "$image")
origin="http://$(docker port "$container" "$port/tcp")"

get_status() {
  curl --noproxy '*' --silent --show-error --max-time 2 \
    --output "$2" --write-out '%{http_code}' "$origin$1"
}

for ((attempt = 0; attempt < 30; attempt++)); do
  health_status=$(get_status /health "$directory/health.json" 2>/dev/null) || true
  if [[ "$health_status" == 200 ]]; then
    break
  fi
  sleep 1
done
if [[ "$health_status" != 200 ]] || ! jq -e '.status == "ok"' "$directory/health.json" >/dev/null; then
  echo 'GET /health did not return HTTP 200 with status "ok"' >&2
  exit 1
fi

for route in /booking /owner; do
  page="$directory${route}.html"
  status=$(get_status "$route" "$page")
  if [[ "$status" != 200 ]]; then
    echo "GET $route returned HTTP $status" >&2
    exit 1
  fi
  script=$(sed -n 's|.*<script [^>]*src="\(/assets/[^"]*\.js\)".*|\1|p' "$page")
  if [[ -z "$script" || "$(get_status "$script" "$directory/frontend.js")" != 200 || ! -s "$directory/frontend.js" ]]; then
    echo "GET $route did not serve the built application and its JavaScript" >&2
    exit 1
  fi
done

echo "Docker smoke test passed for /health, /booking and /owner on container port $port"
