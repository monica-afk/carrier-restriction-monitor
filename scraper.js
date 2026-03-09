/**
 * Carrier Shipping Restriction Scanner
 * Tracks countries that major carriers and 3PLs are NOT shipping to.
 * Run daily — generates a self-contained dashboard.html.
 */

import { load } from "cheerio";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT    = join(__dirname, "index.html");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchPage(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    console.warn(`  [WARN] Could not fetch ${url}: ${e.message}`);
    return null;
  }
}

// ── Restriction helpers ────────────────────────────────────────────────────────
const S = "sanctions";   // Legal prohibition (OFAC, UN, EU)
const X = "suspended";   // Full service suspension
const L = "limited";     // Partial / significantly reduced service

function r(country, reason, type) { return { country, reason, type }; }

// ── Product restriction helpers ────────────────────────────────────────────────
const PP = "prohibited";   // Not accepted under any circumstances
const PR = "restricted";   // Accepted with conditions / documentation required
const PH = "hazmat";       // Requires hazmat handling / special labeling

function p(product, reason, type) { return { product, reason, type }; }

// ── Shared baseline data ───────────────────────────────────────────────────────
const OFAC_US = [
  r("Cuba",                      "OFAC embargo",                 S),
  r("Iran",                      "OFAC sanctions",               S),
  r("North Korea (DPRK)",        "OFAC sanctions",               S),
  r("Syria",                     "OFAC sanctions",               S),
  r("Crimea (Ukraine)",          "OFAC / Executive Order",       S),
  r("Donetsk People's Republic", "OFAC sanctions (2022)",        S),
  r("Luhansk People's Republic", "OFAC sanctions (2022)",        S),
  r("Zaporizhzhia (Ukraine)",    "OFAC sanctions (2022)",        S),
  r("Kherson (Ukraine)",         "OFAC sanctions (2022)",        S),
];

const OFAC_INTL = [
  r("Iran",               "UN / EU sanctions",  S),
  r("North Korea (DPRK)", "UN / EU sanctions",  S),
  r("Syria",              "UN / EU sanctions",  S),
];

const RUSSIA_BELARUS = [
  r("Russia",  "Services suspended (Feb 2022)",  X),
  r("Belarus", "Services suspended (2022)",       X),
];

const CONFLICT_LIMITED = [
  r("Afghanistan", "Severely limited — security",         L),
  r("Haiti",       "Severely limited — instability",       L),
  r("Libya",       "Severely limited — conflict",          L),
  r("Somalia",     "Severely limited — security",          L),
  r("Sudan",       "Limited — conflict / sanctions",       L),
  r("South Sudan", "Limited — instability",                L),
  r("Yemen",       "Limited — active conflict",            L),
  r("Myanmar",     "Limited — sanctions / instability",    L),
];

