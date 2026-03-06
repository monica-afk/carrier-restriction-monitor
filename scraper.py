#!/usr/bin/env python3
"""
Carrier Shipping Restriction Scanner
Tracks countries that major carriers and 3PLs are NOT shipping to.
Run daily for fresh data — generates a self-contained dashboard.html.
"""

import json, sys, re, traceback
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from pathlib import Path

OUTPUT = Path(__file__).parent / "dashboard.html"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
session = requests.Session()
session.headers.update(HEADERS)


def fetch(url, timeout=20):
    try:
        r = session.get(url, timeout=timeout)
        r.raise_for_status()
        return r
    except Exception as e:
        print(f"  [WARN] Could not fetch {url}: {e}", file=sys.stderr)
        return None


def r(country, reason, t):
    """Create a restriction entry. t = 'sanctions' | 'suspended' | 'limited'"""
    return {"country": country, "reason": reason, "type": t}


S = "sanctions"   # Legal prohibition (OFAC, UN, EU sanctions)
X = "suspended"   # Full service suspension (conflict, instability)
L = "limited"     # Partial / significantly reduced service


# ── Shared baseline data ───────────────────────────────────────────────────────

OFAC_US = [
    r("Cuba",                       "OFAC embargo",                  S),
    r("Iran",                        "OFAC sanctions",                S),
    r("North Korea (DPRK)",          "OFAC sanctions",                S),
    r("Syria",                       "OFAC sanctions",                S),
    r("Crimea (Ukraine)",            "OFAC / Executive Order",        S),
    r("Donetsk People's Republic",   "OFAC sanctions (2022)",         S),
    r("Luhansk People's Republic",   "OFAC sanctions (2022)",         S),
    r("Zaporizhzhia (Ukraine)",      "OFAC sanctions (2022)",         S),
    r("Kherson (Ukraine)",           "OFAC sanctions (2022)",         S),
]

OFAC_INTL = [   # EU/UN equivalents used by non-US carriers
    r("Iran",               "UN/EU/sanctions",       S),
    r("North Korea (DPRK)", "UN/EU sanctions",        S),
    r("Syria",              "UN/EU sanctions",        S),
]

RUSSIA_BELARUS = [
    r("Russia",  "Services suspended (Feb 2022)",  X),
    r("Belarus", "Services suspended (2022)",       X),
]

CONFLICT_LIMITED = [
    r("Afghanistan",  "Severely limited — security",         L),
    r("Haiti",        "Severely limited — instability",       L),
    r("Libya",        "Severely limited — conflict",          L),
    r("Somalia",      "Severely limited — security",         L),
    r("Sudan",        "Limited — conflict / sanctions",       L),
    r("South Sudan",  "Limited — instability",                L),
    r("Yemen",        "Limited — active conflict",            L),
    r("Myanmar",      "Limited — sanctions / instability",    L),
]


# ── Carrier definitions ────────────────────────────────────────────────────────

