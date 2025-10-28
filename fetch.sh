#!/bin/sh
# fetch.sh — KISS backend for Timeguessr
# Requires: curl, jq, ImageMagick (magick or convert)

set -eu
cd "$(dirname "$0")"

# Load auth/env
if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi
: "${COOKIE:?Set COOKIE=... in .env}"    # e.g. 'connect.sid=...; hasSeenAppAd=true'
TZ="${TZ:-UTC}"

# Determine 'today' in the game sense: new game starts at 07:00 UTC.
# Before 07:00 in $TZ, we treat it as the previous day.
hour_now="$(TZ="$TZ" date +%H)"
if [ "$hour_now" -lt 9 ] 2>/dev/null; then
  # Portable-ish yesterday: prefer BSD date (-v), fallback to GNU date (-d)
  if ymd=$(TZ="$TZ" date -v-1d +%F 2>/dev/null); then
    TODAY="$ymd"
  else
    TODAY="$(TZ="$TZ" date -d 'yesterday' +%F)"
  fi
else
  TODAY="$(TZ="$TZ" date +%F)"
fi
OUT_DIR="data/$TODAY"
IMG_DIR="$OUT_DIR/images"
BASE="https://timeguessr.com"
UA="Mozilla/5.0"

mkdir -p "$IMG_DIR"

have_im() {
  if command -v magick >/dev/null 2>&1; then
    echo magick
  elif command -v convert >/dev/null 2>&1; then
    echo convert
  else
    echo "ImageMagick not found (need 'magick' or 'convert')" >&2
    exit 1
  fi
}

fetch_daily() {
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' INT TERM EXIT
  curl -fsSL "$BASE/getDaily" \
    -H "Cookie: $COOKIE" \
    -H "Accept: application/json" \
    -H "Referer: $BASE/dailyroundresults" \
    -H "User-Agent: $UA" \
    -o "$tmp"

  # keep only the 5 objects; ignore trailing username string
  jq 'map(select(type=="object"))' "$tmp" > "$OUT_DIR/photos.json"

  IM="$(have_im)"
  # Download and convert every image to JPEG q80
  jq -r 'map(select(type=="object") | .URL)[]' "$tmp" | while IFS= read -r url; do
    bn="$(basename "$url")"
    id="${bn%.*}"
    dst="$IMG_DIR/$id.jpg"
    timg="$(mktemp)"
    curl -fsSL "$url" -o "$timg"
    "$IM" "$timg" -auto-orient -strip -sampling-factor 4:2:0 -quality 80 "$dst"
    rm -f "$timg"
  done

  rm -f "$tmp"; trap - INT TERM EXIT
  echo "daily -> $OUT_DIR/photos.json and images/"
}

fetch_friends() {
  curl -fsSL "$BASE/getFriendshipLeaderboard" \
    -H "Cookie: $COOKIE" \
    -H "Accept: application/json" \
    -H "Referer: $BASE/finalscoredaily" \
    -H "User-Agent: $UA" \
    | jq '.' > "$OUT_DIR/leaderboard.json"
  echo "friends -> $OUT_DIR/leaderboard.json"
}

update_index() {
  # Build data/index.json as an array of available YYYY-MM-DD directories (portable)
  if [ -d data ]; then
    dates=$(find data -mindepth 1 -maxdepth 1 -type d -print \
      | sed 's|.*/||' \
      | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
      | sort)
    count=$(printf '%s\n' "$dates" | grep -c . || true)
    printf '%s\n' "$dates" | jq -R -s 'split("\n") | map(select(length>0))' > data/index.json
    echo "index -> data/index.json ($count dates)"
  fi
}

update_users() {
  # Build data/users.json as a sorted unique list of usernames across all days
  if [ -d data ]; then
    set +e
    names=$(jq -r '(.friendData // .friends // .entries // .scores // [])[] | (.username // .name // .user.name // .playerName) | select(.)' data/*/leaderboard.json 2>/dev/null | sort -u)
    set -e
    if [ -n "$names" ]; then
      printf '%s\n' "$names" | jq -R -s 'split("\n") | map(select(length>0))' > data/users.json
      echo "users -> data/users.json ($(printf '%s\n' "$names" | grep -c . || true) users)"
    fi
  fi
}

case "${1:-both}" in
  daily)   fetch_daily; update_index; update_users ;;
  friends) fetch_friends; update_index; update_users ;;
  both)    fetch_daily; fetch_friends; update_index; update_users ;;
  *)       echo "usage: $0 [daily|friends|both]" >&2; exit 2 ;;
esac