// ── Carrier definitions ────────────────────────────────────────────────────────
const CARRIERS = [

  // ── Express / Parcel ──────────────────────────────────────────────────────
  {
    id: "ups", name: "UPS", full_name: "United Parcel Service",
    category: "express", hq: "US",
    source_url: "https://www.ups.com/us/en/support/shipping-special-care-regulated-items/sanctioned-countries",
    alerts_url: "https://www.ups.com/us/en/support/shipping-special-care-regulated-items/sanctioned-countries",
    scrapeFn: scrapeUPS,
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED,
      r("Venezuela", "Limited services", L),
    ],
  },

  {
    id: "fedex", name: "FedEx", full_name: "FedEx Corporation",
    category: "express", hq: "US",
    source_url: "https://www.fedex.com/en-us/regulatory-compliance/denied-parties.html",
    alerts_url: "https://www.fedex.com/en-us/regulatory-compliance/denied-parties.html",
    scrapeFn: scrapeFedEx,
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED,
      r("Venezuela",                "Limited services",    L),
      r("Central African Republic", "Limited — security",  L),
    ],
  },

  {
    id: "dhl_express", name: "DHL Express", full_name: "DHL Express",
    category: "express", hq: "Germany",
    source_url: "https://www.dhl.com/discover/en-us/business/shipping-advice/sanctioned-countries",
    alerts_url: "https://www.dhl.com/discover/en-us/business/shipping-advice/sanctioned-countries",
    scrapeFn: scrapeDHL,
    restrictions: [
      r("Cuba",               "OFAC / EU sanctions",  S),
      r("Iran",               "OFAC / EU sanctions",  S),
      r("North Korea (DPRK)", "OFAC / EU sanctions",  S),
      r("Syria",              "OFAC / EU sanctions",  S),
      r("Crimea (Ukraine)",   "OFAC / EU sanctions",  S),
      ...RUSSIA_BELARUS,
      r("Ukraine (conflict areas)", "Partial suspension — active conflict", X),
      ...CONFLICT_LIMITED,
      r("Venezuela", "Limited services", L),
    ],
  },

  {
    id: "usps", name: "USPS", full_name: "US Postal Service",
    category: "postal", hq: "US",
    source_url: "https://pe.usps.com/text/imm/immc5_002.htm",
    alerts_url: "https://pe.usps.com/text/imm/immc5_002.htm",
    scrapeFn: scrapeUSPS,
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS,
      r("Afghanistan",              "Mail service suspended",  X),
      r("Haiti",                    "Service suspended",       X),
      r("Libya",                    "Mail service suspended",  X),
      r("Somalia",                  "Mail service suspended",  X),
      r("Sudan",                    "Mail service suspended",  X),
      r("South Sudan",              "Mail service suspended",  X),
      r("Yemen",                    "Mail service suspended",  X),
      r("Ukraine (certain areas)",  "Partial suspension",      L),
      r("Myanmar",                  "Limited service",         L),
      r("Eritrea",                  "Limited service",         L),
      r("Central African Republic", "Limited service",         L),
      r("Burkina Faso",             "Limited service",         L),
      r("Mali",                     "Limited service",         L),
      r("Niger",                    "Limited service",         L),
      r("Guinea-Bissau",            "Limited service",         L),
      r("Venezuela",                "Limited service",         L),
    ],
  },

  {
    id: "tnt", name: "TNT", full_name: "TNT (FedEx subsidiary)",
    category: "express", hq: "Netherlands",
    source_url: "https://www.tnt.com/express/en_gc/site/how-to/comply-with-export-regulations.html",
    alerts_url: "https://www.tnt.com/express/en_gc/site/how-to/comply-with-export-regulations.html",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "canada_post", name: "Canada Post", full_name: "Canada Post / Postes Canada",
    category: "postal", hq: "Canada",
    source_url: "https://www.canadapost-postescanada.ca/cpc/en/support/personal/international-destinations-listing.page",
    alerts_url: "https://www.canadapost-postescanada.ca/cpc/en/support/personal/international-destinations-listing.page",
    scrapeFn: scrapeCanadaPost,
    restrictions: [
      r("Iran",               "Canadian / UN sanctions",  S),
      r("North Korea (DPRK)", "Canadian / UN sanctions",  S),
      r("Syria",              "Canadian / UN sanctions",  S),
      r("Crimea (Ukraine)",   "Canadian / UN sanctions",  S),
      ...RUSSIA_BELARUS,
      r("Ukraine (conflict areas)", "Partial suspension", X),
      ...CONFLICT_LIMITED,
    ],
  },

  {
    id: "purolator", name: "Purolator", full_name: "Purolator Inc.",
    category: "express", hq: "Canada",
    note: "Primarily domestic Canada; limited international reach",
    source_url: "https://www.purolator.com/en/resources-support/service-alerts-updates/service-alert-international-shipments",
    alerts_url: "https://www.purolator.com/en/resources-support/service-alerts-updates/service-alert-international-shipments",
    restrictions: [
      r("Iran",               "Sanctions compliance",  S),
      r("North Korea (DPRK)", "Sanctions compliance",  S),
      r("Syria",              "Sanctions compliance",  S),
      ...RUSSIA_BELARUS,
    ],
  },

  {
    id: "royal_mail", name: "Royal Mail", full_name: "Royal Mail Group",
    category: "postal", hq: "UK",
    source_url: "https://www.royalmail.com/international-sanctions",
    alerts_url: "https://www.royalmail.com/international-sanctions",
    restrictions: [
      r("Iran",               "UK / UN sanctions",  S),
      r("North Korea (DPRK)", "UK / UN sanctions",  S),
      r("Syria",              "UK / UN sanctions",  S),
      ...RUSSIA_BELARUS, ...CONFLICT_LIMITED,
      r("Cuba", "Limited services", L),
    ],
  },

  {
    id: "postnl", name: "PostNL", full_name: "PostNL (Netherlands)",
    category: "postal", hq: "Netherlands",
    source_url: "https://www.postnl.nl/en/sending/international-service-alerts/",
    alerts_url: "https://www.postnl.nl/en/sending/international-service-alerts/",
    restrictions: [...OFAC_INTL, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "australia_post", name: "Australia Post", full_name: "Australia Post",
    category: "postal", hq: "Australia",
    source_url: "https://auspost.com.au/disruptions-and-updates/international-service-updates",
    alerts_url: "https://auspost.com.au/disruptions-and-updates/international-service-updates",
    restrictions: [
      r("Iran",               "Australian / UN sanctions",  S),
      r("North Korea (DPRK)", "Australian / UN sanctions",  S),
      r("Syria",              "Australian / UN sanctions",  S),
      ...RUSSIA_BELARUS, ...CONFLICT_LIMITED,
    ],
  },

  {
    id: "la_poste", name: "La Poste", full_name: "La Poste (France)",
    category: "postal", hq: "France",
    source_url: "https://www.laposte.fr/assistance/envoi-international-pays-non-desservis",
    alerts_url: "https://www.laposte.fr/assistance/envoi-international-pays-non-desservis",
    restrictions: [...OFAC_INTL, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "dhl_ecommerce", name: "DHL eCommerce", full_name: "DHL eCommerce Solutions",
    category: "ecommerce", hq: "Germany",
    source_url: "https://www.dhl.com/us-en/home/ecommerce/business-help-center/hazardous-goods-and-unacceptable-shipments.html",
    alerts_url: "https://www.dhl.com/us-en/home/ecommerce/business-help-center/hazardous-goods-and-unacceptable-shipments.html",
    restrictions: [
      r("Cuba",               "OFAC / EU sanctions",  S),
      r("Iran",               "OFAC / EU sanctions",  S),
      r("North Korea (DPRK)", "OFAC / EU sanctions",  S),
      r("Syria",              "OFAC / EU sanctions",  S),
      r("Crimea (Ukraine)",   "OFAC / EU sanctions",  S),
      ...RUSSIA_BELARUS, ...CONFLICT_LIMITED,
    ],
  },

  // ── Freight ───────────────────────────────────────────────────────────────
  {
    id: "maersk", name: "Maersk", full_name: "A.P. Moller-Maersk",
    category: "freight", hq: "Denmark",
    source_url: "https://www.maersk.com/support/faqs/policy-on-shipments-involving-russia-and-eu-us-and-un-sanctions-and-export-control-laws",
    alerts_url: "https://www.maersk.com/support/faqs/policy-on-shipments-involving-russia-and-eu-us-and-un-sanctions-and-export-control-laws",
    restrictions: [
      ...OFAC_INTL, ...RUSSIA_BELARUS,
      r("Libya",   "Limited — security",  L),
      r("Yemen",   "Limited — conflict",  L),
      r("Somalia", "Limited — security",  L),
    ],
  },

  {
    id: "db_schenker", name: "DB Schenker", full_name: "DB Schenker (Deutsche Bahn)",
    category: "freight", hq: "Germany",
    source_url: "https://www.dbschenker.com/global/compliance",
    alerts_url: "https://www.dbschenker.com/global/compliance",
    restrictions: [
      ...OFAC_INTL, ...RUSSIA_BELARUS,
      r("Libya",   "Limited service",  L),
      r("Yemen",   "Limited service",  L),
      r("Somalia", "Limited service",  L),
    ],
  },

  {
    id: "kuehne_nagel", name: "Kuehne+Nagel", full_name: "Kuehne+Nagel International AG",
    category: "freight", hq: "Switzerland",
    source_url: "https://www.kuehne-nagel.com/company/news/updates-on-global-trade-and-tariffs",
    alerts_url: "https://www.kuehne-nagel.com/company/news/updates-on-global-trade-and-tariffs",
    restrictions: [
      ...OFAC_INTL, ...RUSSIA_BELARUS,
      r("Yemen",   "Limited service",  L),
      r("Somalia", "Limited service",  L),
    ],
  },

  {
    id: "xpo", name: "XPO Logistics", full_name: "XPO Logistics",
    category: "freight", hq: "US",
    source_url: "https://www.xpo.com/",
    alerts_url: "https://www.xpo.com/",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS,
      r("Libya",  "Limited service",  L),
      r("Yemen",  "Limited service",  L),
    ],
  },

  {
    id: "dsv", name: "DSV", full_name: "DSV Global Transport and Logistics",
    category: "freight", hq: "Denmark",
    source_url: "https://www.dsv.com/en",
    alerts_url: "https://www.dsv.com/en",
    restrictions: [...OFAC_INTL, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  // ── 3PLs / eCommerce Fulfillment ─────────────────────────────────────────
  {
    id: "shipbob", name: "ShipBob", full_name: "ShipBob Inc.",
    category: "3pl", hq: "US",
    note: "Country support varies by fulfillment center location",
    source_url: "https://support.shipbob.com/s/article/FAQ-International-Shipping",
    alerts_url: "https://support.shipbob.com/s/article/FAQ-International-Shipping",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS,
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
    id: "flexport", name: "Flexport", full_name: "Flexport Inc.",
    category: "3pl", hq: "US",
    source_url: "https://www.flexport.com/",
    alerts_url: "https://www.flexport.com/",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "easyship", name: "Easyship", full_name: "Easyship",
    category: "3pl", hq: "Hong Kong",
    note: "Restrictions vary by carrier selected",
    source_url: "https://support.easyship.com/hc/en-us/sections/19220990214290-Restricted-Prohibited-Goods",
    alerts_url: "https://support.easyship.com/hc/en-us/sections/19220990214290-Restricted-Prohibited-Goods",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "shippo", name: "Shippo", full_name: "Shippo",
    category: "3pl", hq: "US",
    note: "Inherits restrictions from connected carrier accounts",
    source_url: "https://support.goshippo.com/hc/en-us/articles/115001897106-Carrier-Restricted-Countries",
    alerts_url: "https://support.goshippo.com/hc/en-us/articles/115001897106-Carrier-Restricted-Countries",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "shipstation", name: "ShipStation", full_name: "ShipStation",
    category: "3pl", hq: "US",
    note: "Inherits restrictions from connected carrier accounts",
    source_url: "https://help.shipstation.com/hc/en-us/articles/25007865974299-Country-Specific-Cross-Border-Shipping-Requirements",
    alerts_url: "https://help.shipstation.com/hc/en-us/articles/25007865974299-Country-Specific-Cross-Border-Shipping-Requirements",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "pitney_bowes", name: "Pitney Bowes", full_name: "Pitney Bowes Global Shipping",
    category: "3pl", hq: "US",
    source_url: "https://docs.shippingapi.pitneybowes.com/carriers/cbds-compliance.html",
    alerts_url: "https://docs.shippingapi.pitneybowes.com/carriers/cbds-compliance.html",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "asendia", name: "Asendia", full_name: "Asendia Group",
    category: "3pl", hq: "Switzerland",
    source_url: "https://www.asendia.com/service-update",
    alerts_url: "https://www.asendia.com/service-update",
    restrictions: [...OFAC_INTL, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "whiplash", name: "Whiplash", full_name: "Whiplash (Ryder subsidiary)",
    category: "3pl", hq: "US",
    source_url: "https://www.whiplash.com/",
    alerts_url: "https://www.whiplash.com/",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },

  {
    id: "radial", name: "Radial", full_name: "Radial Inc.",
    category: "3pl", hq: "US",
    source_url: "https://radial.com/",
    alerts_url: "https://radial.com/",
    restrictions: [...OFAC_US, ...RUSSIA_BELARUS, ...CONFLICT_LIMITED],
  },
];

// ── Shared product baseline data ───────────────────────────────────────────────
const UNIVERSAL_PROHIBITED = [
  p("Explosives / fireworks",          "Prohibited — commercial carriers do not accept explosive materials",         PP),
  p("Illegal drugs / narcotics",       "Prohibited by federal and international law",                                PP),
  p("Chemical / biological weapons",   "Prohibited by law",                                                         PP),
  p("Radioactive materials (Class 7)", "Prohibited except NRC/IAEA-licensed shippers with prior carrier approval",  PP),
];

const COMMON_HAZMAT = [
  p("Lithium batteries (loose/standalone)", "IATA/DOT regulated — PI 965–970; Wh limits, special packaging & labeling", PH),
  p("Aerosols (pressurized cans)",          "Class 2.1/2.2 hazmat — quantity limits, hazmat labeling required",           PH),
  p("Perfume / cologne",                    "Class 3 flammable liquid — UN 3175 / ORM-D; hazmat labeling required",       PH),
  p("Dry ice",                              "UN 1845 (CO₂) — weight limits, ventilation holes, special labeling",        PH),
];

// ── Product source URLs (prohibited/restricted items pages, not country pages) ─
const PRODUCT_URLS = {
  ups:          "https://www.ups.com/us/en/support/shipping-support/shipping-special-care-regulated-items/prohibited-items",
  fedex:        "https://www.fedex.com/en-us/shipping/international-prohibited-items.html",
  dhl_express:  "https://www.dhl.com/discover/en-us/ship-with-dhl/start-shipping/restricted-commodities",
  usps:         "https://www.usps.com/ship/shipping-restrictions.htm",
  canada_post:  "https://www.canadapost-postescanada.ca/cpc/en/support/articles/non-mailable-matter/prohibited-items-overview.page",
  royal_mail:   "https://help.royalmail.com/personal/s/article/Prohibited-and-restricted-items-personal-customer-guidelines",
  tnt:          "https://www.tnt.com/express/en_gc/site/how-to/what-you-can-ship.html",
  purolator:    "https://www.purolator.com/en/special-handling-and-dangerous-goods",
  shipbob:      "https://support.shipbob.com/s/article/ShipBob-Prohibited-and-Restricted-Items-Policy",
  flexport:     "https://support.portal.flexport.com/hc/en-us/articles/115002943554-Restricted-Products",
  easyship:     "https://support.easyship.com/hc/en-us/sections/19220990214290-Restricted-Prohibited-Goods",
  shippo:       "https://support.goshippo.com/hc/en-us/articles/37466464049563-Shipping-Dangerous-Prohibited-and-Hazardous-Goods",
  shipstation:  "https://help.shipstation.com/hc/en-us/articles/360045863811-Can-I-ship-hazardous-or-dangerous-materials",
  pitney_bowes: "https://docs.shippingapi.pitneybowes.com/carriers/cbds-compliance.html",
};

// ── Product restrictions by carrier ID ────────────────────────────────────────
const PRODUCT_RESTRICTIONS = {
  ups: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / ammunition",           "Restricted: UPS Firearms Program enrollment required; adult signature; FFL for handguns",          PR),
    p("Alcohol / wine / spirits",        "Restricted: UPS licensed shipper agreement required; state-to-state rules vary",                   PR),
    p("Tobacco / cigarettes",            "Restricted: PACT Act compliance required; no consumer delivery in most states",                    PR),
    p("Cannabis / marijuana",            "Prohibited: illegal under US federal law and internationally",                                      PP),
    p("Live animals",                    "Restricted: carrier approval required; limited services and species only",                         PR),
    p("Human remains (cremated)",        "Restricted: declared as cremated remains; inner/outer container requirements apply",               PR),
    p("Cash / currency (international)", "Prohibited in international shipments",                                                             PP),
    p("Perishables",                     "Restricted: insulated/temperature-control packaging required; transit time not guaranteed",         PR),
  ],
  fedex: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / ammunition",           "Restricted: FedEx Firearms Program required; adult signature; FFL for handguns",                   PR),
    p("Live animals",                    "Prohibited: FedEx Express does not accept live animals (very limited Ground exceptions)",            PP),
    p("Alcohol / wine / spirits",        "Restricted: licensed shipper agreement required; domestic US only for most services",               PR),
    p("Tobacco / cigarettes",            "Restricted: PACT Act compliance; no consumer delivery",                                             PR),
    p("Cannabis / marijuana",            "Prohibited: federal law",                                                                            PP),
    p("Fresh perishables",               "Restricted: FedEx Custom Critical or insulated cold pack required; no standard-service guarantee",  PR),
    p("Human remains (cremated)",        "Restricted: declared as cremated remains; special packaging and adult signature required",          PR),
    p("Cash / currency (international)", "Prohibited in international shipments",                                                             PP),
  ],
  dhl_express: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",       "Prohibited internationally; domestic acceptance extremely limited",                                         PP),
    p("Alcohol / wine / spirits", "Restricted: country-specific rules; licensed importer/exporter required; many destinations prohibited",    PR),
    p("Cannabis / marijuana",     "Prohibited: illegal under most national laws",                                                              PP),
    p("Tobacco / cigarettes",     "Restricted: licensing and import permit required; destination-specific rules apply",                        PR),
    p("Cash / currency",          "Prohibited",                                                                                                PP),
    p("Perishables",              "Restricted: adequate packaging required; transit time not guaranteed",                                      PR),
  ],
  usps: [
    ...UNIVERSAL_PROHIBITED,
    p("Lithium batteries (loose/standalone)", "Surface mail only domestically — prohibited in air; IATA restrictions for international mail",  PH),
    p("Perfume / cologne",                    "Flammable — surface mail only domestic; air mail prohibited for most international destinations", PH),
    p("Aerosols (pressurized cans)",          "Surface mail only; prohibited in air mail; strict quantity limits",                             PH),
    p("Dry ice",                              "Restricted: surface mail only; max 2.27 kg (5 lb) per package; vent holes and labeling required", PH),
    p("Firearms / handguns",                  "Restricted: handguns to/from licensed dealers (FFL) only; adult signature required",            PR),
    p("Long guns (rifles / shotguns)",        "Restricted: legal recipient only; adult signature required",                                    PR),
    p("Alcohol / wine",                       "Prohibited domestically (rare state permit exceptions); prohibited in international mail",       PP),
    p("Tobacco / cigarettes",                 "Prohibited: PACT Act bans USPS delivery of cigarettes/smokeless tobacco to consumers",          PP),
    p("Cannabis / marijuana",                 "Prohibited: federal law",                                                                        PP),
    p("Live animals",                         "Restricted: limited to day-old poultry, adult birds, invertebrates — carrier approval required", PR),
    p("Cash / currency (international)",      "Prohibited in international mail",                                                               PP),
  ],
  canada_post: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",    "Restricted: Canadian Firearms Act compliance; registration certificate and mailing permit required",            PR),
    p("Alcohol / wine",        "Prohibited domestically except via licensed provincial liquor board channels; internationally prohibited to most countries", PP),
    p("Cannabis",              "Prohibited in international mail; domestic allowed only for licensed Cannabis Act retailers to adults",          PR),
    p("Tobacco / cigarettes",  "Restricted: duty/excise tax compliance required; destination-specific restrictions apply",                     PR),
    p("Cash / currency",       "Prohibited in international mail",                                                                              PP),
    p("Live animals",          "Restricted: limited species only; carrier approval required",                                                   PR),
  ],
  royal_mail: [
    ...UNIVERSAL_PROHIBITED,
    p("Lithium batteries (loose/standalone)", "Prohibited in air mail — surface mail only with IATA-compliant packaging",                      PH),
    p("Aerosols / pressurized items",         "Prohibited in air mail; surface mail only with strict quantity limits",                          PH),
    p("Perfume / cologne",                    "Prohibited in air mail (Class 3 flammable); surface mail allowed within limits",                 PH),
    p("Firearms / weapons",                   "Prohibited",                                                                                     PP),
    p("Alcohol / wine",                       "Restricted: country-specific rules; import duty and licensing compliance required",              PR),
    p("Cannabis",                             "Prohibited",                                                                                     PP),
    p("Tobacco",                              "Restricted: import duties and destination compliance required",                                  PR),
    p("Cash / currency",                      "Prohibited in international mail",                                                               PP),
    p("Live animals",                         "Prohibited",                                                                                     PP),
  ],
  tnt: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",       "Prohibited internationally; extremely limited domestic acceptance",                                          PP),
    p("Alcohol / wine / spirits", "Restricted: country-specific licensing and import permits required",                                         PR),
    p("Cannabis",                 "Prohibited",                                                                                                  PP),
    p("Cash / currency",          "Prohibited",                                                                                                  PP),
    p("Tobacco",                  "Restricted: import compliance and licensing required",                                                       PR),
  ],
  purolator: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",    "Restricted: must comply with Canadian Firearms Act; carrier approval required",                                  PR),
    p("Alcohol / wine",        "Restricted: provincial regulations apply; licensed shipper agreement required",                                  PR),
    p("Cannabis",              "Restricted: domestic only; licensed Cannabis Act retailer required",                                             PR),
    p("Cash / currency",       "Prohibited",                                                                                                     PP),
    p("Tobacco",               "Restricted: excise compliance required",                                                                        PR),
  ],
  shipbob: [
    ...UNIVERSAL_PROHIBITED,
    p("Firearms / weapons",         "Prohibited in ShipBob warehouses",                                                                         PP),
    p("Alcohol / wine",             "Restricted: state licensing required; limited to select warehouse locations",                               PR),
    p("Cannabis / marijuana",       "Prohibited (cannabis); CBD products require compliance review and pre-approval",                            PP),
    p("Tobacco / vaping products",  "Restricted: PACT Act compliance and age verification required",                                            PR),
    p("Hazardous materials",        "Restricted: limited acceptance; carrier and warehouse pre-approval required",                               PR),
    p("Lithium batteries (loose)",  "Restricted: carrier-dependent DG compliance required; pre-approval needed",                                PR),
    p("Perishables",                "Restricted: cold chain warehouses only; limited availability",                                              PR),
  ],
  flexport: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",     "Restricted: ITAR/EAR export license required; strict compliance documentation",                                PR),
    p("Alcohol / wine",         "Restricted: import/export licensing required; destination-specific rules",                                     PR),
    p("Cannabis",               "Prohibited internationally",                                                                                   PP),
    p("Pharmaceuticals",        "Restricted: FDA/import compliance required; prescription drugs need prior approval",                           PR),
    p("Food items",             "Restricted: FDA Prior Notice required for US imports; country-specific import rules apply",                    PR),
    p("Dual-use goods",         "Restricted: Export Administration Regulations (EAR) compliance and licensing may be required",                 PR),
  ],
  easyship: [
    ...UNIVERSAL_PROHIBITED,
    p("Firearms / weapons",          "Prohibited across all connected carriers",                                                                 PP),
    p("Lithium batteries (loose)",   "Restricted: carrier-dependent; some carriers require pre-approval for standalone batteries",               PR),
    p("Perfume / cologne",           "Hazmat: many connected carriers prohibit or severely limit via air",                                       PH),
    p("Alcohol",                     "Restricted: carrier and destination-dependent; licensing often required",                                  PR),
    p("Cannabis",                    "Prohibited",                                                                                               PP),
    p("Tobacco / vaping",            "Restricted: carrier and destination rules apply",                                                         PR),
  ],
  shippo: [
    ...UNIVERSAL_PROHIBITED,
    p("Firearms / weapons",          "Prohibited on standard Shippo carrier integrations",                                                       PP),
    p("Lithium batteries (loose)",   "Inherits carrier restrictions — most carriers require DG compliance documentation",                        PR),
    p("Hazardous materials",         "Inherits carrier restrictions — most restrict or prohibit hazmat shipments",                               PR),
    p("Alcohol / cannabis",          "Prohibited or requires licensed carrier agreement beyond standard Shippo access",                          PP),
  ],
  shipstation: [
    ...UNIVERSAL_PROHIBITED,
    p("Firearms / weapons",          "Prohibited on standard ShipStation carrier integrations",                                                  PP),
    p("Lithium batteries (loose)",   "Inherits from connected carrier — IATA/DOT DG rules apply",                                               PR),
    p("Hazardous materials",         "Inherits from connected carrier — most require DG/hazmat approval",                                       PR),
    p("Alcohol / cannabis",          "Prohibited or requires licensed shipper agreement via connected carrier",                                  PP),
  ],
  pitney_bowes: [
    ...UNIVERSAL_PROHIBITED, ...COMMON_HAZMAT,
    p("Firearms / weapons",  "Prohibited",                                                                                                       PP),
    p("Alcohol / cannabis",  "Prohibited in cross-border ecommerce services",                                                                    PP),
    p("Tobacco",             "Restricted: licensing and age verification required",                                                              PR),
    p("Pharmaceuticals",     "Restricted: FDA/import compliance and pre-approval required for most destinations",                                PR),
  ],
};


