#!/usr/bin/env python3
"""Fetch latest and trending papers from OpenAlex and write site/data/*.json.

Runs daily in GitHub Actions. Standard library only.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
OUT = ROOT / "site" / "data"
HISTORY_FILE = OUT / "history.json"
API = "https://api.openalex.org/works"
TODAY = dt.date.today()

# OpenAlex fields: 14 = Business, Management and Accounting, 32 = Psychology
FIELDS = CONFIG.get("fields", [14, 32])
SELECT = ",".join([
    "id", "doi", "display_name", "publication_date", "publication_year",
    "authorships", "primary_location", "cited_by_count", "counts_by_year",
    "abstract_inverted_index", "keywords", "open_access", "primary_topic",
])


def mailto() -> str:
    return os.environ.get("OPENALEX_MAILTO") or CONFIG.get("mailto") or ""


def get(params: dict, retries: int = 4) -> dict:
    params = dict(params)
    if mailto():
        params["mailto"] = mailto()
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "paper-radar/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            wait = 2 ** (attempt + 1)
            print(f"  ! {e} — retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"OpenAlex request failed: {url}")


def abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = {}
    for word, idxs in inv.items():
        for i in idxs:
            pos[i] = word
    return " ".join(pos[i] for i in sorted(pos))


def months_since(date_str: str | None) -> float:
    if not date_str:
        return 24.0
    try:
        d = dt.date.fromisoformat(date_str)
    except ValueError:
        return 24.0
    return max((TODAY - d).days / 30.44, 0.0)


def slim(w: dict) -> dict:
    loc = w.get("primary_location") or {}
    src = loc.get("source") or {}
    authors = [
        (a.get("author") or {}).get("display_name")
        for a in (w.get("authorships") or [])
    ]
    authors = [a for a in authors if a]
    oa = w.get("open_access") or {}
    topic = w.get("primary_topic") or {}
    return {
        "id": w["id"].rsplit("/", 1)[-1],
        "title": w.get("display_name") or "",
        "doi": w.get("doi"),
        "url": loc.get("landing_page_url") or w.get("doi") or w["id"],
        "oa_url": oa.get("oa_url"),
        "date": w.get("publication_date"),
        "year": w.get("publication_year"),
        "venue": src.get("display_name"),
        "authors": authors[:8],
        "n_authors": len(authors),
        "cites": w.get("cited_by_count") or 0,
        "cites_by_year": {
            str(c["year"]): c["cited_by_count"] for c in (w.get("counts_by_year") or [])
        },
        "abstract": abstract(w.get("abstract_inverted_index"))[:1800],
        "keywords": [k.get("display_name") for k in (w.get("keywords") or []) if k.get("display_name")][:6],
        "subfield": (topic.get("subfield") or {}).get("display_name"),
    }


def base_filter(since: dt.date, extra: list[str] | None = None) -> str:
    parts = [
        f"from_publication_date:{since.isoformat()}",
        f"to_publication_date:{TODAY.isoformat()}",
        "type:article",
        "primary_topic.field.id:" + "|".join(str(f) for f in FIELDS),
    ]
    return ",".join(parts + (extra or []))


def hot_score(p: dict, history: dict) -> float:
    """Citations per month of age, boosted by citations gained in the last ~30 days."""
    age = months_since(p["date"]) + 3
    velocity = p["cites"] / age ** 1.1
    recent = recent_gain(p, history)
    this_year = p["cites_by_year"].get(str(TODAY.year), 0)
    return round(velocity * 10 + recent * 2 + this_year * 0.5, 2)


def recent_gain(p: dict, history: dict) -> int:
    snaps = history.get(p["id"], {})
    if not snaps:
        return 0
    cutoff = (TODAY - dt.timedelta(days=30)).isoformat()
    older = [d for d in snaps if d <= cutoff]
    base = max(older) if older else min(snaps)
    return max(p["cites"] - snaps[base], 0)


def fetch_topic(t: dict, history: dict) -> dict:
    print(f"- {t['name']}")
    n = CONFIG.get("per_topic", 40)
    latest = get({
        "search": t["query"],
        "filter": base_filter(TODAY - dt.timedelta(days=CONFIG.get("latest_days", 120))),
        "sort": "publication_date:desc",
        "per-page": n,
        "select": SELECT,
    })["results"]
    hot_pool = get({
        "search": t["query"],
        "filter": base_filter(TODAY - dt.timedelta(days=CONFIG.get("hot_window_days", 730))),
        "sort": "cited_by_count:desc",
        "per-page": 100,
        "select": SELECT,
    })["results"]
    trend = get({
        "search": t["query"],
        "filter": ",".join([
            f"publication_year:{TODAY.year - 9}-{TODAY.year}",
            "type:article",
            "primary_topic.field.id:" + "|".join(str(f) for f in FIELDS),
        ]),
        "group_by": "publication_year",
    })["group_by"]

    latest = [slim(w) for w in latest]
    hot = [slim(w) for w in hot_pool]
    for p in hot:
        p["hot"] = hot_score(p, history)
        p["gain30"] = recent_gain(p, history)
    hot.sort(key=lambda p: p["hot"], reverse=True)
    hot = hot[:n]

    kw = Counter(k.lower() for p in latest + hot for k in p["keywords"])
    return {
        "id": t["id"],
        "name": t["name"],
        "en": t.get("en", ""),
        "query": t["query"],
        "latest": latest,
        "hot": hot,
        "trend": sorted(
            ({"year": int(g["key"]), "count": g["count"]} for g in trend),
            key=lambda g: g["year"],
        ),
        "keywords": [{"k": k, "n": c} for k, c in kw.most_common(30)],
    }


def fetch_journals() -> list[dict]:
    print("- 저널 신간")
    journals = CONFIG.get("journals", [])
    if not journals:
        return []
    issns = "|".join(j["issn"] for j in journals)
    res = get({
        "filter": ",".join([
            f"from_publication_date:{(TODAY - dt.timedelta(days=90)).isoformat()}",
            f"to_publication_date:{TODAY.isoformat()}",
            f"primary_location.source.issn:{issns}",
            "type:article",
        ]),
        "sort": "publication_date:desc",
        "per-page": 100,
        "select": SELECT,
    })["results"]
    return [slim(w) for w in res]


def update_history(history: dict, papers: list[dict]) -> dict:
    today = TODAY.isoformat()
    keep_after = (TODAY - dt.timedelta(days=120)).isoformat()
    for p in papers:
        snaps = history.setdefault(p["id"], {})
        snaps[today] = p["cites"]
        for d in [d for d in snaps if d < keep_after]:
            del snaps[d]
    # drop papers we haven't seen in 120 days
    return {k: v for k, v in history.items() if v and max(v) >= keep_after}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    history = json.loads(HISTORY_FILE.read_text()) if HISTORY_FILE.exists() else {}

    topics = []
    for t in CONFIG["topics"]:
        topics.append(fetch_topic(t, history))
        time.sleep(0.5)
    journal_feed = fetch_journals()

    all_papers = [p for t in topics for p in t["hot"] + t["latest"]] + journal_feed
    history = update_history(history, all_papers)

    data = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "site_title": CONFIG.get("site_title", "Paper Radar"),
        "subtitle": CONFIG.get("subtitle", ""),
        "journals": CONFIG.get("journals", []),
        "topics": topics,
        "journal_feed": journal_feed,
    }
    (OUT / "papers.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    HISTORY_FILE.write_text(json.dumps(history, separators=(",", ":")), encoding="utf-8")
    total = len({p["id"] for p in all_papers})
    print(f"done: {total} papers, {len(topics)} topics")


if __name__ == "__main__":
    main()
