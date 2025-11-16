#!/usr/bin/env python3
"""Build a single aggregated all-time leaderboard snapshot.

The script walks every dated folder in ./data (or the list from data/index.json),
loads each day's leaderboard.json, aggregates totals per user, and writes a
compact data/alltime.json file that the website can load in a single request.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
INDEX_FILE = DATA_DIR / "index.json"
OUTPUT_FILE = DATA_DIR / "alltime.json"
DEFAULT_MAX_USERS = 10


@dataclass
class UserAggregate:
    username: str
    per_day: Dict[str, int] = field(default_factory=dict)
    total: int = 0

    def add_score(self, date: str, score: int) -> None:
        if score is None:
            return
        current = self.per_day.get(date, 0)
        new_value = current + int(score)
        self.per_day[date] = new_value
        self.total += int(score)

    @property
    def days(self) -> int:
        return sum(1 for value in self.per_day.values() if value)


def load_dates() -> List[str]:
    if INDEX_FILE.exists():
        with INDEX_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "dates" in data:
            dates = data["dates"]
        else:
            dates = data
    else:
        dates = [p.name for p in DATA_DIR.iterdir() if p.is_dir()]
    normalized = sorted(str(d).strip() for d in dates if isinstance(d, str))
    return [d for d in normalized if d]


def load_day(date: str) -> List[Dict[str, int]]:
    path = DATA_DIR / date / "leaderboard.json"
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except json.JSONDecodeError as exc:
        print(f"Warning: could not parse {path}: {exc}", file=sys.stderr)
        return []
    rows = raw.get("friendData") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        return []
    cleaned = []
    for entry in rows:
        if not isinstance(entry, dict):
            continue
        username = str(entry.get("username") or "").strip()
        if not username:
            continue
        try:
            score = int(entry.get("score") or 0)
        except (TypeError, ValueError):
            score = 0
        cleaned.append({"username": username, "score": score})
    return cleaned


def build_user_map(dates: Iterable[str]) -> Dict[str, UserAggregate]:
    users: Dict[str, UserAggregate] = {}
    total_days = 0
    for date in dates:
        total_days += 1
        for row in load_day(date):
            username = row["username"]
            score = row["score"]
            agg = users.setdefault(username, UserAggregate(username=username))
            agg.add_score(date, score)
    return users


def rank_users(users: Dict[str, UserAggregate]) -> List[Dict[str, object]]:
    ordered = sorted(users.values(), key=lambda u: (-u.total, u.username.lower()))
    ranked: List[Dict[str, object]] = []
    rank = 0
    prev_total = None
    for idx, user in enumerate(ordered):
        if prev_total is None or user.total != prev_total:
            rank = idx + 1
            prev_total = user.total
        ranked.append({
            "username": user.username,
            "total": user.total,
            "days": sum(1 for value in user.per_day.values() if value > 0),
            "rank": rank,
        })
    return ranked


def hydrate_user(user: UserAggregate, dates: List[str]) -> Dict[str, object]:
    per_day = user.per_day
    daily_totals: List[int] = []
    daily_scores: List[int | None] = []
    cumulative: List[int] = []
    mean_series: List[float | None] = []
    acc = 0
    played = 0
    first_play_index = -1

    for idx, date in enumerate(dates):
        value = per_day.get(date, 0)
        daily_totals.append(value)
        if date in per_day:
            daily_scores.append(value)
            if first_play_index == -1:
                first_play_index = idx
            played += 1
        else:
            daily_scores.append(None)
        acc += value
        cumulative.append(acc)
        mean_series.append(acc / played if played else None)

    return {
        "username": user.username,
        "total": user.total,
        "days": sum(1 for value in per_day.values() if value > 0),
        "rank": None,  # rank is derived from the users list
        "dailyTotals": daily_totals,
        "dailyScores": daily_scores,
        "cumulative": cumulative,
        "meanSeries": mean_series,
        "firstPlayIndex": first_play_index,
    }


def build_report(dates: List[str], max_users: int) -> Dict[str, object]:
    user_map = build_user_map(dates)
    ranked_users = rank_users(user_map)
    top_usernames = {entry["username"] for entry in ranked_users[:max_users]}
    top_users = []
    for entry in ranked_users:
        if entry["username"] not in top_usernames:
            continue
        agg = user_map[entry["username"]]
        hydrated = hydrate_user(agg, dates)
        hydrated["rank"] = entry["rank"]
        top_users.append(hydrated)
        if len(top_users) >= max_users:
            break

    return {
        "dates": dates,
        "users": ranked_users,
        "topUsers": top_users,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "maxUsers": max_users,
    }


def write_json(data: Dict[str, object], path: Path, pretty: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        if pretty:
            json.dump(data, fh, indent=2, sort_keys=False)
        else:
            json.dump(data, fh, separators=(",", ":"))
    print(f"Wrote {path} ({path.stat().st_size} bytes)")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Aggregate daily leaderboards")
    parser.add_argument("--max-users", type=int, default=DEFAULT_MAX_USERS,
                        help="How many top users to include with time-series data (default: 10)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    return parser.parse_args(argv)


def main(argv: List[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    dates = load_dates()
    if not dates:
        print("No dates found in data directory", file=sys.stderr)
        return 1
    report = build_report(dates, max_users=max(1, args.max_users))
    write_json(report, OUTPUT_FILE, pretty=args.pretty)
    print(f"Aggregated {len(report['dates'])} days, {len(report['users'])} users")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