// ── Live scrapers ──────────────────────────────────────────────────────────────

async function scrapeUSPS() {
  console.log("  Trying USPS IMM live scrape...");
  const html = await fetchPage("https://pe.usps.com/text/Imm/immc2_002.htm");
  if (!html) return null;

  const $ = load(html);
  const countries = [];

  $("table tr").each((i, row) => {
    const cells = $(row).find("td, th");
    if (cells.length < 1) return;
    const country = $(cells[0]).text().trim();
    const reason  = cells.length > 1 ? $(cells[1]).text().trim() : "Service suspended";
    if (!country || country.length < 3) return;
    if (/^(country|countries|nation)/i.test(country)) return;
    const type = /sanction|ofac|embargo/i.test(reason) ? S : X;
    countries.push({ country, reason: reason || "Service suspended", type });
  });

  if (countries.length >= 3) {
    console.log(`  USPS live: ${countries.length} restrictions found`);
    return countries;
  }
  return null;
}

async function scrapeUPS() {
  console.log("  Trying UPS sanctioned countries live scrape...");
  const html = await fetchPage(
    "https://www.ups.com/us/en/support/shipping-special-care-regulated-items/sanctioned-countries.page"
  );
  if (!html) return null;

  const $ = load(html);
  const countries = [];
  const seen = new Set();
  const skipWords = ["click","learn","contact","service","program","policy","restriction","shipment","export","import","regulation"];

  $("li").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 4 || text.length > 80 || seen.has(text)) return;
    if (skipWords.some(w => text.toLowerCase().includes(w))) return;
    countries.push({ country: text, reason: "OFAC / US sanctions", type: S });
    seen.add(text);
  });

  if (countries.length >= 3) {
    console.log(`  UPS live: ${countries.length} restrictions found`);
    return countries;
  }
  return null;
}