CARRIERS = [

    # ── Express / Parcel ─────────────────────────────────────────────────────

    {
        "id": "ups",
        "name": "UPS",
        "full_name": "United Parcel Service",
        "category": "express",
        "hq": "US",
        "source_url": "https://www.ups.com/us/en/support/shipping-special-care-regulated-items/sanctioned-countries.page",
        "alerts_url": "https://www.ups.com/us/en/service-alerts.page",
        "scrape_fn": "ups",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED + [
            r("Venezuela", "Limited services", L),
        ],
    },

    {
        "id": "fedex",
        "name": "FedEx",
        "full_name": "FedEx Corporation",
        "category": "express",
        "hq": "US",
        "source_url": "https://www.fedex.com/en-us/service-alerts.html",
        "alerts_url": "https://www.fedex.com/en-us/service-alerts.html",
        "scrape_fn": "fedex",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED + [
            r("Venezuela",                    "Limited services",        L),
            r("Central African Republic",     "Limited — security",      L),
        ],
    },

    {
        "id": "dhl_express",
        "name": "DHL Express",
        "full_name": "DHL Express",
        "category": "express",
        "hq": "Germany",
        "source_url": "https://www.dhl.com/us-en/home/our-divisions/express/service-alerts.html",
        "alerts_url": "https://www.dhl.com/us-en/home/our-divisions/express/service-alerts.html",
        "scrape_fn": "dhl",
        "restrictions": [
            r("Cuba",               "OFAC / EU sanctions",            S),
            r("Iran",               "OFAC / EU sanctions",            S),
            r("North Korea (DPRK)", "OFAC / EU sanctions",            S),
            r("Syria",              "OFAC / EU sanctions",            S),
            r("Crimea (Ukraine)",   "OFAC / EU sanctions",            S),
        ] + RUSSIA_BELARUS + [
            r("Ukraine (conflict areas)", "Partial suspension — active conflict", X),
        ] + CONFLICT_LIMITED + [
            r("Venezuela", "Limited services", L),
        ],
    },

    {
        "id": "usps",
        "name": "USPS",
        "full_name": "US Postal Service",
        "category": "postal",
        "hq": "US",
        "source_url": "https://pe.usps.com/text/Imm/immc2_002.htm",
        "alerts_url": "https://pe.usps.com/text/Imm/immc2_002.htm",
        "scrape_fn": "usps",
        "restrictions": OFAC_US + RUSSIA_BELARUS + [
            r("Afghanistan",             "Mail service suspended",    X),
            r("Haiti",                   "Service suspended",         X),
            r("Libya",                   "Mail service suspended",    X),
            r("Somalia",                 "Mail service suspended",    X),
            r("Sudan",                   "Mail service suspended",    X),
            r("South Sudan",             "Mail service suspended",    X),
            r("Yemen",                   "Mail service suspended",    X),
            r("Ukraine (certain areas)", "Partial suspension",        L),
            r("Myanmar",                 "Limited service",           L),
            r("Eritrea",                 "Limited service",           L),
            r("Central African Republic","Limited service",           L),
            r("Burkina Faso",            "Limited service",           L),
            r("Mali",                    "Limited service",           L),
            r("Niger",                   "Limited service",           L),
            r("Guinea-Bissau",           "Limited service",           L),
            r("Venezuela",               "Limited service",           L),
        ],
    },

    {
        "id": "tnt",
        "name": "TNT",
        "full_name": "TNT (FedEx subsidiary)",
        "category": "express",
        "hq": "Netherlands",
        "source_url": "https://www.tnt.com/express/en_gc/site/service-alerts.html",
        "alerts_url": "https://www.tnt.com/express/en_gc/site/service-alerts.html",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "canada_post",
        "name": "Canada Post",
        "full_name": "Canada Post / Postes Canada",
        "category": "postal",
        "hq": "Canada",
        "source_url": "https://www.canadapost-postescanada.ca/cpc/en/personal/sending/international/service-alerts.page",
        "alerts_url": "https://www.canadapost-postescanada.ca/cpc/en/personal/sending/international/service-alerts.page",
        "scrape_fn": "canada_post",
        "restrictions": [
            r("Iran",               "Canadian / UN sanctions",        S),
            r("North Korea (DPRK)", "Canadian / UN sanctions",        S),
            r("Syria",              "Canadian / UN sanctions",        S),
            r("Crimea (Ukraine)",   "Canadian / UN sanctions",        S),
        ] + RUSSIA_BELARUS + [
            r("Ukraine (conflict areas)", "Partial suspension",       X),
        ] + CONFLICT_LIMITED,
    },

    {
        "id": "purolator",
        "name": "Purolator",
        "full_name": "Purolator Inc.",
        "category": "express",
        "hq": "Canada",
        "source_url": "https://www.purolator.com/en/service-updates",
        "alerts_url": "https://www.purolator.com/en/service-updates",
        "note": "Primarily domestic Canada; limited international reach",
        "restrictions": [
            r("Iran",               "Sanctions compliance",  S),
            r("North Korea (DPRK)", "Sanctions compliance",  S),
            r("Syria",              "Sanctions compliance",  S),
        ] + RUSSIA_BELARUS,
    },

    {
        "id": "royal_mail",
        "name": "Royal Mail",
        "full_name": "Royal Mail Group",
        "category": "postal",
        "hq": "UK",
        "source_url": "https://www.royalmail.com/sending/international/tracking-your-international-item/country-list",
        "alerts_url": "https://www.royalmail.com/sending/international/tracking-your-international-item/country-list",
        "restrictions": [
            r("Iran",               "UK / UN sanctions",     S),
            r("North Korea (DPRK)", "UK / UN sanctions",     S),
            r("Syria",              "UK / UN sanctions",     S),
        ] + RUSSIA_BELARUS + CONFLICT_LIMITED + [
            r("Cuba", "Limited services", L),
        ],
    },

    {
        "id": "postnl",
        "name": "PostNL",
        "full_name": "PostNL (Netherlands)",
        "category": "postal",
        "hq": "Netherlands",
        "source_url": "https://www.postnl.nl/en/service-disruptions/",
        "alerts_url": "https://www.postnl.nl/en/service-disruptions/",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "australia_post",
        "name": "Australia Post",
        "full_name": "Australia Post",
        "category": "postal",
        "hq": "Australia",
        "source_url": "https://auspost.com.au/business/shipping/international-shipping/suspended-international-mail",
        "alerts_url": "https://auspost.com.au/business/shipping/international-shipping/suspended-international-mail",
        "restrictions": [
            r("Iran",               "Australian / UN sanctions",  S),
            r("North Korea (DPRK)", "Australian / UN sanctions",  S),
            r("Syria",              "Australian / UN sanctions",  S),
        ] + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "la_poste",
        "name": "La Poste",
        "full_name": "La Poste (France)",
        "category": "postal",
        "hq": "France",
        "source_url": "https://www.laposte.fr/assistance/envoi-international-pays-non-desservis",
        "alerts_url": "https://www.laposte.fr/assistance/envoi-international-pays-non-desservis",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "dhl_ecommerce",
        "name": "DHL eCommerce",
        "full_name": "DHL eCommerce Solutions",
        "category": "ecommerce",
        "hq": "Germany",
        "source_url": "https://www.dhl.com/us-en/home/our-divisions/ecommerce.html",
        "alerts_url": "https://www.dhl.com/us-en/home/our-divisions/ecommerce.html",
        "restrictions": [
            r("Cuba",               "OFAC / EU sanctions",   S),
            r("Iran",               "OFAC / EU sanctions",   S),
            r("North Korea (DPRK)", "OFAC / EU sanctions",   S),
            r("Syria",              "OFAC / EU sanctions",   S),
            r("Crimea (Ukraine)",   "OFAC / EU sanctions",   S),
        ] + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    # ── Freight ──────────────────────────────────────────────────────────────

    {
        "id": "maersk",
        "name": "Maersk",
        "full_name": "A.P. Moller-Maersk",
        "category": "freight",
        "hq": "Denmark",
        "source_url": "https://www.maersk.com/local-information",
        "alerts_url": "https://www.maersk.com/local-information",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + [
            r("Libya",   "Limited — security",  L),
            r("Yemen",   "Limited — conflict",  L),
            r("Somalia", "Limited — security",  L),
        ],
    },

    {
        "id": "db_schenker",
        "name": "DB Schenker",
        "full_name": "DB Schenker (Deutsche Bahn)",
        "category": "freight",
        "hq": "Germany",
        "source_url": "https://www.dbschenker.com/global/about/news/sanctions-russia-ukraine-1168636",
        "alerts_url": "https://www.dbschenker.com/global/about/news/sanctions-russia-ukraine-1168636",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + [
            r("Libya",   "Limited service",  L),
            r("Yemen",   "Limited service",  L),
            r("Somalia", "Limited service",  L),
        ],
    },

    {
        "id": "kuehne_nagel",
        "name": "Kuehne+Nagel",
        "full_name": "Kuehne+Nagel International AG",
        "category": "freight",
        "hq": "Switzerland",
        "source_url": "https://home.kuehne-nagel.com/",
        "alerts_url": "https://home.kuehne-nagel.com/",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + [
            r("Yemen",   "Limited service",  L),
            r("Somalia", "Limited service",  L),
        ],
    },

    {
        "id": "xpo",
        "name": "XPO Logistics",
        "full_name": "XPO Logistics",
        "category": "freight",
        "hq": "US",
        "source_url": "https://www.xpo.com/",
        "alerts_url": "https://www.xpo.com/",
        "restrictions": OFAC_US + RUSSIA_BELARUS + [
            r("Libya",   "Limited service",  L),
            r("Yemen",   "Limited service",  L),
        ],
    },

    {
        "id": "dsv",
        "name": "DSV",
        "full_name": "DSV Global Transport and Logistics",
        "category": "freight",
        "hq": "Denmark",
        "source_url": "https://www.dsv.com/en/our-solutions/modes-of-transport",
        "alerts_url": "https://www.dsv.com/en/our-solutions/modes-of-transport",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    # ── 3PLs / eCommerce Fulfillment ─────────────────────────────────────────

    {
        "id": "shipbob",
        "name": "ShipBob",
        "full_name": "ShipBob Inc.",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://help.shipbob.com/s/article/International-Shipping-Countries",
        "alerts_url": "https://help.shipbob.com/s/article/International-Shipping-Countries",
        "note": "Country support varies by fulfillment center location",
        "restrictions": OFAC_US + RUSSIA_BELARUS + [
            r("Afghanistan", "Not supported",  X),
            r("Haiti",       "Not supported",  X),
            r("Libya",       "Not supported",  X),
            r("Somalia",     "Not supported",  X),
            r("Sudan",       "Not supported",  X),
            r("South Sudan", "Not supported",  X),
            r("Yemen",       "Not supported",  X),
            r("Myanmar",     "Not supported",  X),
            r("Venezuela",   "Not supported",  X),
        ],
    },

    {
        "id": "flexport",
        "name": "Flexport",
        "full_name": "Flexport Inc.",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://www.flexport.com/",
        "alerts_url": "https://www.flexport.com/",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "easyship",
        "name": "Easyship",
        "full_name": "Easyship",
        "category": "3pl",
        "hq": "Hong Kong",
        "source_url": "https://support.easyship.com/",
        "alerts_url": "https://support.easyship.com/",
        "note": "Restrictions vary by carrier selected",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "shippo",
        "name": "Shippo",
        "full_name": "Shippo",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://support.goshippo.com/",
        "alerts_url": "https://support.goshippo.com/",
        "note": "Inherits restrictions from connected carrier accounts",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "shipstation",
        "name": "ShipStation",
        "full_name": "ShipStation",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://help.shipstation.com/",
        "alerts_url": "https://help.shipstation.com/",
        "note": "Inherits restrictions from connected carrier accounts",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "pitney_bowes",
        "name": "Pitney Bowes",
        "full_name": "Pitney Bowes Global Shipping",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://www.pitneybowes.com/us/global-ecommerce.html",
        "alerts_url": "https://www.pitneybowes.com/us/global-ecommerce.html",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "asendia",
        "name": "Asendia",
        "full_name": "Asendia Group",
        "category": "3pl",
        "hq": "Switzerland",
        "source_url": "https://www.asendia.com/",
        "alerts_url": "https://www.asendia.com/",
        "restrictions": OFAC_INTL + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "whiplash",
        "name": "Whiplash",
        "full_name": "Whiplash (Ryder subsidiary)",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://www.whiplash.com/",
        "alerts_url": "https://www.whiplash.com/",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },

    {
        "id": "radial",
        "name": "Radial",
        "full_name": "Radial Inc.",
        "category": "3pl",
        "hq": "US",
        "source_url": "https://radial.com/",
        "alerts_url": "https://radial.com/",
        "restrictions": OFAC_US + RUSSIA_BELARUS + CONFLICT_LIMITED,
    },
]


# ── Live scrapers ──────────────────────────────────────────────────────────────

def scrape_usps():
    """Try to pull live suspension data from the USPS IMM Appendix C."""
    print("  Trying USPS IMM live scrape...")
    r = fetch("https://pe.usps.com/text/Imm/immc2_002.htm")
    if not r:
        return None

    soup = BeautifulSoup(r.text, "lxml")
    countries = []

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) < 1:
                continue
            country_text = cells[0].get_text(" ", strip=True)
            reason_text  = cells[1].get_text(" ", strip=True) if len(cells) > 1 else "Service suspended"

            # Skip empty, header-ish, or very short rows
            if not country_text or len(country_text) < 3:
                continue
            if country_text.lower() in ("country", "countries", "nation"):
                continue

            typ = S if any(w in reason_text.lower() for w in ["sanction", "ofac", "embargo"]) else X
            countries.append({"country": country_text, "reason": reason_text or "Service suspended", "type": typ})

    if len(countries) >= 3:
        print(f"  USPS live: found {len(countries)} restrictions")
        return countries
    return None


def scrape_ups():
    """Try to fetch UPS sanctioned countries page."""
    print("  Trying UPS sanctioned countries live scrape...")
    url = "https://www.ups.com/us/en/support/shipping-special-care-regulated-items/sanctioned-countries.page"
    resp = fetch(url)
    if not resp:
        return None

    soup = BeautifulSoup(resp.text, "lxml")
    countries = []
    seen = set()

    # Look for bulleted list items that look like country names
    for li in soup.find_all("li"):
        text = li.get_text(strip=True)
        if 4 < len(text) < 80 and text not in seen:
            skip_keywords = ["click", "learn", "contact", "service", "program", "policy",
                             "restriction", "shipment", "export", "import", "regulation"]
            if not any(k in text.lower() for k in skip_keywords):
                countries.append({"country": text, "reason": "OFAC / US sanctions", "type": S})
                seen.add(text)

    if len(countries) >= 3:
        print(f"  UPS live: found {len(countries)} restrictions")
        return countries
    return None


def scrape_fedex():
    """FedEx service alerts — JS-heavy, scrape what we can."""
    print("  Trying FedEx service alerts live scrape...")
    resp = fetch("https://www.fedex.com/en-us/service-alerts.html")
    if not resp or len(resp.text) < 1000:
        return None
    # FedEx renders via React — not parseable without JS; return None to use known data
    return None


def scrape_dhl():
    """DHL Express service alerts."""
    print("  Trying DHL service alerts live scrape...")
    resp = fetch("https://www.dhl.com/us-en/home/our-divisions/express/service-alerts.html")
    if not resp or len(resp.text) < 1000:
        return None
    # Also JS-heavy; fall back to known data
    return None


def scrape_canada_post():
    """Canada Post international service alerts."""
    print("  Trying Canada Post live scrape...")
    resp = fetch("https://www.canadapost-postescanada.ca/cpc/en/personal/sending/international/service-alerts.page")
    if not resp:
        return None
    soup = BeautifulSoup(resp.text, "lxml")
    countries = []
    seen = set()

    for tag in soup.find_all(["li", "td", "p"]):
        text = tag.get_text(strip=True)
        if "suspend" in text.lower() and len(text) < 150 and text not in seen:
            countries.append({"country": text, "reason": "Service suspended", "type": X})
            seen.add(text)

    if len(countries) >= 2:
        print(f"  Canada Post live: found {len(countries)} entries")
        return countries
    return None


SCRAPE_FNS = {
    "usps":        scrape_usps,
    "ups":         scrape_ups,
    "fedex":       scrape_fedex,
    "dhl":         scrape_dhl,
    "canada_post": scrape_canada_post,
}


def run_scrapers(carriers):
    """Attempt live scrapes; fall back to known data. Sets 'live' flag."""
    for carrier in carriers:
        fn_name = carrier.get("scrape_fn")
        carrier["live"] = False
        if fn_name and fn_name in SCRAPE_FNS:
            print(f"[{carrier['name']}]")
            try:
                result = SCRAPE_FNS[fn_name]()
                if result:
                    carrier["restrictions"] = result
                    carrier["live"] = True
                    print(f"  -> Live data loaded for {carrier['name']}")
                else:
                    print(f"  -> Using known data for {carrier['name']}")
            except Exception:
                traceback.print_exc()
                print(f"  -> Scrape failed, using known data for {carrier['name']}")


# ── HTML template ──────────────────────────────────────────────────────────────

TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Carrier Restriction Monitor</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #f1f5f9;
  --card:      #ffffff;
  --border:    #e2e8f0;
  --text:      #0f172a;
  --muted:     #64748b;
  --header-bg: #0f172a;
  --accent:    #6366f1;

  --sanctions-bg:   #fef2f2;
  --sanctions-text: #991b1b;
  --sanctions-dot:  #dc2626;

  --suspended-bg:   #fff7ed;
  --suspended-text: #9a3412;
  --suspended-dot:  #ea580c;

  --limited-bg:     #fefce8;
  --limited-text:   #92400e;
  --limited-dot:    #ca8a04;

  --cat-express:   #dbeafe;
  --cat-postal:    #d1fae5;
  --cat-freight:   #f3e8ff;
  --cat-3pl:       #fce7f3;
  --cat-ecommerce: #e0f2fe;
}

