#!/usr/bin/env bash
# deps: bash, curl, jq, gzip, ImageMagick
set -euo pipefail
. "$(dirname "$0")/.env"

BASE="https://timeguessr.com"
UA="Mozilla/5.0"
DATA_DIR="${TG_DATA_DIR}"
mkdir -p "$DATA_DIR/daily" "$DATA_DIR/friends"

# require ImageMagick
if command -v magick >/dev/null 2>&1; then IMCMD="magick"
elif command -v convert >/dev/null 2>&1; then IMCMD="convert"
else
  echo "ImageMagick not installed." >&2
  exit 1
fi

curl_json() {
  curl -fsS --compressed \
    -H "Accept: application/json" \
    -H "User-Agent: $UA" \
    -H "Cookie: $TG_COOKIE" \
    "$1"
}

pull_daily() {
  local resp daily_no day_iso date_dir
  resp="$(curl_json "$BASE/getDaily")"
  daily_no="$(jq -r '[.[]|objects|.No][0]' <<<"$resp")"
  [[ "$daily_no" != "null" ]] || { echo "daily_no missing"; return 2; }

  day_iso="$(TZ="${TZ:-Europe/Rome}" date +%F)"
  date_dir="$DATA_DIR/daily/$day_iso"
  mkdir -p "$date_dir/images"

  # store JSON
  if [[ ! -f "$date_dir/no-$daily_no.json.gz" ]]; then
    printf "%s" "$resp" | gzip -c > "$date_dir/no-$daily_no.json.gz"
  fi

  # download + transcode images to jpg@80
  mapfile -t urls < <(jq -r '.[]|objects|.URL' <<<"$resp")
  for u in "${urls[@]}"; do
    base="$(basename "$u")"
    dst="$date_dir/images/${base%.*}.jpg"
    [[ -f "$dst" ]] && continue
    tmp="$date_dir/images/.dl.$$.$RANDOM"
    curl -fsS --retry 3 -L -o "$tmp" "$u"
    $IMCMD "$tmp" -auto-orient -strip -background white -alpha remove -alpha off \
      -colorspace sRGB -sampling-factor 4:2:0 -quality 80 "$dst.tmp"
    mv "$dst.tmp" "$dst"
    rm -f "$tmp"
  done

  echo "daily $day_iso no-$daily_no ($((${#urls[@]})) images → jpg@80)"
}

pull_friends() {
  local day_iso; day_iso="$(TZ="${TZ:-Europe/Rome}" date +%F)"
  curl_json "$BASE/getFriendshipLeaderboard" \
    | jq -c '{day:"'"$day_iso"'",friendData:.friendData}' \
    | gzip -c > "$DATA_DIR/friends/$day_iso.json.gz"
  echo "friends $day_iso saved"
}

mode="${1:-both}" # daily|friends|both
case "$mode" in
  daily)   pull_daily   ;;
  friends) pull_friends ;;
  both)    pull_daily; pull_friends ;;
  *) echo "usage: $0 [daily|friends|both]"; exit 1 ;;
esac