async function scrapeFedEx() {
  // FedEx renders via React — not parseable without a headless browser
  console.log("  FedEx: JS-rendered site, using known data");
  return null;
}

async function scrapeDHL() {
  // DHL also JS-heavy
  console.log("  DHL: JS-rendered site, using known data");
  return null;
}

async function scrapeCanadaPost() {
  console.log("  Trying Canada Post live scrape...");
  const html = await fetchPage(
    "https://www.canadapost-postescanada.ca/cpc/en/support/personal/international-destinations-listing.page"
  );
  if (!html) return null;

  const $ = load(html);
  const countries = [];
  const seen = new Set();

  $("li, td, p").each((_, el) => {
    const text = $(el).text().trim();
    if (/suspend/i.test(text) && text.length < 150 && !seen.has(text)) {
      countries.push({ country: text, reason: "Service suspended", type: X });
      seen.add(text);
    }
  });

  if (countries.length >= 2) {
    console.log(`  Canada Post live: ${countries.length} entries found`);
    return countries;
  }
  return null;
}


// ── Run scrapers ───────────────────────────────────────────────────────────────

async function runScrapers() {
  for (const carrier of CARRIERS) {
    carrier.live = false;
    if (!carrier.scrapeFn) continue;
    console.log(`\n[${carrier.name}]`);
    try {
      const result = await carrier.scrapeFn();
      if (result) {
        carrier.restrictions = result;
        carrier.live = true;
        console.log(`  -> Live data loaded`);
      } else {
        console.log(`  -> Using known data`);
      }
    } catch (e) {
      console.warn(`  -> Scrape error: ${e.message}, using known data`);
    }
  }
}



// ── Server-side HTML rendering ────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CAT_LABELS = { express: "Express", postal: "Postal", freight: "Freight", "3pl": "3PL", ecommerce: "eCommerce" };

const SOURCE_LABELS = {
  "pe.usps.com":                    "USPS International Mail Manual (IMM Appendix C)",
  "www.ups.com":                    "UPS Sanctioned Countries & Embargoes",
  "www.fedex.com":                  "FedEx Service Alerts",
  "www.dhl.com":                    "DHL Express Service Alerts",
  "www.tnt.com":                    "TNT Service Alerts",
  "www.canadapost-postescanada.ca": "Canada Post International Service Alerts",
  "www.purolator.com":              "Purolator Service Updates",
  "www.royalmail.com":              "Royal Mail International Country List",
  "www.postnl.nl":                  "PostNL Service Disruptions",
  "auspost.com.au":                 "Australia Post Suspended International Mail",
  "www.laposte.fr":                 "La Poste — Pays non desservis",
  "www.maersk.com":                 "Maersk Local Information & Alerts",
  "www.dbschenker.com":             "DB Schenker Russia/Ukraine Sanctions Notice",
  "home.kuehne-nagel.com":          "Kuehne+Nagel Website",
  "www.xpo.com":                    "XPO Logistics",
  "www.dsv.com":                    "DSV",
  "help.shipbob.com":               "ShipBob International Shipping Countries",
  "www.flexport.com":               "Flexport Trade Compliance",
  "support.easyship.com":           "Easyship Support Center",
  "support.goshippo.com":           "Shippo Support Center",
  "help.shipstation.com":           "ShipStation Help Center",
  "www.pitneybowes.com":            "Pitney Bowes Global eCommerce",
  "www.asendia.com":                "Asendia",
  "www.whiplash.com":               "Whiplash",
  "radial.com":                     "Radial",
};

function sourceLabel(url) {
  try {
    const h = new URL(url).hostname;
    return SOURCE_LABELS[h] || h;
  } catch (e) {
    return url;
  }
}

function typeDot(t) {
  if (t === "sanctions") return '<span class="dot ds"></span>';
  if (t === "suspended") return '<span class="dot dx"></span>';
  return '<span class="dot dl"></span>';
}

function typeLabel(t) {
  if (t === "sanctions") return "Sanctions";
  if (t === "suspended") return "Suspended";
  return "Limited";
}

