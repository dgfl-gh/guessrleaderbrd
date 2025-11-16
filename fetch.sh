#!/bin/sh
# fetch.sh — KISS backend for Timeguessr
# Requires: curl, jq, ImageMagick (magick or convert)
# Run with 'today' (or 'status') to inspect the computed game day without fetching.

set -eu
cd "$(dirname "$0")"

# Load auth/env
if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi
: "${COOKIE:?Set COOKIE=... in .env}"    # e.g. 'connect.sid=...; hasSeenAppAd=true'
LOCAL_TZ="${LOCAL_TZ:-${TZ:-UTC}}"
GAME_TZ="${GAME_TZ:-America/New_York}"
ROLLOVER_HOUR="${ROLLOVER_HOUR:-2}"
# Author confirmed the challenge resets at 02:00 EST (i.e., America/New_York).
# During daylight saving time this clocks in at 03:00 local (EDT) automatically.
# Override GAME_TZ/ROLLOVER_HOUR in .env if their schedule changes.

# Determine 'today' in the game sense: new game starts at $ROLLOVER_HOUR:00 in $GAME_TZ.
# Before that rollover we treat it as the previous day to match Timeguessr's schedule.
hour_now="$(TZ="$GAME_TZ" date +%H)"
if [ "$hour_now" -lt "$ROLLOVER_HOUR" ] 2>/dev/null; then
  # Portable-ish yesterday: prefer BSD date (-v), fallback to GNU date (-d)
  if ymd=$(TZ="$GAME_TZ" date -v-1d +%F 2>/dev/null); then
    TODAY="$ymd"
  else
    TODAY="$(TZ="$GAME_TZ" date -d 'yesterday' +%F)"
  fi
else
  TODAY="$(TZ="$GAME_TZ" date +%F)"
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

aggregate_data() {
  python3 aggregate-data.py
}

echo_datetime() {
  echo "local date ($LOCAL_TZ): $(TZ="$LOCAL_TZ" date)"
}

format_epoch_for_tz() {
  tz="$1"
  epoch="$2"
  if out=$(TZ="$tz" date -d "@$epoch" 2>/dev/null); then
    printf '%s' "$out"
  else
    TZ="$tz" date -r "$epoch" 2>/dev/null
  fi
}

next_rollover_epoch() {
  hour_now="$(TZ="$GAME_TZ" date +%H)"
  if [ "$hour_now" -lt "$ROLLOVER_HOUR" ] 2>/dev/null; then
    next_date="$(TZ="$GAME_TZ" date +%F)"
  else
    if nd=$(TZ="$GAME_TZ" date -v+1d +%F 2>/dev/null); then
      next_date="$nd"
    else
      next_date="$(TZ="$GAME_TZ" date -d 'tomorrow' +%F)"
    fi
  fi
  dt=$(printf '%s %02d:00:00' "$next_date" "$ROLLOVER_HOUR")
  if epoch=$(TZ="$GAME_TZ" date -d "$dt" +%s 2>/dev/null); then
    printf '%s' "$epoch"
    return 0
  elif epoch=$(TZ="$GAME_TZ" date -j -f "%Y-%m-%d %H:%M:%S" "$dt" +%s 2>/dev/null); then
    printf '%s' "$epoch"
    return 0
  fi
  return 1
}

show_today() {
  echo_datetime
  echo "game tz ($GAME_TZ): $(TZ="$GAME_TZ" date)"
  printf 'rollover hour (game tz): %02d:00\n' "$ROLLOVER_HOUR"
  if next_epoch=$(next_rollover_epoch); then
    now_epoch=$(date +%s)
    if [ "$next_epoch" -lt "$now_epoch" ]; then
      next_epoch="$now_epoch"
    fi
    seconds_left=$((next_epoch - now_epoch))
    if [ "$seconds_left" -lt 0 ]; then
      seconds_left=0
    fi
    hours_left=$((seconds_left / 3600))
    mins_left=$(((seconds_left % 3600) / 60))
    secs_left=$((seconds_left % 60))
    rollover_game="$(format_epoch_for_tz "$GAME_TZ" "$next_epoch")"
    rollover_local="$(format_epoch_for_tz "$LOCAL_TZ" "$next_epoch")"
    echo "next rollover (game tz): $rollover_game"
    echo "next rollover (local tz): $rollover_local"
    printf 'countdown: %02dh %02dm %02ds (%s seconds)\n' "$hours_left" "$mins_left" "$secs_left" "$seconds_left"
  else
    echo "next rollover: unable to compute (need GNU date -d or BSD date -j)"
  fi
  echo "computed TODAY: $TODAY"
}

case "${1:-both}" in
	daily)   echo_datetime; fetch_daily; update_index; update_users; aggregate_data ;;
        friends) echo_datetime; fetch_friends; update_index; update_users; aggregate_data ;;
        both)    echo_datetime; fetch_daily; fetch_friends; update_index; update_users; aggregate_data ;;
        today|status|inspect)
                  show_today ;;
          *)       echo "usage: $0 [daily|friends|both|today|status|inspect]" >&2; exit 2 ;;
esac