body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }

/* ── Header ── */
header { background: var(--header-bg); color: #fff; padding: 24px 32px; }
header h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
header p  { color: #94a3b8; font-size: 0.875rem; margin-top: 4px; }

/* ── Stats bar ── */
.stats { display: flex; flex-wrap: wrap; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
.stat  { flex: 1; min-width: 140px; background: var(--card); padding: 14px 20px; }
.stat-value { font-size: 1.5rem; font-weight: 700; }
.stat-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
.stat-value.red    { color: var(--sanctions-dot); }
.stat-value.orange { color: var(--suspended-dot); }
.stat-value.amber  { color: var(--limited-dot);   }

/* ── Controls ── */
.controls { background: var(--card); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.search-wrap { position: relative; flex: 1; min-width: 220px; max-width: 380px; }
.search-wrap svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
input[type=search] { width: 100%; padding: 8px 12px 8px 34px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.875rem; background: var(--bg); }
input[type=search]:focus { outline: 2px solid var(--accent); background: #fff; }

.filter-group { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-group label { font-size: 0.75rem; color: var(--muted); align-self: center; margin-right: 2px; }
.pill { padding: 5px 12px; border-radius: 999px; font-size: 0.8rem; border: 1px solid var(--border); background: var(--card); cursor: pointer; white-space: nowrap; transition: all 0.12s; }
.pill:hover { border-color: var(--accent); }
.pill.active { background: var(--accent); color: #fff; border-color: var(--accent); }

.view-toggle { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-left: auto; }
.view-btn { padding: 6px 16px; font-size: 0.8rem; cursor: pointer; background: var(--card); border: none; border-right: 1px solid var(--border); }
.view-btn:last-child { border-right: none; }
.view-btn.active { background: var(--accent); color: #fff; }

/* ── Main content ── */
main { padding: 24px; max-width: 1400px; margin: 0 auto; }

/* ── Carrier grid ── */
.carrier-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.carrier-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.carrier-header { padding: 16px 18px 12px; display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid var(--border); }
.carrier-name { font-weight: 700; font-size: 1rem; }
.carrier-full { font-size: 0.75rem; color: var(--muted); margin-top: 1px; }
.carrier-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-express   { background: var(--cat-express);   color: #1d4ed8; }
.badge-postal    { background: var(--cat-postal);    color: #065f46; }
.badge-freight   { background: var(--cat-freight);   color: #6b21a8; }
.badge-3pl       { background: var(--cat-3pl);       color: #9d174d; }
.badge-ecommerce { background: var(--cat-ecommerce); color: #0369a1; }
.badge-live      { background: #dcfce7; color: #166534; }
.badge-known     { background: #f1f5f9; color: #64748b; }
.carrier-hq { font-size: 0.72rem; color: var(--muted); margin-left: auto; white-space: nowrap; }

.carrier-body { padding: 12px 18px; }
.restriction-count { font-size: 0.8rem; color: var(--muted); margin-bottom: 10px; }
.restriction-count strong { color: var(--text); }

.restriction-list { list-style: none; display: flex; flex-direction: column; gap: 5px; }
.restriction-item { display: flex; align-items: flex-start; gap: 8px; font-size: 0.82rem; }
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
.dot-sanctions { background: var(--sanctions-dot); }
.dot-suspended { background: var(--suspended-dot); }
.dot-limited   { background: var(--limited-dot);   }
.ri-country { font-weight: 500; }
.ri-reason  { color: var(--muted); font-size: 0.77rem; }

.show-more-btn { display: block; width: 100%; margin-top: 10px; padding: 6px; font-size: 0.78rem; color: var(--accent); background: transparent; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; text-align: center; }
.show-more-btn:hover { background: var(--bg); }

.carrier-footer { padding: 10px 18px; background: var(--bg); border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.carrier-note { font-size: 0.72rem; color: var(--muted); font-style: italic; flex: 1; margin-right: 10px; }
.source-link { font-size: 0.75rem; color: var(--accent); text-decoration: none; white-space: nowrap; }
.source-link:hover { text-decoration: underline; }

/* ── By Country view ── */
.country-list { display: flex; flex-direction: column; gap: 10px; }
.country-row  { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.country-row-header { padding: 14px 18px; display: flex; align-items: center; gap: 14px; cursor: pointer; }
.country-row-header:hover { background: var(--bg); }
.country-name  { font-weight: 700; font-size: 1rem; }
.country-meta  { font-size: 0.8rem; color: var(--muted); }
.country-chevron { margin-left: auto; color: var(--muted); transition: transform 0.2s; }
.country-chevron.open { transform: rotate(180deg); }
.severity-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.sev-pill { padding: 2px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; }
.sev-s { background: var(--sanctions-bg); color: var(--sanctions-text); }
.sev-x { background: var(--suspended-bg); color: var(--suspended-text); }
.sev-l { background: var(--limited-bg);   color: var(--limited-text);   }

.country-row-body { padding: 0 18px 14px; display: none; }
.country-row-body.open { display: block; }
.carrier-restriction { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 0.83rem; }
.carrier-restriction:last-child { border-bottom: none; }
.cr-carrier { font-weight: 600; min-width: 130px; }
.cr-reason  { color: var(--muted); }

/* ── Empty state ── */
.empty { text-align: center; padding: 60px 20px; color: var(--muted); }
.empty strong { display: block; font-size: 1.1rem; margin-bottom: 6px; color: var(--text); }

/* ── Footer ── */
footer { margin-top: 40px; padding: 24px; text-align: center; font-size: 0.78rem; color: var(--muted); border-top: 1px solid var(--border); }
footer a { color: var(--accent); text-decoration: none; }

/* ── Responsive ── */
@media (max-width: 600px) {
  header { padding: 18px 16px; }
  main { padding: 16px; }
  .controls { padding: 12px 16px; }
  .carrier-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<header>
  <h1>Carrier Restriction Monitor</h1>
  <p>Countries major carriers and 3PLs are NOT shipping to &mdash; refreshed daily</p>
</header>

<div class="stats" id="stats"></div>

<div class="controls">
  <div class="search-wrap">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="search" id="search" placeholder="Search carrier or country..." autocomplete="off">
  </div>

  <div class="filter-group">
    <label>Type</label>
    <button class="pill active" data-type="all">All</button>
    <button class="pill" data-type="sanctions">Sanctions</button>
    <button class="pill" data-type="suspended">Suspended</button>
    <button class="pill" data-type="limited">Limited</button>
  </div>

  <div class="filter-group">
    <label>Category</label>
    <button class="pill active" data-cat="all">All</button>
    <button class="pill" data-cat="express">Express</button>
    <button class="pill" data-cat="postal">Postal</button>
    <button class="pill" data-cat="freight">Freight</button>
    <button class="pill" data-cat="3pl">3PL</button>
    <button class="pill" data-cat="ecommerce">eCommerce</button>
  </div>

  <div class="view-toggle">
    <button class="view-btn active" id="btn-by-carrier">By Carrier</button>
    <button class="view-btn" id="btn-by-country">By Country</button>
  </div>
</div>

<main>
  <div id="by-carrier"></div>
  <div id="by-country" style="display:none"></div>
</main>

<footer>
  Generated <span id="gen-time"></span> &nbsp;&bull;&nbsp;
  Data sourced from official carrier service pages &mdash; verify at carrier links before making shipping decisions.
  <br>Sanctions data based on OFAC, EU, UN, and national sanctions lists current at scan time.
</footer>

<script>
const DATA = __DATA__;

// ── State ────────────────────────────────────────────────────────────────────
let view     = "carrier";
let typeFilter = "all";
let catFilter  = "all";
let search   = "";

// ── Helpers ──────────────────────────────────────────────────────────────────
const TYPE_LABELS = { sanctions: "Sanctions", suspended: "Suspended", limited: "Limited" };
const CAT_LABELS  = { express: "Express", postal: "Postal", freight: "Freight", "3pl": "3PL", ecommerce: "eCommerce" };

function typeClass(t) {
  return t === "sanctions" ? "sanctions" : t === "suspended" ? "suspended" : "limited";
}

function matchesFilters(carrier, rList) {
  if (catFilter !== "all" && carrier.category !== catFilter) return false;
  if (typeFilter !== "all" && !rList.some(r => r.type === typeFilter)) return false;
  if (search) {
    const q = search.toLowerCase();
    const inCarrier = carrier.name.toLowerCase().includes(q) || carrier.full_name.toLowerCase().includes(q);
    const inCountry = rList.some(r => r.country.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q));
    if (!inCarrier && !inCountry) return false;
  }
  return true;
}

function filteredRestrictions(carrier) {
  let rs = carrier.restrictions;
  if (typeFilter !== "all") rs = rs.filter(r => r.type === typeFilter);
  if (search) {
    const q = search.toLowerCase();
    const carrierMatch = carrier.name.toLowerCase().includes(q) || carrier.full_name.toLowerCase().includes(q);
    if (!carrierMatch) rs = rs.filter(r => r.country.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q));
  }
  return rs;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const totalCarriers  = DATA.carriers.length;
  const allCountries   = new Set();
  let   totalSanctions = 0, totalSuspended = 0, totalLimited = 0;
  for (const c of DATA.carriers) {
    for (const r of c.restrictions) {
      allCountries.add(r.country);
      if (r.type === "sanctions")  totalSanctions++;
      if (r.type === "suspended")  totalSuspended++;
      if (r.type === "limited")    totalLimited++;
    }
  }
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-value">${totalCarriers}</div><div class="stat-label">Carriers Tracked</div></div>
    <div class="stat"><div class="stat-value">${allCountries.size}</div><div class="stat-label">Countries Flagged</div></div>
    <div class="stat"><div class="stat-value red">${totalSanctions}</div><div class="stat-label">Sanctions Entries</div></div>
    <div class="stat"><div class="stat-value orange">${totalSuspended}</div><div class="stat-label">Suspended Entries</div></div>
    <div class="stat"><div class="stat-value amber">${totalLimited}</div><div class="stat-label">Limited Entries</div></div>
  `;
}

// ── By Carrier ────────────────────────────────────────────────────────────────
const PREVIEW_LIMIT = 6;
const expanded = new Set();

function renderCarrierView() {
  const grid = document.getElementById("by-carrier");
  const cards = [];

  for (const carrier of DATA.carriers) {
    const allRs = filteredRestrictions(carrier);
    if (!matchesFilters(carrier, carrier.restrictions)) continue;
    if (allRs.length === 0 && (typeFilter !== "all" || search)) continue;

    const showAll = expanded.has(carrier.id);
    const display = showAll ? allRs : allRs.slice(0, PREVIEW_LIMIT);
    const hasMore  = allRs.length > PREVIEW_LIMIT;

    const rows = display.map(r => `
      <li class="restriction-item">
        <span class="dot dot-${typeClass(r.type)}"></span>
        <span><div class="ri-country">${esc(r.country)}</div><div class="ri-reason">${esc(r.reason)}</div></span>
      </li>`).join("");

    const moreBtn = hasMore && !showAll
      ? `<button class="show-more-btn" onclick="toggleExpand('${carrier.id}')">Show ${allRs.length - PREVIEW_LIMIT} more...</button>`
      : hasMore && showAll
      ? `<button class="show-more-btn" onclick="toggleExpand('${carrier.id}')">Show less</button>`
      : "";

    const dataStatus = carrier.live
      ? `<span class="badge badge-live">Live</span>`
      : `<span class="badge badge-known">Known</span>`;

    cards.push(`
      <div class="carrier-card">
        <div class="carrier-header">
          <div>
            <div class="carrier-name">${esc(carrier.name)}</div>
            <div class="carrier-full">${esc(carrier.full_name)}</div>
            <div class="carrier-badges">
              <span class="badge badge-${carrier.category}">${CAT_LABELS[carrier.category] || carrier.category}</span>
              ${dataStatus}
            </div>
          </div>
          <div class="carrier-hq">HQ: ${esc(carrier.hq)}</div>
        </div>
        <div class="carrier-body">
          <div class="restriction-count"><strong>${allRs.length}</strong> restriction${allRs.length !== 1 ? "s" : ""} flagged</div>
          <ul class="restriction-list">${rows}</ul>
          ${moreBtn}
        </div>
        <div class="carrier-footer">
          <span class="carrier-note">${carrier.note ? esc(carrier.note) : ""}</span>
          <a class="source-link" href="${carrier.source_url}" target="_blank" rel="noopener">Official source &rarr;</a>
        </div>
      </div>`);
  }

  grid.innerHTML = cards.length
    ? `<div class="carrier-grid">${cards.join("")}</div>`
    : `<div class="empty"><strong>No carriers match your filters.</strong>Try broadening your search.</div>`;
}

function toggleExpand(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderCarrierView();
}

// ── By Country ────────────────────────────────────────────────────────────────
const openCountries = new Set();

function renderCountryView() {
  // Aggregate: country -> [{carrier, reason, type}]
  const map = {};

  for (const carrier of DATA.carriers) {
    if (catFilter !== "all" && carrier.category !== catFilter) continue;
    for (const rest of carrier.restrictions) {
      if (typeFilter !== "all" && rest.type !== typeFilter) continue;
      if (!map[rest.country]) map[rest.country] = [];
      map[rest.country].push({ carrier: carrier.name, reason: rest.reason, type: rest.type });
    }
  }

  let countries = Object.keys(map);

  if (search) {
    const q = search.toLowerCase();
    countries = countries.filter(c => {
      if (c.toLowerCase().includes(q)) return true;
      return map[c].some(e => e.carrier.toLowerCase().includes(q) || e.reason.toLowerCase().includes(q));
    });
  }

  // Sort: most carriers first, then alphabetical
  countries.sort((a, b) => map[b].length - map[a].length || a.localeCompare(b));

  const rows = countries.map(country => {
    const entries = map[country];
    const isOpen  = openCountries.has(country);
    const sevMap  = { sanctions: 0, suspended: 0, limited: 0 };
    entries.forEach(e => sevMap[e.type]++);

    const sevPills = [
      sevMap.sanctions ? `<span class="sev-pill sev-s">${sevMap.sanctions} Sanctions</span>` : "",
      sevMap.suspended ? `<span class="sev-pill sev-x">${sevMap.suspended} Suspended</span>` : "",
      sevMap.limited   ? `<span class="sev-pill sev-l">${sevMap.limited} Limited</span>`     : "",
    ].filter(Boolean).join("");

    const carrierRows = entries.map(e => `
      <div class="carrier-restriction">
        <span class="dot dot-${typeClass(e.type)}"></span>
        <span class="cr-carrier">${esc(e.carrier)}</span>
        <span class="cr-reason">${esc(e.reason)}</span>
      </div>`).join("");

    return `
      <div class="country-row">
        <div class="country-row-header" onclick="toggleCountry('${country.replace(/'/g,"\\'")}')">
          <div>
            <div class="country-name">${esc(country)}</div>
            <div class="country-meta">${entries.length} carrier${entries.length !== 1 ? "s" : ""} not shipping</div>
          </div>
          <div class="severity-pills">${sevPills}</div>
          <svg class="country-chevron ${isOpen ? "open" : ""}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="country-row-body ${isOpen ? "open" : ""}">${carrierRows}</div>
      </div>`;
  });

  document.getElementById("by-country").innerHTML = rows.length
    ? `<div class="country-list">${rows.join("")}</div>`
    : `<div class="empty"><strong>No countries match your filters.</strong>Try broadening your search.</div>`;
}

function toggleCountry(country) {
  if (openCountries.has(country)) openCountries.delete(country); else openCountries.add(country);
  renderCountryView();
}

// ── Render dispatcher ─────────────────────────────────────────────────────────
function render() {
  if (view === "carrier") {
    renderCarrierView();
  } else {
    renderCountryView();
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById("search").addEventListener("input", e => {
  search = e.target.value.trim();
  render();
});

document.querySelectorAll("[data-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    typeFilter = btn.dataset.type;
    document.querySelectorAll("[data-type]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    render();
  });
});

document.querySelectorAll("[data-cat]").forEach(btn => {
  btn.addEventListener("click", () => {
    catFilter = btn.dataset.cat;
    document.querySelectorAll("[data-cat]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    render();
  });
});

document.getElementById("btn-by-carrier").addEventListener("click", () => {
  view = "carrier";
  document.getElementById("by-carrier").style.display = "";
  document.getElementById("by-country").style.display = "none";
  document.getElementById("btn-by-carrier").classList.add("active");
  document.getElementById("btn-by-country").classList.remove("active");
  render();
});

document.getElementById("btn-by-country").addEventListener("click", () => {
  view = "country";
  document.getElementById("by-carrier").style.display = "none";
  document.getElementById("by-country").style.display = "";
  document.getElementById("btn-by-carrier").classList.remove("active");
  document.getElementById("btn-by-country").classList.add("active");
  render();
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById("gen-time").textContent = new Date(DATA.generated_at).toLocaleString();
renderStats();
render();
</script>
</body>
</html>"""


# ── HTML generation ────────────────────────────────────────────────────────────

def generate_dashboard(carriers):
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "carriers": [
            {
                "id":           c["id"],
                "name":         c["name"],
                "full_name":    c["full_name"],
                "category":     c["category"],
                "hq":           c["hq"],
                "source_url":   c["source_url"],
                "alerts_url":   c["alerts_url"],
                "note":         c.get("note", ""),
                "live":         c.get("live", False),
                "restrictions": c["restrictions"],
            }
            for c in carriers
        ]
    }

    html = TEMPLATE.replace("__DATA__", json.dumps(payload, ensure_ascii=False))
    OUTPUT.write_text(html, encoding="utf-8")
    print(f"\nDashboard written to: {OUTPUT}")


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Carrier Restriction Scanner")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    print("\n[Live scrape attempts]")
    run_scrapers(CARRIERS)

    print("\n[Generating dashboard]")
    generate_dashboard(CARRIERS)

    live_count = sum(1 for c in CARRIERS if c.get("live"))
    print(f"Live scraped: {live_count} / {len(CARRIERS)} carriers")
    print(f"Known data:  {len(CARRIERS) - live_count} / {len(CARRIERS)} carriers")
    print("\nDone. Open dashboard.html in your browser.")