function csvEscape(val) {
  const s = String(val ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function genCarrierCSV(carriers) {
  const rows = [["Carrier", "Full Name", "Category", "HQ", "Country", "Restriction Type", "Reason", "Source URL"]];
  carriers.forEach(c => {
    c.restrictions.forEach(r => {
      rows.push([c.name, c.full_name, c.category, c.hq, r.country, r.type, r.reason, c.source_url]);
    });
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
}

function genCountryCSV(carriers) {
  const map = {};
  carriers.forEach(c => {
    c.restrictions.forEach(r => {
      if (!map[r.country]) map[r.country] = [];
      map[r.country].push({ carrier: c.name, category: c.category, hq: c.hq, type: r.type, reason: r.reason, source_url: c.source_url });
    });
  });
  const rows = [["Country", "Carrier", "Category", "HQ", "Restriction Type", "Reason", "Source URL"]];
  Object.keys(map).sort((a, b) => map[b].length - map[a].length || a.localeCompare(b)).forEach(country => {
    map[country].forEach(e => {
      rows.push([country, e.carrier, e.category, e.hq, e.type, e.reason, e.source_url]);
    });
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
}

function dataUri(csv) {
  return "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
}

function genStats(carriers) {
  const countries = new Set();
  let ns = 0, nx = 0, nl = 0;
  carriers.forEach(c => c.restrictions.forEach(r => {
    countries.add(r.country);
    if (r.type === "sanctions") ns++;
    else if (r.type === "suspended") nx++;
    else nl++;
  }));

  const products = new Set();
  let np = 0, nh = 0, nr = 0;
  Object.values(PRODUCT_RESTRICTIONS).forEach(prods => prods.forEach(pr => {
    products.add(pr.product);
    if (pr.type === "prohibited") np++;
    else if (pr.type === "hazmat") nh++;
    else nr++;
  }));

  return `
    <div class="stat-chip"><span class="sc-val">${carriers.length}</span><span class="sc-lbl">Carriers</span></div>
    <div class="stat-chip"><span class="sc-val">${countries.size}</span><span class="sc-lbl">Countries</span></div>
    <div class="stat-chip"><span class="sc-val red">${ns}</span><span class="sc-lbl">Sanctions</span></div>
    <div class="stat-chip"><span class="sc-val orange">${nx}</span><span class="sc-lbl">Suspended</span></div>
    <div class="stat-chip"><span class="sc-val amber">${nl}</span><span class="sc-lbl">Limited</span></div>
    <div class="stat-chip-div"></div>
    <div class="stat-chip"><span class="sc-val">${products.size}</span><span class="sc-lbl">Products</span></div>
    <div class="stat-chip"><span class="sc-val red">${np}</span><span class="sc-lbl">Prohibited</span></div>
    <div class="stat-chip"><span class="sc-val orange">${nh}</span><span class="sc-lbl">Hazmat</span></div>
    <div class="stat-chip"><span class="sc-val amber">${nr}</span><span class="sc-lbl">Restricted</span></div>`;
}

function genCarrierCards(carriers) {
  return carriers.map(c => {
    const rs = c.restrictions;
    const preview = rs.slice(0, 6);
    const hasMore = rs.length > 6;

    const rows = preview.map(r => `
        <li class="ritem" data-type="${r.type}">
          ${typeDot(r.type)}
          <span><div class="ri-c">${esc(r.country)}</div><div class="ri-r">${esc(r.reason)}</div></span>
        </li>`).join("");

    const hiddenRows = hasMore ? rs.slice(6).map(r => `
        <li class="ritem ritem-hidden" data-type="${r.type}" style="display:none">
          ${typeDot(r.type)}
          <span><div class="ri-c">${esc(r.country)}</div><div class="ri-r">${esc(r.reason)}</div></span>
        </li>`).join("") : "";

    const moreBtn = hasMore
      ? `<button class="more-btn" onclick="toggleMore(this, ${rs.length - 6})">Show ${rs.length - 6} more...</button>`
      : "";

    const statusBadge = c.live
      ? `<span class="badge badge-live">Live</span>`
      : `<span class="badge badge-known">Known</span>`;

    return `
  <div class="carrier-card" data-id="${c.id}" data-cat="${c.category}" data-types="${[...new Set(rs.map(r => r.type))].join(" ")}">
    <div class="card-header">
      <div>
        <div class="carrier-name">${esc(c.name)}</div>
        <div class="carrier-full">${esc(c.full_name)}</div>
        <div class="badges">
          <span class="badge badge-${c.category}">${CAT_LABELS[c.category] || c.category}</span>
          ${statusBadge}
        </div>
      </div>
      <div class="hq">HQ: ${esc(c.hq)}</div>
    </div>
    <div class="card-body">
      <div class="rcount"><strong>${rs.length}</strong> restriction${rs.length !== 1 ? "s" : ""} flagged</div>
      <ul class="rlist">${rows}${hiddenRows}</ul>
      ${moreBtn}
    </div>
    <div class="card-footer">
      <div>
        <span class="card-note">${c.note ? esc(c.note) : ""}</span>
        <a class="card-csv" href="${dataUri(genCarrierCSV([c]))}" download="${c.id}-restrictions-${new Date().toISOString().slice(0,10)}.csv">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download CSV
        </a>
      </div>
      <div class="src-block">
        <div class="src-label">Source</div>
        <a class="src-link" href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(sourceLabel(c.source_url))}</a>
        <div class="src-url">${esc(c.source_url)}</div>
      </div>
    </div>
  </div>`;
  }).join("\n");
}

function genCountryRows(carriers) {
  // Aggregate
  const map = {};
  carriers.forEach(c => {
    c.restrictions.forEach(rest => {
      if (!map[rest.country]) map[rest.country] = [];
      map[rest.country].push({ carrier: c.name, category: c.category, reason: rest.reason, type: rest.type });
    });
  });

  const countries = Object.keys(map).sort((a, b) => map[b].length - map[a].length || a.localeCompare(b));

  return countries.map(country => {
    const entries = map[country];
    const types   = [...new Set(entries.map(e => e.type))];
    const cats    = [...new Set(entries.map(e => e.category))];

    const sevMap = { sanctions: 0, suspended: 0, limited: 0 };
    entries.forEach(e => sevMap[e.type]++);

    const pills = [
      sevMap.sanctions ? `<span class="sp sp-s">${sevMap.sanctions} Sanctions</span>` : "",
      sevMap.suspended ? `<span class="sp sp-x">${sevMap.suspended} Suspended</span>` : "",
      sevMap.limited   ? `<span class="sp sp-l">${sevMap.limited} Limited</span>` : "",
    ].filter(Boolean).join("");

    const carRows = entries.map(e => `
        <div class="cr-row">
          ${typeDot(e.type)}
          <span class="cr-name">${esc(e.carrier)}</span>
          <span class="cr-reason">${esc(e.reason)}</span>
        </div>`).join("");

    return `
  <div class="crow" data-country="${esc(country)}" data-types="${types.join(" ")}" data-cats="${cats.join(" ")}">
    <div class="crow-hd" onclick="toggleCountry(this)">
      <div>
        <div class="cn">${esc(country)}</div>
        <div class="cm">${entries.length} carrier${entries.length !== 1 ? "s" : ""} not shipping</div>
      </div>
      <div class="spills">${pills}</div>
      <svg class="chev" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </div>
    <div class="crow-bd">${carRows}</div>
  </div>`;
  }).join("\n");
}

// ── Product restriction rendering ──────────────────────────────────────────────

function prodDot(t) {
  if (t === "prohibited") return '<span class="dot dp"></span>';
  if (t === "hazmat")     return '<span class="dot dh"></span>';
  return '<span class="dot dr"></span>';
}

function genProductCSV() {
  const rows = [["Product", "Restriction Type", "Carrier", "Full Name", "Category", "HQ", "Reason"]];
  Object.entries(PRODUCT_RESTRICTIONS).forEach(([id, prods]) => {
    const carrier = CARRIERS.find(c => c.id === id);
    if (!carrier) return;
    prods.forEach(pr => {
      rows.push([pr.product, pr.type, carrier.name, carrier.full_name, carrier.category, carrier.hq, pr.reason]);
    });
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
}

function genProductRows() {
  const map = {};
  const sevOrder = { prohibited: 0, hazmat: 1, restricted: 2 };
  Object.entries(PRODUCT_RESTRICTIONS).forEach(([id, prods]) => {
    const carrier = CARRIERS.find(c => c.id === id);
    if (!carrier) return;
    prods.forEach(pr => {
      if (!map[pr.product]) map[pr.product] = { topType: pr.type, entries: [] };
      if ((sevOrder[pr.type] ?? 3) < (sevOrder[map[pr.product].topType] ?? 3)) {
        map[pr.product].topType = pr.type;
      }
      const prodUrl = PRODUCT_URLS[carrier.id] || carrier.source_url;
      map[pr.product].entries.push({ carrier: carrier.name, category: carrier.category, reason: pr.reason, type: pr.type, source_url: prodUrl });
    });
  });

  const products = Object.keys(map).sort((a, b) => {
    const ao = sevOrder[map[a].topType] ?? 3;
    const bo = sevOrder[map[b].topType] ?? 3;
    if (ao !== bo) return ao - bo;
    return map[b].entries.length - map[a].entries.length;
  });

  return products.map(product => {
    const { entries } = map[product];
    const types = [...new Set(entries.map(e => e.type))];
    const sevMap = { prohibited: 0, hazmat: 0, restricted: 0 };
    entries.forEach(e => { if (e.type in sevMap) sevMap[e.type]++; });

    const pills = [
      sevMap.prohibited ? `<span class="sp sp-p">${sevMap.prohibited} Prohibited</span>` : "",
      sevMap.hazmat     ? `<span class="sp sp-h">${sevMap.hazmat} Hazmat</span>`         : "",
      sevMap.restricted ? `<span class="sp sp-r">${sevMap.restricted} Restricted</span>` : "",
    ].filter(Boolean).join("");

    const carRows = entries.map(e => `
        <div class="cr-row">
          ${prodDot(e.type)}
          <span class="cr-name">${esc(e.carrier)}</span>
          <span class="cr-reason">${esc(e.reason)}</span>
          <a class="cr-src" href="${esc(e.source_url)}" target="_blank" rel="noopener">Source ↗</a>
        </div>`).join("");

    return `
  <div class="prow" data-ptypes="${types.join(" ")}">
    <div class="prow-hd" onclick="toggleProduct(this)">
      <div>
        <div class="pn">${esc(product)}</div>
        <div class="pm">${entries.length} carrier${entries.length !== 1 ? "s" : ""} with restrictions</div>
      </div>
      <div class="spills">${pills}</div>
      <svg class="chev" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </div>
    <div class="prow-bd">${carRows}</div>
  </div>`;
  }).join("\n");
}

function genProductCarrierCards() {
  return CARRIERS
    .filter(c => PRODUCT_RESTRICTIONS[c.id])
    .map(c => {
      const prods   = PRODUCT_RESTRICTIONS[c.id];
      const preview = prods.slice(0, 6);
      const hasMore = prods.length > 6;

      const rows = preview.map(pr => `
        <li class="ritem" data-ptype="${pr.type}">
          ${prodDot(pr.type)}
          <span><div class="ri-c">${esc(pr.product)}</div><div class="ri-r">${esc(pr.reason)}</div></span>
        </li>`).join("");

      const hiddenRows = hasMore ? prods.slice(6).map(pr => `
        <li class="ritem ritem-hidden" data-ptype="${pr.type}" style="display:none">
          ${prodDot(pr.type)}
          <span><div class="ri-c">${esc(pr.product)}</div><div class="ri-r">${esc(pr.reason)}</div></span>
        </li>`).join("") : "";

      const moreBtn = hasMore
        ? `<button class="more-btn" onclick="toggleMore(this, ${prods.length - 6})">Show ${prods.length - 6} more...</button>`
        : "";

      const sevMap = { prohibited: 0, hazmat: 0, restricted: 0 };
      prods.forEach(pr => { if (pr.type in sevMap) sevMap[pr.type]++; });
      const pills = [
        sevMap.prohibited ? `<span class="sp sp-p">${sevMap.prohibited} Prohibited</span>` : "",
        sevMap.hazmat     ? `<span class="sp sp-h">${sevMap.hazmat} Hazmat</span>`         : "",
        sevMap.restricted ? `<span class="sp sp-r">${sevMap.restricted} Restricted</span>` : "",
      ].filter(Boolean).join("");

      const prodUrl = PRODUCT_URLS[c.id] || c.source_url;
      return `
  <div class="carrier-card prod-carrier-card" data-cat="${c.category}" data-ptypes="${[...new Set(prods.map(pr => pr.type))].join(" ")}">
    <div class="card-header">
      <div>
        <div class="carrier-name">${esc(c.name)}</div>
        <div class="carrier-full">${esc(c.full_name)}</div>
        <div class="badges">
          <span class="badge badge-${c.category}">${CAT_LABELS[c.category] || c.category}</span>
          ${pills}
        </div>
      </div>
      <div class="hq">HQ: ${esc(c.hq)}</div>
    </div>
    <div class="card-body">
      <div class="rcount"><strong>${prods.length}</strong> product restriction${prods.length !== 1 ? "s" : ""}</div>
      <ul class="rlist">${rows}${hiddenRows}</ul>
      ${moreBtn}
    </div>
    <div class="card-footer">
      <div></div>
      <div class="src-block">
        <div class="src-label">Source</div>
        <a class="src-link" href="${esc(prodUrl)}" target="_blank" rel="noopener">${esc(sourceLabel(prodUrl))}</a>
        <div class="src-url">${esc(prodUrl)}</div>
      </div>
    </div>
  </div>`;
    }).join("\n");
}

function generateDashboard() {
  const now         = new Date();
  const statsHtml   = genStats(CARRIERS);
  const cardHtml    = genCarrierCards(CARRIERS);
  const countryHtml = genCountryRows(CARRIERS);
  const genAt       = now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const dateStamp   = now.toISOString().slice(0, 10);
  const carrierCsvUri = dataUri(genCarrierCSV(CARRIERS));
  const countryCsvUri = dataUri(genCountryCSV(CARRIERS));
  const productHtml        = genProductRows();
  const productCarrierHtml = genProductCarrierCards();
  const productCsvUri      = dataUri(genProductCSV());
  const carrierOptions     = CARRIERS.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const allCountries       = [...new Set(CARRIERS.flatMap(c => c.restrictions.map(r => r.country)))].sort((a,b) => a.localeCompare(b));
  const countryOptions     = allCountries.map(co => `<option value="${esc(co)}">${esc(co)}</option>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Carrier Restriction Monitor</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f1f5f9; --surface: #fff; --border: #e2e8f0; --border-sub: #f1f5f9;
  --text: #0f172a; --text-2: #475569; --muted: #94a3b8;
  --accent: #6366f1; --accent-h: #4f46e5;
  --san-bg: #fef2f2; --san-text: #991b1b; --san-dot: #dc2626;
  --sus-bg: #fff7ed; --sus-text: #9a3412; --sus-dot: #ea580c;
  --lim-bg: #fefce8; --lim-text: #92400e; --lim-dot: #ca8a04;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.05), 0 1px 4px rgba(0,0,0,.06);
  --shadow-md: 0 4px 12px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.06);
}
body.dark {
  --bg: #0d1117; --surface: #161b22; --border: #30363d; --border-sub: #21262d;
  --text: #e6edf3; --text-2: #8b949e; --muted: #6e7681;
  --san-bg: #450a0a; --san-text: #fca5a5;
  --sus-bg: #431407; --sus-text: #fdba74;
  --lim-bg: #422006; --lim-text: #fcd34d;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); transition: background .2s, color .2s; line-height: 1.5; }

/* ── Header ─────────────────────────────────────────────────────────────────── */
header { background: linear-gradient(135deg, #0c1628 0%, #1a2c4e 100%); color: #fff; padding: 24px 32px 0; }
.header-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 20px; }
.header-brand { display: flex; align-items: center; gap: 14px; }
.header-icon { width: 42px; height: 42px; background: rgba(99,102,241,.2); border: 1px solid rgba(99,102,241,.4); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; flex-shrink: 0; }
.header-brand h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -.02em; color: #f1f5f9; }
.header-brand p { font-size: .8rem; color: #64748b; margin-top: 3px; }
.dark-toggle { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); color: #94a3b8; padding: 7px 11px; border-radius: 8px; cursor: pointer; font-size: 1rem; line-height: 1; flex-shrink: 0; transition: all .15s; }
.dark-toggle:hover { background: rgba(255,255,255,.16); color: #fff; }

/* ── Header stats chips ──────────────────────────────────────────────────────── */
.header-stats { display: flex; flex-wrap: wrap; border-top: 1px solid rgba(255,255,255,.07); margin: 0 -32px; padding: 0 32px; }
.stat-chip { display: flex; flex-direction: column; padding: 10px 18px; border-right: 1px solid rgba(255,255,255,.07); }
.stat-chip:last-child { border-right: none; }
.sc-val { font-size: 1.25rem; font-weight: 700; color: #e2e8f0; line-height: 1; }
.sc-val.red { color: #f87171; }
.sc-val.orange { color: #fb923c; }
.sc-val.amber { color: #fbbf24; }
.sc-lbl { font-size: .62rem; text-transform: uppercase; letter-spacing: .07em; color: #4e6280; margin-top: 3px; }
.stat-chip-div { width: 1px; background: rgba(255,255,255,.15); margin: 8px 12px; align-self: stretch; flex-shrink: 0; }

/* ── Primary tab nav ─────────────────────────────────────────────────────────── */
.tab-nav { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; padding: 0 24px; overflow-x: auto; }
.tab-nav::-webkit-scrollbar { display: none; }
.tab-btn { display: flex; align-items: center; gap: 8px; padding: 14px 20px; font-size: .875rem; font-weight: 500; color: var(--text-2); background: none; border: none; border-bottom: 3px solid transparent; cursor: pointer; white-space: nowrap; transition: all .15s; margin-bottom: -1px; }
.tab-btn:hover { color: var(--text); background: var(--bg); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-btn svg { flex-shrink: 0; opacity: .55; transition: opacity .15s; }
.tab-btn.active svg { opacity: 1; }

/* ── Filter bar ──────────────────────────────────────────────────────────────── */
.filter-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.search-wrap { position: relative; flex: 1; min-width: 200px; max-width: 320px; }
.search-wrap svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
input[type=search] { width: 100%; padding: 9px 14px 9px 38px; border: 1.5px solid var(--border); border-radius: 10px; font-size: .9rem; background: var(--bg); color: var(--text); transition: border .15s, box-shadow .15s; }
input[type=search]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); background: var(--surface); }
.filter-sep { width: 1px; background: var(--border); align-self: stretch; margin: 0 2px; flex-shrink: 0; }
.filter-section { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.filter-label { font-size: .72rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; margin-right: 2px; white-space: nowrap; }
.pill { padding: 6px 14px; border-radius: 999px; font-size: .83rem; font-weight: 500; border: 1.5px solid var(--border); background: var(--surface); color: var(--text-2); cursor: pointer; transition: all .12s; white-space: nowrap; }
.pill:hover { border-color: var(--accent); color: var(--text); }
.pill.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.filter-select { padding: 7px 32px 7px 12px; border: 1.5px solid var(--border); border-radius: 10px; font-size: .875rem; font-weight: 500; background: var(--bg); color: var(--text); cursor: pointer; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; min-width: 160px; max-width: 240px; transition: border .15s, box-shadow .15s; }
.filter-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); background-color: var(--surface); }
.sub-toggle { display: flex; border: 1.5px solid var(--border); border-radius: 10px; overflow: hidden; }
.sub-btn { padding: 7px 16px; font-size: .83rem; font-weight: 500; cursor: pointer; background: var(--surface); color: var(--text-2); border: none; border-right: 1px solid var(--border); transition: all .12s; white-space: nowrap; }
.sub-btn:last-child { border-right: none; }
.sub-btn.active { background: var(--accent); color: #fff; }
.sub-btn:hover:not(.active) { background: var(--bg); color: var(--text); }

/* ── Main ────────────────────────────────────────────────────────────────────── */
main { padding: 24px; max-width: 1400px; margin: 0 auto; }
.view-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; }
.view-title { font-size: .8rem; color: var(--muted); font-weight: 500; }
.csv-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: .78rem; font-weight: 500; color: #166534; background: #dcfce7; border: 1px solid #86efac; border-radius: 8px; text-decoration: none; cursor: pointer; transition: all .12s; flex-shrink: 0; }
.csv-btn:hover { background: #bbf7d0; border-color: #4ade80; }
body.dark .csv-btn { color: #4ade80; background: #052e16; border-color: #166534; }

/* ── Carrier cards ───────────────────────────────────────────────────────────── */
.carrier-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.carrier-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-sm); transition: box-shadow .2s, transform .15s; }
.carrier-card:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.carrier-card.hidden { display: none; }
.card-header { padding: 16px 18px 12px; display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid var(--border); }
.carrier-name { font-weight: 700; font-size: 1rem; }
.carrier-full { font-size: .74rem; color: var(--muted); margin-top: 2px; }
.badges { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 7px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .67rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.badge-express   { background: #dbeafe; color: #1d4ed8; }
.badge-postal    { background: #d1fae5; color: #065f46; }
.badge-freight   { background: #f3e8ff; color: #6b21a8; }
.badge-3pl       { background: #fce7f3; color: #9d174d; }
.badge-ecommerce { background: #e0f2fe; color: #0369a1; }
.badge-live      { background: #dcfce7; color: #166534; }
.badge-known     { background: var(--border); color: var(--muted); }
body.dark .badge-express   { background: #1e3a5f; color: #93c5fd; }
body.dark .badge-postal    { background: #052e16; color: #6ee7b7; }
body.dark .badge-freight   { background: #2e1065; color: #d8b4fe; }
body.dark .badge-3pl       { background: #500724; color: #f9a8d4; }
body.dark .badge-ecommerce { background: #0c4a6e; color: #7dd3fc; }
.hq { font-size: .72rem; color: var(--muted); margin-left: auto; white-space: nowrap; }
.card-body { padding: 12px 18px; flex: 1; }
.rcount { font-size: .79rem; color: var(--muted); margin-bottom: 10px; }
.rcount strong { color: var(--text); }
.rlist { list-style: none; display: flex; flex-direction: column; gap: 5px; }
.ritem { display: flex; align-items: flex-start; gap: 8px; font-size: .82rem; }
.ritem.hidden { display: none !important; }
.dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
.ds { background: var(--san-dot); } .dx { background: var(--sus-dot); } .dl { background: var(--lim-dot); }
.ri-c { font-weight: 500; }
.ri-r { color: var(--muted); font-size: .76rem; }
.more-btn { display: block; width: 100%; margin-top: 10px; padding: 6px; font-size: .78rem; color: var(--accent); background: transparent; border: 1px solid var(--border); border-radius: 7px; cursor: pointer; transition: background .12s; }
.more-btn:hover { background: var(--bg); }
.card-footer { padding: 10px 18px 12px; background: var(--bg); border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.card-note { font-size: .72rem; color: var(--muted); font-style: italic; flex: 1; padding-top: 2px; }
.src-block { text-align: right; }
.src-label { font-size: .65rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 2px; }
.src-link { font-size: .78rem; color: var(--accent); text-decoration: none; font-weight: 500; display: block; }
.src-link:hover { text-decoration: underline; }
.src-url { font-size: .65rem; color: var(--muted); word-break: break-all; margin-top: 2px; }
.card-csv { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; font-size: .72rem; font-weight: 500; color: #166534; background: #dcfce7; border: 1px solid #86efac; border-radius: 6px; padding: 3px 9px; text-decoration: none; }
.card-csv:hover { background: #bbf7d0; }
body.dark .card-csv { color: #4ade80; background: #052e16; border-color: #166534; }

/* ── Country / Product accordion rows ───────────────────────────────────────── */
.country-list, .product-list { display: flex; flex-direction: column; gap: 8px; }
.crow, .prow { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-sm); transition: box-shadow .15s; }
.crow:hover, .prow:hover { box-shadow: var(--shadow-md); }
.crow.hidden, .prow.hidden { display: none; }
.crow-hd, .prow-hd { padding: 14px 18px; display: flex; align-items: center; gap: 14px; cursor: pointer; transition: background .1s; }
.crow-hd:hover, .prow-hd:hover { background: var(--bg); }
.cn, .pn { font-weight: 700; font-size: .95rem; }
.cm, .pm { font-size: .79rem; color: var(--muted); margin-top: 1px; }
.chev { margin-left: auto; color: var(--muted); transition: transform .2s; flex-shrink: 0; }
.chev.open { transform: rotate(180deg); }
.spills { display: flex; gap: 5px; flex-wrap: wrap; }
.sp { padding: 2px 9px; border-radius: 999px; font-size: .7rem; font-weight: 600; }
.sp-s { background: var(--san-bg); color: var(--san-text); }
.sp-x { background: var(--sus-bg); color: var(--sus-text); }
.sp-l { background: var(--lim-bg); color: var(--lim-text); }
.sp-p { background: var(--san-bg); color: var(--san-text); }
.sp-h { background: var(--sus-bg); color: var(--sus-text); }
.sp-r { background: #f5f3ff; color: #5b21b6; }
body.dark .sp-r { background: #2e1065; color: #c4b5fd; }
.crow-bd, .prow-bd { display: none; padding: 0 18px 14px; border-top: 1px solid var(--border-sub); }
.crow-bd.open, .prow-bd.open { display: block; }
.cr-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border-sub); font-size: .83rem; }
.cr-row:last-child { border-bottom: none; }
.cr-name { font-weight: 600; min-width: 120px; }
.cr-reason { color: var(--muted); flex: 1; }
.cr-src { margin-left: auto; flex-shrink: 0; font-size: .72rem; color: var(--accent); text-decoration: none; white-space: nowrap; }
.cr-src:hover { text-decoration: underline; }

/* ── Product dots ────────────────────────────────────────────────────────────── */
.dp { background: var(--san-dot); }
.dh { background: var(--sus-dot); }
.dr { background: #7c3aed; }

/* ── Empty state ─────────────────────────────────────────────────────────────── */
.empty { text-align: center; padding: 64px 20px; color: var(--muted); }
.empty strong { display: block; font-size: 1.1rem; margin-bottom: 6px; color: var(--text); }

/* ── Footer ──────────────────────────────────────────────────────────────────── */
footer { margin-top: 48px; padding: 24px; text-align: center; font-size: .78rem; color: var(--muted); border-top: 1px solid var(--border); }

/* ── Text colors ─────────────────────────────────────────────────────────────── */
.red    { color: var(--san-dot); }
.orange { color: var(--sus-dot); }
.amber  { color: var(--lim-dot); }

@media (max-width: 768px) {
  header { padding: 20px 16px 0; }
  .header-stats { margin: 0 -16px; padding: 0 16px; }
  .tab-nav, .filter-bar { padding-left: 16px; padding-right: 16px; }
  main { padding: 16px; }
  .carrier-grid { grid-template-columns: 1fr; }
  .view-header { flex-direction: column; align-items: flex-start; }
}
</style>
</head>
<body>

<header>
  <div class="header-top">
    <div class="header-brand">
      <div class="header-icon">🌐</div>
      <div>
        <h1>Carrier Restriction Monitor</h1>
        <p>Shipping restrictions across ${CARRIERS.length} carriers &mdash; updated ${genAt}</p>
      </div>
    </div>
    <button class="dark-toggle" id="dark-toggle" title="Toggle dark mode">🌙</button>
  </div>
  <div class="header-stats">
    ${statsHtml}
  </div>
</header>

<nav class="tab-nav">
  <button class="tab-btn active" id="btn-carrier" onclick="switchView('carrier')">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
    Country Restrictions
  </button>
  <button class="tab-btn" id="btn-country" onclick="switchView('country')">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    By Country
  </button>
  <button class="tab-btn" id="btn-product" onclick="switchView('product')">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    Product Restrictions
  </button>
</nav>

<div class="filter-bar">
  <div class="search-wrap">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="search" id="search" placeholder="Search carrier, country or product..." autocomplete="off">
  </div>
  <div class="filter-section" id="carrier-select-wrap">
    <div class="filter-sep"></div>
    <span class="filter-label">Carrier</span>
    <select class="filter-select" id="carrier-select">
      <option value="">All carriers</option>
      ${carrierOptions}
    </select>
  </div>
  <div class="filter-section" id="country-select-wrap" style="display:none">
    <div class="filter-sep"></div>
    <span class="filter-label">Country</span>
    <select class="filter-select" id="country-select">
      <option value="">All countries</option>
      ${countryOptions}
    </select>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-section" id="type-filter-main">
    <span class="filter-label">Type</span>
    <button class="pill active" data-type="all">All</button>
    <button class="pill" data-type="sanctions">Sanctions</button>
    <button class="pill" data-type="suspended">Suspended</button>
    <button class="pill" data-type="limited">Limited</button>
  </div>
  <div class="filter-section" id="type-filter-product" style="display:none">
    <span class="filter-label">Type</span>
    <button class="pill active" data-ptype="all">All</button>
    <button class="pill" data-ptype="prohibited">Prohibited</button>
    <button class="pill" data-ptype="hazmat">Hazmat</button>
    <button class="pill" data-ptype="restricted">Restricted</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-section">
    <span class="filter-label">Category</span>
    <button class="pill active" data-cat="all">All</button>
    <button class="pill" data-cat="express">Express</button>
    <button class="pill" data-cat="postal">Postal</button>
    <button class="pill" data-cat="freight">Freight</button>
    <button class="pill" data-cat="3pl">3PL</button>
    <button class="pill" data-cat="ecommerce">eCommerce</button>
  </div>
  <div class="filter-section" id="prod-sub-filter" style="display:none">
    <div class="filter-sep"></div>
    <span class="filter-label">View as</span>
    <div class="sub-toggle">
      <button class="sub-btn active" id="btn-prod-type" onclick="switchProductView('type')">By Product Type</button>
      <button class="sub-btn" id="btn-prod-carrier" onclick="switchProductView('carrier')">By Carrier</button>
    </div>
  </div>
</div>

<main>
  <div id="view-carrier">
    <div class="view-header">
      <span class="view-title">Showing all carriers — click a card to expand</span>
      <a class="csv-btn" href="${carrierCsvUri}" download="carrier-restrictions-by-carrier-${dateStamp}.csv">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download CSV
      </a>
    </div>
    <div class="carrier-grid" id="carrier-grid">
${cardHtml}
    </div>
    <div class="empty hidden" id="carrier-empty"><strong>No carriers match your filters.</strong>Try broadening your search.</div>
  </div>
  <div id="view-country" style="display:none">
    <div class="view-header">
      <span class="view-title">Sorted by most carriers not shipping — click a country to expand</span>
      <a class="csv-btn" href="${countryCsvUri}" download="carrier-restrictions-by-country-${dateStamp}.csv">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download CSV
      </a>
    </div>
    <div class="country-list" id="country-list">
${countryHtml}
    </div>
    <div class="empty hidden" id="country-empty"><strong>No countries match your filters.</strong>Try broadening your search.</div>
  </div>
  <div id="view-product" style="display:none">
    <div class="view-header">
      <span class="view-title" id="prod-view-title">Products carriers restrict or prohibit — sorted by severity, click to expand</span>
      <a class="csv-btn" href="${productCsvUri}" download="carrier-restrictions-by-product-${dateStamp}.csv">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download CSV
      </a>
    </div>
    <div id="prod-view-type">
      <div class="product-list" id="product-list">
${productHtml}
      </div>
      <div class="empty hidden" id="product-empty"><strong>No products match your filters.</strong>Try broadening your search.</div>
    </div>
    <div id="prod-view-carrier" style="display:none">
      <div class="carrier-grid" id="prod-carrier-grid">
${productCarrierHtml}
      </div>
      <div class="empty hidden" id="prod-carrier-empty"><strong>No carriers match your filters.</strong>Try broadening your search.</div>
    </div>
  </div>
</main>

<footer>
  Generated ${genAt} &nbsp;&bull;&nbsp;
  Data sourced from official carrier service pages. Verify at carrier links before making shipping decisions.
  <br>Sanctions based on OFAC, EU, UN, and national lists current at scan time.
</footer>

<script>
var currentView    = "carrier";
var productSubView = "type";
var typeFilter     = "all";
var catFilter      = "all";
var ptypeFilter    = "all";
var searchQuery    = "";
var carrierFilter  = "";
var countryFilter  = "";

function switchView(v) {
  currentView = v;
  document.getElementById("view-carrier").style.display = v === "carrier" ? "" : "none";
  document.getElementById("view-country").style.display = v === "country" ? "" : "none";
  document.getElementById("view-product").style.display = v === "product" ? "" : "none";
  document.getElementById("btn-carrier").classList.toggle("active", v === "carrier");
  document.getElementById("btn-country").classList.toggle("active", v === "country");
  document.getElementById("btn-product").classList.toggle("active", v === "product");
  document.getElementById("type-filter-main").style.display    = v === "product" ? "none" : "";
  document.getElementById("type-filter-product").style.display = v === "product" ? "" : "none";
  document.getElementById("prod-sub-filter").style.display     = v === "product" ? "" : "none";
  document.getElementById("carrier-select-wrap").style.display = v === "carrier" ? "" : "none";
  document.getElementById("country-select-wrap").style.display = v === "country" ? "" : "none";
  // Reset dropdowns on tab switch
  var cs = document.getElementById("carrier-select");
  var cns = document.getElementById("country-select");
  if (cs)  { cs.value  = ""; carrierFilter = ""; }
  if (cns) { cns.value = ""; countryFilter = ""; }
  applyFilters();
}

function switchProductView(v) {
  productSubView = v;
  document.getElementById("prod-view-type").style.display    = v === "type"    ? "" : "none";
  document.getElementById("prod-view-carrier").style.display = v === "carrier" ? "" : "none";
  document.getElementById("btn-prod-type").classList.toggle("active", v === "type");
  document.getElementById("btn-prod-carrier").classList.toggle("active", v === "carrier");
  var title = document.getElementById("prod-view-title");
  if (title) title.textContent = v === "type"
    ? "Products carriers restrict or prohibit — sorted by severity, click to expand"
    : "Product restrictions by carrier — filtered by category and type";
  applyFilters();
}

function toggleMore(btn, extra) {
  var list = btn.previousElementSibling;
  var hidden = list.querySelectorAll(".ritem-hidden");
  var showing = hidden[0] && hidden[0].style.display !== "none";
  hidden.forEach(function(el) { el.style.display = showing ? "none" : ""; });
  btn.textContent = showing ? "Show " + extra + " more..." : "Show less";
}

function toggleCountry(hd) {
  var body = hd.nextElementSibling;
  var chev = hd.querySelector(".chev");
  body.classList.toggle("open");
  chev.classList.toggle("open");
}

function toggleProduct(hd) {
  var body = hd.nextElementSibling;
  var chev = hd.querySelector(".chev");
  body.classList.toggle("open");
  chev.classList.toggle("open");
}

function applyFilters() {
  var q = searchQuery.toLowerCase();

  if (currentView === "carrier") {
    var cards = document.querySelectorAll("#carrier-grid .carrier-card");
    var visible = 0;
    cards.forEach(function(card) {
      var catOk  = catFilter === "all" || card.dataset.cat === catFilter;
      var typeOk = typeFilter === "all" || card.dataset.types.indexOf(typeFilter) !== -1;
      var name   = card.querySelector(".carrier-name").textContent.toLowerCase();
      var full   = card.querySelector(".carrier-full").textContent.toLowerCase();
      var items  = card.querySelectorAll(".ritem");

      // Filter individual restriction rows by type when type filter is active
      if (typeFilter !== "all") {
        items.forEach(function(item) {
          item.classList.toggle("hidden", item.dataset.type !== typeFilter);
        });
      } else {
        items.forEach(function(item) { item.classList.remove("hidden"); });
      }

      // Restore hidden "show more" items visibility when filtering
      card.querySelectorAll(".ritem-hidden").forEach(function(el) {
        if (typeFilter !== "all" && el.dataset.type !== typeFilter) {
          el.classList.add("hidden");
        }
      });

      var searchOk   = !q || name.includes(q) || full.includes(q) ||
        Array.from(items).some(function(li) { return li.textContent.toLowerCase().includes(q); });
      var carrierOk  = !carrierFilter || card.dataset.id === carrierFilter;

      var show = catOk && typeOk && searchOk && carrierOk;
      card.classList.toggle("hidden", !show);
      if (show) visible++;
    });
    document.getElementById("carrier-empty").classList.toggle("hidden", visible > 0);
    document.getElementById("carrier-grid").style.display = visible > 0 ? "" : "none";

  } else if (currentView === "country") {
    var rows = document.querySelectorAll(".crow");
    var visible2 = 0;
    rows.forEach(function(row) {
      var catOk  = catFilter === "all" || row.dataset.cats.indexOf(catFilter) !== -1;
      var typeOk = typeFilter === "all" || row.dataset.types.indexOf(typeFilter) !== -1;
      var text      = row.textContent.toLowerCase();
      var searchOk  = !q || text.includes(q);
      var countryOk = !countryFilter || row.dataset.country === countryFilter;
      var show = catOk && typeOk && searchOk && countryOk;
      row.classList.toggle("hidden", !show);
      if (show) visible2++;
    });
    document.getElementById("country-empty").classList.toggle("hidden", visible2 > 0);
    document.getElementById("country-list").style.display = visible2 > 0 ? "" : "none";

  } else {
    if (productSubView === "type") {
      var prows = document.querySelectorAll(".prow");
      var visible3 = 0;
      prows.forEach(function(row) {
        var ptypeOk  = ptypeFilter === "all" || row.dataset.ptypes.indexOf(ptypeFilter) !== -1;
        var text     = row.textContent.toLowerCase();
        var searchOk = !q || text.includes(q);
        var show = ptypeOk && searchOk;
        row.classList.toggle("hidden", !show);
        if (show) visible3++;
      });
      document.getElementById("product-empty").classList.toggle("hidden", visible3 > 0);
      document.getElementById("product-list").style.display = visible3 > 0 ? "" : "none";

    } else {
      var pcards = document.querySelectorAll("#prod-carrier-grid .prod-carrier-card");
      var visible4 = 0;
      pcards.forEach(function(card) {
        var catOk   = catFilter === "all" || card.dataset.cat === catFilter;
        var ptypeOk = ptypeFilter === "all" || card.dataset.ptypes.indexOf(ptypeFilter) !== -1;
        var name    = card.querySelector(".carrier-name").textContent.toLowerCase();
        var full    = card.querySelector(".carrier-full").textContent.toLowerCase();
        var items   = card.querySelectorAll(".ritem");

        if (ptypeFilter !== "all") {
          items.forEach(function(item) {
            item.classList.toggle("hidden", item.dataset.ptype !== ptypeFilter);
          });
        } else {
          items.forEach(function(item) { item.classList.remove("hidden"); });
        }

        var searchOk = !q || name.includes(q) || full.includes(q) ||
          Array.from(items).some(function(li) { return li.textContent.toLowerCase().includes(q); });

        var show = catOk && ptypeOk && searchOk;
        card.classList.toggle("hidden", !show);
        if (show) visible4++;
      });
      document.getElementById("prod-carrier-empty").classList.toggle("hidden", visible4 > 0);
      document.getElementById("prod-carrier-grid").style.display = visible4 > 0 ? "" : "none";
    }
  }
}

// Dark mode
(function() {
  var btn = document.getElementById("dark-toggle");
  function setDark(on) {
    document.body.classList.toggle("dark", on);
    btn.textContent = on ? "☀️" : "🌙";
    try { localStorage.setItem("dark", on ? "1" : "0"); } catch(e) {}
  }
  try { if (localStorage.getItem("dark") === "1") setDark(true); } catch(e) {}
  btn.addEventListener("click", function() { setDark(!document.body.classList.contains("dark")); });
})();

// Wire up controls
document.getElementById("search").addEventListener("input", function(e) {
  searchQuery = e.target.value.trim();
  applyFilters();
});

document.querySelectorAll("[data-type]").forEach(function(btn) {
  btn.addEventListener("click", function() {
    typeFilter = btn.dataset.type;
    document.querySelectorAll("[data-type]").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    applyFilters();
  });
});

document.querySelectorAll("[data-cat]").forEach(function(btn) {
  btn.addEventListener("click", function() {
    catFilter = btn.dataset.cat;
    document.querySelectorAll("[data-cat]").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    applyFilters();
  });
});

document.querySelectorAll("[data-ptype]").forEach(function(btn) {
  btn.addEventListener("click", function() {
    ptypeFilter = btn.dataset.ptype;
    document.querySelectorAll("[data-ptype]").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    applyFilters();
  });
});

document.getElementById("carrier-select").addEventListener("change", function() {
  carrierFilter = this.value;
  applyFilters();
});

document.getElementById("country-select").addEventListener("change", function() {
  countryFilter = this.value;
  if (countryFilter) {
    // Auto-expand the matching row
    document.querySelectorAll(".crow").forEach(function(row) {
      if (row.dataset.country === countryFilter) {
        var bd = row.querySelector(".crow-bd");
        var chev = row.querySelector(".chev");
        if (bd && !bd.classList.contains("open")) { bd.classList.add("open"); chev && chev.classList.add("open"); }
      }
    });
  }
  applyFilters();
});
</script>
</body>
</html>`;

  writeFileSync(OUTPUT, html, "utf-8");
  console.log(`\nDashboard written to: ${OUTPUT}`);
}


// ── Main ───────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("Carrier Restriction Scanner");
console.log(`Started: ${new Date().toLocaleString()}`);
console.log("=".repeat(60));

console.log("\n[Live scrape attempts]");
await runScrapers();

console.log("\n[Generating dashboard]");
generateDashboard();

const liveCount = CARRIERS.filter(c => c.live).length;
console.log(`Live scraped : ${liveCount} / ${CARRIERS.length} carriers`);
console.log(`Known data   : ${CARRIERS.length - liveCount} / ${CARRIERS.length} carriers`);
console.log("\nDone. Open dashboard.html in your browser.");
