// EcoTrack — monthly carbon footprint calculator (kg CO2e / month)
// Hash routing, wizard, corrected emission engine, results dashboard, recommendations.

"use strict";

// ---------------------- State ----------------------
const STORAGE_KEY = "ecoTrack_v1";// string datatype 
let appState = {
  assessment: { transport: null, electricity: null, waste: null },
  results: null,// null datatype is used , initially results is null, will be updated after assessment
};

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try { appState = JSON.parse(saved); } catch (e) { console.warn("Failed to parse EcoTrack state", e); }
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}
loadState();

// ---------------------- Design tokens (mirror of styles.css :root) ----------------------
function themeColor(varName, fallback) {
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return val || fallback;
  } catch (e) {
    return fallback;
  }
}
const CAT_VAR = { Transport: "--color-cat-transport", Electricity: "--color-cat-electricity", Waste: "--color-cat-waste" };
const CAT_HEX = { Transport: "#EF6351", Electricity: "#F5A524", Waste: "#0F9D6E" };
const BODY_FONT = "'IBM Plex Sans', sans-serif";
const DISPLAY_FONT = "'Space Grotesk', sans-serif";

// ---------------------- Emission engine constants (sourced, named) ----------------------
// Every factor is a named constant with its source citation. No unexplained magic numbers.

// Transport — kg CO2e per km, per VEHICLE (divide by occupancy for shared trips).
// Source: UK DEFRA/BEIS GHG Conversion Factors (2022), average-car / average-motorbike figures.
// number datatype

// const keyword is used extermenly as a variable is not going to be reassigned, it is a constant value
const TRANSPORT_PETROL = 0.170;    // average car, petrol
const TRANSPORT_DIESEL = 0.168;    // average car, diesel
const TRANSPORT_CNG = 0.115;       // CNG car (DEFRA-derived / IPCC fuel-based estimate)
const TRANSPORT_ELECTRIC = 0.053;  // EV (grid-dependent)
const TRANSPORT_MOTORBIKE = 0.103; // motorcycle / scooter
const TRANSPORT_BUS = 0.105;       // local bus, average occupancy
const TRANSPORT_RAIL = 0.041;      // national rail / metro, average occupancy
const TRANSPORT_ZERO = 0;          // bicycle / walking

const TRANSPORT_FACTORS = {
  car: { petrol: TRANSPORT_PETROL, diesel: TRANSPORT_DIESEL, cng: TRANSPORT_CNG, electric: TRANSPORT_ELECTRIC },
  bike: { petrol: TRANSPORT_MOTORBIKE, electric: TRANSPORT_ELECTRIC },
  bus: { diesel: TRANSPORT_BUS, cng: TRANSPORT_BUS, electric: TRANSPORT_BUS },
  train: { diesel: TRANSPORT_RAIL, electric: TRANSPORT_RAIL },
  metro: { electricity: TRANSPORT_RAIL },
  bicycle: { none: TRANSPORT_ZERO },
  walking: { none: TRANSPORT_ZERO },
};

// Electricity — kg CO2e per kWh.
// Source: India CEA (Central Electricity Authority) CO2 Baseline Database, most recent
// published all-India average grid emission factor = 0.82 kg CO2e/kWh.
// Region-specific: swap this constant for the target market's published grid factor
// (e.g. US EPA eGRID ≈ 0.386 kg CO2e/kWh) — it MUST be labeled with the region it applies to.
const GRID_FACTOR_KG_PER_KWH = 0.82;

// Renewable adjustment: a renewable source displaces grid draw; the residual 10% accounts for
// backup / grid-tied consumption. ESTIMATION ASSUMPTION, not a hard published fact.
const RENEWABLE_MULTIPLIER = 0.10;

// Waste — kg CO2e per kg of mixed municipal solid waste landfilled.
// Source: US EPA WARM (Waste Reduction Model), national average, mixed MSW to landfill.
const LANDFILL_FACTOR_KG_PER_KG = 0.52;

// Recycling adjustment: ~40% reduction vs landfill for mixed recyclables.
// APPROXIMATION of EPA WARM's recycling-vs-landfill delta, not an exact per-material calc.
const RECYCLE_MULTIPLIER = 0.60;

// Waste tiers → kg/day (approximate individual daily waste generation).
// Source: World Bank "What a Waste 2.0" urban per-capita averages. [Low, Medium, High]
const WASTE_TIER_DAILY_KG = [0.5, 1.0, 2.0];

const WEEKS_PER_MONTH = 4.33;   // transport formula constant (weeks/month)
const DAYS_PER_MONTH = 30;      // waste formula constant (days/month)
const TREE_KG_PER_YR = 21;      // kg CO2 absorbed by one mature tree per year (widely cited average)

// ---------- Fixed benchmark ("average individual lifestyle footprint") ----------
// Hardcoded, NEVER recalculated from session state. Assembled from the same category logic
// at typical input values (typical commute, typical household electricity share, typical waste
// tier) — NOT a national per-capita total (which includes industrial/government emissions and
// isn't comparable to a personal lifestyle calculator).
const BENCHMARK = Object.freeze({
  transport: 55,     // typical ~15 km/day commute, petrol car, shared occasionally
  electricity: 45,   // typical household electricity share per person
  waste: 8,          // typical waste tier with some recycling
  total: 108,        // 55 + 45 + 8
});

// Average home electricity for the "months of average home electricity" comparison.
// ≈240 kWh/month per household is a mid-range urban residential average (regional estimate),
// × grid factor = kg CO2e/month for a household. Uses the same sourced grid factor as the user calc.
const AVG_HOME_KWH_PER_MONTH = 240;
const AVG_HOME_ELEC_MONTHLY = AVG_HOME_KWH_PER_MONTH * GRID_FACTOR_KG_PER_KWH;

// ---------------------- Utilities ----------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function fmt(n, d = 0) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function setAppHtml(html) {
  const app = document.getElementById("app");
  app.innerHTML = html;
  app.classList.remove("page-enter");
  void app.offsetWidth;
  app.classList.add("page-enter");
}
function devWarn(message) {
  console.error("[EcoTrack dev warning]", message);
  const app = document.getElementById("app");
  if (app) {
    const div = document.createElement("div");
    div.setAttribute("role", "alert");
    div.style.cssText = "background:#FDECEC;color:#B91C1C;border:1px solid #F5B5B5;border-radius:12px;padding:0.75rem 1rem;margin:0.75rem auto;max-width:1200px;font-size:0.85rem;";
    div.textContent = "[dev] " + message;
    app.prepend(div);
  }
}

function icon(name, size = 20) {
  const paths = {
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    gauge: '<path d="M5 17a8 8 0 0 1 14 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1" fill="currentColor" stroke="none"/>',
    trendDown: '<path d="M7 7l10 10"/><path d="M17 8v9H8"/>',
    trendUp: '<path d="M7 17l10-10"/><path d="M17 16V7H8"/>',
    car: '<path d="M5 16l1.5-4.5A2 2 0 0 1 8.4 10h7.2a2 2 0 0 1 1.9 1.5L19 16"/><rect x="3" y="16" width="18" height="5" rx="2"/><circle cx="7.5" cy="19.5" r="1.5"/><circle cx="16.5" cy="19.5" r="1.5"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    tree: '<path d="M12 22v-4"/><path d="M12 18c-3 0-5.5-2.5-5.5-5.5S9 7 12 7s5.5 3 5.5 5.5S15 18 12 18Z"/><path d="M9.5 9.5a3.2 3.2 0 0 1 2.5-4 3.2 3.2 0 0 1 2.5 4"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/>',
    calculator: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 11h.01"/><path d="M12 11h.01"/><path d="M16 11h.01"/><path d="M8 15h.01"/><path d="M12 15h.01"/><path d="M16 15h.01"/><path d="M8 19h.01"/><path d="M12 19h.01"/><path d="M16 19h.01"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17V9"/><path d="M13 17V5"/><path d="M18 17v-3"/>',
    check: '<path d="m5 12 5 5 9-11"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    sparkle: '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    dollar: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    flag: '<path d="M4 22V4c0-.55.45-1 1-1h15l-3 4 3 4H6"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    layers: '<path d="m12 2 8.5 4.5L12 11 3.5 6.5 12 2Z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 17.5 8.5 4.5 8.5-4.5"/>',
    recycle: '<path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5"/><path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12"/><path d="m14 16-3 3 3 3"/><path d="M8.293 13.596 7.196 9.5 3.1 10.598"/><path d="m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>',
    wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    report: '<path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18l-4-2-2 2-2-2-4 2z"/>',
    mountain: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
    fuel: '<path d="M3 22h12"/><path d="M4 22V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M14 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"/><path d="M9 8v3"/><path d="M7 22h6"/>',
    flask: '<path d="M10 2v6.5L4.42 18.5A2 2 0 0 0 6.21 22h11.58a2 2 0 0 0 1.79-3.5L14 8.5V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
    flame: '<path d="M12 2c1 3 3.5 4.5 3.5 8a3.5 3.5 0 0 1-7 0c0-1.2.5-2.2 1.2-3.2C8.5 9 6.5 11.6 6.5 14.5a5.5 5.5 0 0 0 11 0C17.5 9.6 14.5 5.5 12 2Z"/><path d="M12 22a2.5 2.5 0 0 0 2.5-2.5c0-1.6-2.5-3.5-2.5-3.5S9.5 17.9 9.5 19.5A2.5 2.5 0 0 0 12 22Z"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
}
const categoryIconName = (cat) => (cat === "Transport" ? "car" : cat === "Electricity" ? "bolt" : "trash");

// ---------------------- Scroll reveal + count-up ----------------------
let revealObserver = null;
function observeReveals(root) {
  const els = root.querySelectorAll(".reveal");
  if (!els.length) return;
  if (typeof IntersectionObserver === "undefined") {
    els.forEach((el) => el.classList.add("visible"));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("visible"); revealObserver.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
  }
  els.forEach((el) => revealObserver.observe(el));
}

function animateCountUp(el, target, decimals) {
  const start = performance.now();
  const dur = 800;
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * eased, decimals);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function initCountUps(root) {
  const els = root.querySelectorAll("[data-countup-target]");
  if (!els.length) return;
  const finish = (el) => {
    const target = parseFloat(el.dataset.countupTarget);
    const dec = parseInt(el.dataset.decimals || "0", 10);
    el.textContent = fmt(target, dec);
  };
  if (typeof IntersectionObserver === "undefined") { els.forEach(finish); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const el = en.target;
      const target = parseFloat(el.dataset.countupTarget);
      const dec = parseInt(el.dataset.decimals || "0", 10);
      animateCountUp(el, target, dec);
      io.unobserve(el);
    });
  }, { threshold: 0.3 });
  els.forEach((el) => io.observe(el));
}

// ---------------------- Micro interactions ----------------------
// Button ripple
function initRipple(root) {
  root.querySelectorAll(".btn").forEach((btn) => {
    if (btn.classList.contains("ripple-host")) return;
    btn.classList.add("ripple-host");
    btn.addEventListener("click", (e) => {
      const rect = btn.getBoundingClientRect();
      const d = Math.max(rect.width, rect.height) * 2.2;
      const span = document.createElement("span");
      span.className = "ripple";
      span.style.width = span.style.height = d + "px";
      span.style.left = (e.clientX - rect.left - d / 2) + "px";
      span.style.top = (e.clientY - rect.top - d / 2) + "px";
      btn.appendChild(span);
      setTimeout(() => span.remove(), 620);
    });
  });
}

// Floating labels (inputs via :placeholder-shown, selects via .has-value)
function initFloatingLabels(root) {
  root.querySelectorAll(".fl-input").forEach((input) => {
    const field = input.closest(".fl-field");
    if (!field) return;
    const sync = () => field.classList.toggle("has-value", input.value !== "");
    sync();
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });
}

// Grade bar grow-on-load
function initGradeBar() {
  const bar = document.querySelector(".grade-bar");
  if (!bar) return;
  const w = bar.dataset.width || "0";
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = w + "%"; }));
}

// Timeline scroll-progress fill
let tlRAF = null;
function initTimelineFill() {
  const update = () => {
    const tl = document.querySelector(".timeline");
    const fill = document.getElementById("tl-fill");
    if (!tl || !fill) return;
    const rect = tl.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top > vh || rect.bottom < 0) return;
    const total = Math.max(rect.height - vh * 0.55, 1);
    const passed = Math.min(Math.max(vh * 0.62 - rect.top, 0), total);
    fill.style.height = (passed / total) * 100 + "%";
  };
  const loop = () => {
    update();
    if (document.querySelector(".timeline")) tlRAF = requestAnimationFrame(loop);
  };
  if (tlRAF) cancelAnimationFrame(tlRAF);
  tlRAF = requestAnimationFrame(loop);
}

// Run every page render
function initPageEffects(root) {
  observeReveals(root);
  initCountUps(root);
  initRipple(root);
  initFloatingLabels(root);
}

// Navbar glassmorphism on scroll
const navbar = document.getElementById("navbar");
if (navbar) {
  const onNavScroll = () => navbar.classList.toggle("scrolled", window.scrollY > 30);
  window.addEventListener("scroll", onNavScroll, { passive: true });
  onNavScroll();
}

// ---------------------- Router ----------------------
const routes = {
  "#home": renderHome,
  "#about": renderAbout,
  "#how": renderHowItWorks,
  "#calculator": renderCalculator,
  "#result": renderDashboard,
  "#dashboard": () => { if (window.renderStreakDashboard) window.renderStreakDashboard(); },
  "#resources": renderResources,
  "#methodology": renderMethodology,
  "#contact": renderContact,
};
function router() {
  const hash = location.hash || "#home";
  const fn = routes[hash] || renderHome;
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === hash);
  });
  closeNav();
  fn();
}
window.addEventListener("hashchange", router);

// ---------------------- Nav toggle ----------------------
const navToggle = document.getElementById("nav-toggle");
const navLinksEl = document.getElementById("nav-links");
function closeNav() {
  if (navToggle) navToggle.setAttribute("aria-expanded", "false");
  if (navLinksEl) navLinksEl.classList.remove("open");
}
if (navToggle) {
  navToggle.addEventListener("click", () => {
    const open = navLinksEl.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
  });
}

const newsletterForm = document.getElementById("newsletter-form");
if (newsletterForm) {
  newsletterForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("newsletter-email");
    const value = input && input.value.trim();
    if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      input.focus();
      input.style.borderColor = "var(--color-danger)";
      setTimeout(() => { input.style.borderColor = ""; }, 1500);
      return;
    }
    newsletterForm.innerHTML =
      '<p style="display:inline-flex;align-items:center;gap:0.4rem;color:#2DBE8E;font-weight:600;">' + icon("checkCircle", 18) +
      ' Thanks — you\'re on the list! Watch your inbox for the first eco tip.</p>';
  });
}

function scrollTop() {
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
}

// ---------------------- Sections ----------------------
function tlStep(n, side, ic, title, desc) {
  const align = side === "center" ? "tl-center" : `tl-${side}`;
  const revealCls = side === "left" ? "reveal reveal-left" : side === "right" ? "reveal reveal-right" : "reveal reveal-scale";
  return `
  <div class="tl-step ${align} ${revealCls}">
    <div class="tl-node"><span>${n}</span></div>
    <div class="tl-card">
      <div class="tl-icon">${icon(ic, 22)}</div>
      <div class="tl-num">Step ${n}</div>
      <h3>${title}</h3>
      <p>${desc}</p>
    </div>
  </div>`;
}

async function renderHome() {
  const html = `
  <section class="hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
      <span class="leaf leaf-1" style="--rot:-18deg">${icon("leaf", 22)}</span>
      <span class="leaf leaf-2" style="--rot:24deg">${icon("leaf", 18)}</span>
      <span class="leaf leaf-3" style="--rot:12deg">${icon("leaf", 26)}</span>
      <span class="leaf leaf-4" style="--rot:-28deg">${icon("leaf", 16)}</span>
      <span class="particle p-1"></span><span class="particle p-2"></span>
      <span class="particle p-3"></span><span class="particle p-4"></span>
      <span class="particle p-5"></span>
    </div>
    <div class="container hero-inner">
      <div class="hero-copy">
        <span class="eyebrow reveal reveal-up">PCCoE Conservation Year 2026</span>
        <h1 class="reveal reveal-up" style="transition-delay:80ms">Know Where Your <span class="text-gradient">Energy Goes</span></h1>
        <p class="reveal reveal-up" style="transition-delay:160ms">EcoTrack breaks down your carbon footprint into a simple monthly number — in kg, not vague tonnes — and turns it into daily habits you can actually check.</p>
        <div class="cta-group reveal reveal-up" style="transition-delay:240ms">
          <a href="#calculator" class="btn btn-primary btn-lg">Calculate my footprint <span class="btn-arrow" aria-hidden="true">→</span></a>
          <a href="#resources" class="btn btn-ghost btn-lg">Learn about the initiative</a>
        </div>
        <div class="hero-trust reveal reveal-up" style="transition-delay:320ms">
          <span class="ht-item">${icon("shield", 16)} Private &amp; free</span>
          <span class="ht-item">${icon("clock", 16)} 60-second assessment</span>
          <span class="ht-item">${icon("checkCircle", 16)} Transparent methodology</span>
        </div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="hero-glow"></div>
        <div class="float-card fc-grade">
          <div class="fc-icon">${icon("trophy", 20)}</div>
          <div><div class="fc-value">Grade <b id="home-grade">?</b></div><div class="fc-label">Eco Grade</div></div>
        </div>
        <div class="float-card fc-saved">
          <div class="fc-icon">${icon("leaf", 20)}</div>
          <div><div class="fc-value"><span id="home-saved-monthly" data-countup-target="0">0</span> kg</div><div class="fc-label">CO₂e saved this month</div></div>
        </div>
        <div class="float-card fc-members">
          <div class="fc-icon">${icon("users", 20)}</div>
          <div><div class="fc-value"><span id="home-members-count-1" data-countup-target="0">0</span></div><div class="fc-label">Community members</div></div>
        </div>
        <div class="float-card fc-reduction">
          <div class="fc-icon">${icon("trendDown", 20)}</div>
          <div><div class="fc-value"><span id="home-reduction" data-countup-target="0">0</span>%</div><div class="fc-label">Monthly reduction</div></div>
        </div>
      </div>
    </div>
    <div class="container">
      <div class="impact-strip">
        <div class="impact-stat reveal reveal-up">
          <div class="impact-icon">${icon("tree", 22)}</div>
          <div class="impact-num" data-countup-target="4.6" data-decimals="1">0</div>
          <div class="impact-lbl">t CO₂e — average individual's yearly footprint</div>
        </div>
        <div class="impact-stat reveal reveal-up" style="transition-delay:90ms">
          <div class="impact-icon">${icon("trendDown", 22)}</div>
          <div class="impact-num" id="home-potential-reduction" data-countup-target="0">0</div>
          <div class="impact-lbl">% potential reduction with EcoTrack habits</div>
        </div>
        <div class="impact-stat reveal reveal-up" style="transition-delay:180ms">
          <div class="impact-icon">${icon("users", 22)}</div>
          <div class="impact-num" id="home-members-count-2" data-countup-target="0">0</div>
          <div class="impact-lbl">community members tracking this month</div>
        </div>
      </div>
    </div>
  </section>

  <section class="why-section section-alt">
    <div class="container">
      <div class="section-head reveal reveal-up">
        <span class="eyebrow">Why EcoTrack</span>
        <h2>More than just a number</h2>
        <p>Most calculators stop at a figure. EcoTrack explains it — and then keeps you moving.</p>
      </div>
      <div class="why-grid">
        <div class="why-card reveal reveal-up">
          <div class="why-icon">${icon("chart", 22)}</div>
          <h3>Most calculators stop at a number</h3>
          <p>They give you a static figure with no context.</p>
        </div>
        <div class="why-card reveal reveal-up" style="transition-delay:90ms">
          <div class="why-icon">${icon("sparkle", 22)}</div>
          <h3>EcoTrack explains it</h3>
          <p>We break down the result, compare to monthly averages and translate it into real‑world terms.</p>
        </div>
        <div class="why-card reveal reveal-up" style="transition-delay:180ms">
          <div class="why-icon">${icon("target", 22)}</div>
          <h3>Then keeps you moving</h3>
          <p>Daily goals, challenges and points turn habit‑forming into a game.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="timeline-section">
    <div class="container">
      <div class="section-head reveal reveal-up">
        <span class="eyebrow">How it works</span>
        <h2>From assessment to daily habit</h2>
        <p>Five steps from first assessment to lasting change.</p>
      </div>
      <div class="timeline">
        <div class="tl-line"><div class="tl-line-fill" id="tl-fill"></div></div>
        ${tlStep(1, "left", "clipboard", "Answer the assessment", "Transport, electricity and waste — about 60 seconds.")}
        ${tlStep(2, "right", "calculator", "Get a monthly number", "Your footprint in kg CO₂e per month, not a vague annual tonne figure.")}
        ${tlStep(3, "left", "chart", "Explore the breakdown", "See which category drives your footprint on one chart.")}
        ${tlStep(4, "right", "list", "Follow ranked recommendations", "Actions ranked by real monthly impact, based on your inputs.")}
        ${tlStep(5, "center", "star", "Track progress & earn points", "Daily challenges, streaks and badges keep the habit going.")}
      </div>
    </div>
  </section>

  <section class="cta-banner section-beige">
    <div class="container">
      <div class="cta-banner-inner">
        <div class="cta-bg" aria-hidden="true">
          <div class="blob blob-4"></div>
          <div class="blob blob-5"></div>
        </div>
        <h2 class="reveal reveal-up">Ready to see your number?</h2>
        <p class="reveal reveal-up" style="transition-delay:80ms">The calculator is quick, private and free.</p>
        <div class="reveal reveal-up" style="transition-delay:160ms">
          <a href="#calculator" class="btn btn-primary btn-lg">Start assessment <span class="btn-arrow" aria-hidden="true">→</span></a>
        </div>
      </div>
    </div>
  </section>
  `;
  setAppHtml(html);

  // Community figures come straight from the server, so they are real
  // and identical for everyone. Until the call resolves the tiles keep
  // the "0" placeholder already in the markup — no placeholder guesses.
  const community = window.EcoData ? await window.EcoData.getCommunityStats() : null;
  const membersCount = Number(community?.community_members) || 0;
  const savedMonthly = Number(community?.co2e_saved_this_month) || 0;

  const elMem1 = document.getElementById("home-members-count-1");
  const elMem2 = document.getElementById("home-members-count-2");
  const elSaved = document.getElementById("home-saved-monthly");
  if (elMem1) elMem1.setAttribute("data-countup-target", membersCount);
  if (elMem2) elMem2.setAttribute("data-countup-target", membersCount);
  if (elSaved) elSaved.setAttribute("data-countup-target", Number(savedMonthly.toFixed(1)));

  if (appState.results) {
    const gradeEl = document.getElementById("home-grade");
    const redEl = document.getElementById("home-reduction");
    const potRedEl = document.getElementById("home-potential-reduction");
    if (gradeEl) gradeEl.textContent = appState.results.grade;
    const reduction = Math.max(0, Math.round((appState.results.projected.saved / appState.results.totalKg) * 100)) || 0;
    if (redEl) redEl.setAttribute("data-countup-target", reduction);
    if (potRedEl) potRedEl.setAttribute("data-countup-target", reduction);
  }

  initPageEffects(document.getElementById("app"));
  initTimelineFill();
}

function renderAbout() {
  const html = `
  <section class="page-hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-3"></div>
      <span class="leaf leaf-1" style="--rot:-18deg">${icon("leaf", 22)}</span>
      <span class="leaf leaf-3" style="--rot:12deg">${icon("leaf", 26)}</span>
    </div>
    <div class="container">
      <span class="eyebrow reveal reveal-up">About EcoTrack</span>
      <h1 class="reveal reveal-up">About <span class="text-gradient">EcoTrack</span></h1>
      <p class="reveal reveal-up" style="transition-delay:90ms">Empowering everyday people to understand and reduce their carbon footprint through clear insights and gamified habits.</p>
    </div>
  </section>
  <section class="section-alt">
    <div class="container">
      <div class="about-grid">
        <div class="about-card reveal reveal-up">
          <div class="about-icon">${icon("leaf", 22)}</div>
          <h3>Our mission</h3>
          <p>Make climate action simple, measurable, and rewarding — starting with a monthly number you can actually sanity‑check.</p>
        </div>
        <div class="about-card reveal reveal-up" style="transition-delay:90ms">
          <div class="about-icon">${icon("globe", 22)}</div>
          <h3>Our promise</h3>
          <p>Every constant in our engine is named and sourced. No unexplained magic numbers, no black‑box scoring.</p>
        </div>
        <div class="about-card reveal reveal-up" style="transition-delay:180ms">
          <div class="about-icon">${icon("heart", 22)}</div>
          <h3>Why we exist</h3>
          <p>EcoTrack turns an abstract carbon number into daily habits, challenges and points that keep you moving.</p>
        </div>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
}

function renderHowItWorks() {
  const html = `
  <section class="page-hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
    </div>
    <div class="container">
      <span class="eyebrow reveal reveal-up">How it works</span>
      <h1 class="reveal reveal-up">How <span class="text-gradient">EcoTrack</span> works</h1>
      <p class="reveal reveal-up" style="transition-delay:90ms">One assessment, a real monthly number, and habits that stick.</p>
    </div>
  </section>
  <section class="timeline-section">
    <div class="container">
      <div class="timeline">
        <div class="tl-line"><div class="tl-line-fill" id="tl-fill"></div></div>
        ${tlStep(1, "left", "clipboard", "Complete the assessment", "A quick assessment of transport, electricity and waste.")}
        ${tlStep(2, "right", "calculator", "We compute your monthly footprint", "Our engine calculates your emissions in kg CO₂e per month and derives a Conservation Index.")}
        ${tlStep(3, "left", "chart", "Explore a visual dashboard", "Breakdowns and real‑world comparisons, all in monthly terms.")}
        ${tlStep(4, "right", "list", "Get personalized recommendations", "Ranked by impact and built from your actual inputs.")}
        ${tlStep(5, "center", "star", "Track progress", "Daily challenges, points, badges and levelling up.")}
      </div>
      <div style="text-align:center;">
        <a href="#calculator" class="btn btn-primary btn-lg reveal reveal-scale">Try the calculator <span class="btn-arrow" aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
  initTimelineFill();
}

function renderResources() {
  const html = `
  <section class="page-hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-3"></div>
    </div>
    <div class="container">
      <span class="eyebrow reveal reveal-up">Resources</span>
      <h1 class="reveal reveal-up">Conservation <span class="text-gradient">resources</span></h1>
      <p class="reveal reveal-up" style="transition-delay:90ms">Guides, FAQs and more — built on the same transparent numbers.</p>
    </div>
  </section>
  <section class="section-alt">
    <div class="container">
      <div class="resource-grid">
        <div class="resource-card reveal reveal-up">
          <div class="rs-icon">${icon("book", 22)}</div>
          <h3>Conservation guides</h3>
          <p>Practical, low‑friction ways to trim each of your footprint categories.</p>
        </div>
        <div class="resource-card reveal reveal-up" style="transition-delay:90ms">
          <div class="rs-icon">${icon("alertCircle", 22)}</div>
          <h3>FAQs</h3>
          <p>Answers to common questions about the calculator, grades and benchmarks.</p>
        </div>
        <div class="resource-card reveal reveal-up" style="transition-delay:180ms">
          <div class="rs-icon">${icon("mountain", 22)}</div>
          <h3>Coming soon</h3>
          <p>Community challenges and monthly impact reports for every member.</p>
        </div>
      </div>
      <div style="text-align:center;margin-top:2rem;">
        <a href="#methodology" class="btn btn-ghost btn-lg reveal reveal-up">See how our numbers are calculated</a>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
}

function renderMethodology() {
  const pct = (n) => `${Math.round(n * 100)}%`;
  const rows = [
    ["Petrol car", TRANSPORT_PETROL, "kg CO₂e/km", "DEFRA/BEIS GHG Conversion Factors (2022), average car"],
    ["Diesel car", TRANSPORT_DIESEL, "kg CO₂e/km", "DEFRA/BEIS GHG Conversion Factors (2022), average car"],
    ["CNG car", TRANSPORT_CNG, "kg CO₂e/km", "DEFRA/BEIS-derived / IPCC fuel-based estimate"],
    ["Electric car", TRANSPORT_ELECTRIC, "kg CO₂e/km", "EV, grid-dependent; DEFRA/BEIS 2022"],
    ["Motorbike", TRANSPORT_MOTORBIKE, "kg CO₂e/km", "DEFRA/BEIS 2022, average motorbike"],
    ["Bus", TRANSPORT_BUS, "kg CO₂e/km", "DEFRA/BEIS 2022, local bus average occupancy"],
    ["Rail / metro", TRANSPORT_RAIL, "kg CO₂e/km", "DEFRA/BEIS 2022, national rail average occupancy"],
    ["Cycling / walking", TRANSPORT_ZERO, "kg CO₂e/km", "Zero tailpipe / direct emissions"],
    ["Grid electricity", GRID_FACTOR_KG_PER_KWH, "kg CO₂e/kWh", "India CEA CO₂ Baseline Database — all-India average. Region-specific: swap for target market (e.g. US EPA eGRID ≈ 0.386)."],
    ["Waste to landfill", LANDFILL_FACTOR_KG_PER_KG, "kg CO₂e/kg", "US EPA WARM, national average, mixed MSW to landfill"],
  ];
  const formulas = [
    ["Transport", `distance (km/day) × days/week × ${WEEKS_PER_MONTH} (weeks/month) × factor (kg CO₂e/km) ÷ occupancy`],
    ["Electricity", `kWh/month × grid factor (${GRID_FACTOR_KG_PER_KWH} kg CO₂e/kWh) × renewable (${pct(RENEWABLE_MULTIPLIER)}) ÷ people in household`],
    ["Waste", `tier daily kg (${WASTE_TIER_DAILY_KG.map(k => k + " kg").join(" / ")}) × ${DAYS_PER_MONTH} days/month × landfill factor (${LANDFILL_FACTOR_KG_PER_KG}) × recycling (${pct(RECYCLE_MULTIPLIER)})`],
  ];
  const html = `
  <section class="page-hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
    </div>
    <div class="container">
      <span class="eyebrow reveal reveal-up">Methodology</span>
      <h1 class="reveal reveal-up">How the <span class="text-gradient">numbers work</span></h1>
      <p class="reveal reveal-up" style="transition-delay:90ms">EcoTrack computes each category from a pure formula with named, sourced constants. The three categories never influence each other — only the final monthly total sums them.</p>
    </div>
  </section>
  <section class="section-alt">
    <div class="container">
      <div class="meth-card reveal reveal-up">
        <h3>Formulas (kg CO₂e / month)</h3>
        ${formulas.map(([cat, f]) => `<p style="margin-top:0.6rem;"><strong>${cat}</strong><br><code>${f}</code></p>`).join("")}
      </div>

      <div class="meth-card reveal reveal-up">
        <h3>Constants &amp; sources</h3>
        <table class="meth-table">
          <thead><tr><th>Item</th><th>Value</th><th>Unit</th><th>Source</th></tr></thead>
          <tbody>${rows.map(([n, v, u, s]) => `<tr><td>${n}</td><td class="font-mono">${v}</td><td>${u}</td><td>${s}</td></tr>`).join("")}</tbody>
        </table>
        <p style="margin-top:0.8rem;"><strong>Adjustments (labelled assumptions):</strong> renewable energy applies a ${pct(RENEWABLE_MULTIPLIER)} residual multiplier (backup/grid-tied draw); recycling applies a ${pct(RECYCLE_MULTIPLIER)} multiplier vs landfill.</p>
      </div>

      <div class="meth-card reveal reveal-up">
        <h3>The benchmark (fixed, never derived from your session)</h3>
        <p>The Conservation Index and Grade compare your total against this hardcoded benchmark of a typical individual lifestyle. It is assembled from the same category logic at typical inputs, <strong>not</strong> a national per-capita total (those include industrial/government emissions and aren't comparable).</p>
        <table class="meth-table">
          <thead><tr><th>Category</th><th>Benchmark (kg CO₂e / month)</th></tr></thead>
          <tbody>
            <tr><td>Transport</td><td class="font-mono">${BENCHMARK.transport}</td></tr>
            <tr><td>Electricity</td><td class="font-mono">${BENCHMARK.electricity}</td></tr>
            <tr><td>Waste</td><td class="font-mono">${BENCHMARK.waste}</td></tr>
            <tr><td><strong>Total</strong></td><td class="font-mono"><strong>${BENCHMARK.total}</strong></td></tr>
          </tbody>
        </table>
        <p style="margin-top:0.8rem;">Conservation Index = 100 ÷ (1 + your total ÷ benchmark total) — a continuous 0–100 curve: 100 only at zero emissions, 50 at exactly the benchmark, approaching 0 as emissions grow, never flatlining. vs-benchmark% = (your total ÷ benchmark total − 1) × 100 — intentionally unbounded (can show +900%). The two always agree on <strong>direction</strong> (not magnitude): above 50 / positive = worse than benchmark, below 50 / negative = better. Grade bands (off the same index): A ≥ 70, B ≥ 55, C ≥ 40, D ≥ 20, else F.</p>
      </div>

      <p style="margin-top:1.5rem;text-align:center;"><a href="#resources" class="btn btn-ghost">← Back to Resources</a></p>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
}

function renderContact() {
  const html = `
  <section class="page-hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-3"></div>
    </div>
    <div class="container">
      <span class="eyebrow reveal reveal-up">Contact</span>
      <h1 class="reveal reveal-up">Get in <span class="text-gradient">touch</span></h1>
      <p class="reveal reveal-up" style="transition-delay:90ms">Questions, feedback or partnerships — we'd love to hear from you.</p>
    </div>
  </section>
  <section class="section-alt">
    <div class="container">
      <div class="contact-grid">
        <div class="contact-card reveal reveal-up">
          <div class="ct-icon">${icon("mail", 22)}</div>
          <div>
            <h3>Email</h3>
            <p><a href="mailto:info@ecotrack.org">info@ecotrack.org</a></p>
          </div>
        </div>
        <div class="contact-card reveal reveal-up" style="transition-delay:90ms">
          <div class="ct-icon">${icon("phone", 22)}</div>
          <div>
            <h3>Phone</h3>
            <p>+1 (555) 123‑4567</p>
          </div>
        </div>
        <div class="contact-card reveal reveal-up" style="transition-delay:180ms">
          <div class="ct-icon">${icon("clock", 22)}</div>
          <div>
            <h3>Response time</h3>
            <p>We usually reply within one business day.</p>
          </div>
        </div>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
}

// ---------------------- Calculator wizard ----------------------
const wizard = { step: 0, dir: "forward" };

const STEP_META = [
  { name: "Transport", icon: "car", tip: "Real distances beat estimates — check a route you take often for a more accurate result." },
  { name: "Electricity", icon: "bolt", tip: "Your monthly bill shows kWh used — that's the number that matters most here." },
  { name: "Waste", icon: "trash", tip: "If in doubt, pick Medium. Recycling can cut your waste line by up to 40%." },
];

async function renderCalculator() {
  // ---- Auth guard (added): starting an assessment requires login. ----
  if (typeof window.ecoTrackRequireLogin === "function" && !window.ecoTrackRequireLogin()) return;

  wizard.step = 0;
  const html = `
  <section class="calc-section">
    <div class="calc-bg" aria-hidden="true">
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
      <span class="leaf leaf-1" style="--rot:-18deg">${icon("leaf", 22)}</span>
      <span class="leaf leaf-3" style="--rot:12deg">${icon("leaf", 26)}</span>
      <span class="particle p-1"></span><span class="particle p-4"></span>
    </div>
    <div class="container">
      <div class="section-head reveal reveal-up">
        <span class="eyebrow">Calculator</span>
        <h1>Calculate your <span class="text-gradient">footprint</span></h1>
        <p>Three quick steps. Private, free and honest about its sources.</p>
      </div>
      <div class="calc-shell">
        <aside class="calc-sidebar">
          <div class="calc-progress-card reveal reveal-left">
            <div class="cp-head">
              <span class="cp-step-label">Step <b id="calc-step-num">1</b> · <span id="calc-step-name">Transport</span></span>
              <span class="cp-percent" id="calc-percent">0%</span>
            </div>
            <div class="cp-track"><div class="cp-fill" id="calc-progress-fill"></div></div>
            <ol class="steps" aria-label="Progress">
              <li class="step"><span class="step-dot">1</span>Transport</li>
              <li class="step"><span class="step-dot">2</span>Electricity</li>
              <li class="step"><span class="step-dot">3</span>Waste</li>
            </ol>
            <div class="cp-remaining" id="calc-remaining">2 steps remaining</div>
            <div class="cp-tip">
              <div class="cp-tip-title">${icon("bulb", 16)} Helpful tip</div>
              <p id="calc-tip">${STEP_META[0].tip}</p>
            </div>
            <div class="cp-preview">
              <div class="cp-preview-title">Estimated footprint so far</div>
              <div class="cp-preview-value" id="calc-preview-value">—</div>
              <div class="cp-preview-note">kg CO₂e / month</div>
            </div>
          </div>
        </aside>
        <div class="calc-main">
          <div id="wizard-step" class="step-view"></div>
        </div>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
  showStep();
}

function updateSteps() {
  document.querySelectorAll(".step").forEach((li, i) => {
    li.classList.toggle("done", i < wizard.step);
    li.classList.toggle("active", i === wizard.step);
  });
  const meta = STEP_META[wizard.step];
  const num = document.getElementById("calc-step-num");
  const name = document.getElementById("calc-step-name");
  const pct = document.getElementById("calc-percent");
  const fill = document.getElementById("calc-progress-fill");
  const remaining = document.getElementById("calc-remaining");
  const tip = document.getElementById("calc-tip");
  if (num) num.textContent = wizard.step + 1;
  if (name && meta) name.textContent = meta.name;
  const p = Math.round((wizard.step / 2) * 100);
  if (pct) pct.textContent = p + "%";
  if (fill) fill.style.width = p + "%";
  if (remaining) remaining.textContent = wizard.step === 2 ? "Final step" : `${2 - wizard.step} step${2 - wizard.step === 1 ? "" : "s"} remaining`;
  if (tip && meta) tip.textContent = meta.tip;
  updatePreview();
}

function updatePreview() {
  const el = document.getElementById("calc-preview-value");
  if (!el) return;
  const a = appState.assessment;
  let total = 0, any = false;
  if (a.transport) { total += transportMonthly(a.transport); any = true; }
  if (a.electricity) { total += electricityMonthly(a.electricity); any = true; }
  if (a.waste) { total += wasteMonthly(a.waste); any = true; }
  el.textContent = any ? fmt(total, 1) : "—";
}

function showStep() {
  const el = document.getElementById("wizard-step");
  if (!el) return;
  el.classList.remove("forward", "back");
  void el.offsetWidth;
  el.classList.add(wizard.dir);
  el.innerHTML = stepHtml(wizard.step);
  updateSteps();
  bindStep(wizard.step);
  initFloatingLabels(el);
}

function stepHtml(step) {
  const backBtn = step > 0
    ? `<button type="button" class="btn-back" data-back>${icon("arrowLeft", 16)} Back to ${step === 1 ? "Transport" : "Electricity"}</button>`
    : `<span></span>`;
  const nextLabel = step === 2 ? "Calculate" : `Next: ${step === 0 ? "Electricity" : "Waste"}`;

  const fields = step === 0 ? `
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("car", 18)}</div>
          <select class="fl-input" id="usage" name="usage" required onchange="
            const modeSel = document.getElementById('mode');
            modeSel.innerHTML = '<option value=\\'\\' selected disabled></option>';
            if(this.value === 'private') {
              modeSel.innerHTML += '<option value=\\'car\\'>Car</option><option value=\\'bike\\'>Motorbike</option><option value=\\'bicycle\\'>Bicycle</option><option value=\\'walking\\'>Walking</option>';
            } else if(this.value === 'public') {
              modeSel.innerHTML += '<option value=\\'bus\\'>Bus</option><option value=\\'train\\'>Train</option><option value=\\'metro\\'>Metro</option>';
            }
            modeSel.value = '';
            document.getElementById('fuel').innerHTML = '<option value=\\'\\' selected disabled></option>';
            document.getElementById('fuel').closest('.field').style.display = 'none';
          ">
            <option value="" selected disabled></option>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          <label class="fl-label" for="usage">How do you usually travel?</label>
        </div>
        <p class="field-error">Please choose Private or Public.</p>
      </div>
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("car", 18)}</div>
          <select class="fl-input" id="mode" name="mode" required onchange="
            const fuelSel = document.getElementById('fuel');
            const fuelWrap = fuelSel.closest('.field');
            fuelSel.innerHTML = '<option value=\\'\\' selected disabled></option>';
            if(['car'].includes(this.value)) {
              fuelSel.innerHTML += '<option value=\\'petrol\\'>Petrol</option><option value=\\'diesel\\'>Diesel</option><option value=\\'cng\\'>CNG</option><option value=\\'electric\\'>Electric</option>';
              fuelWrap.style.display = 'block';
              fuelSel.required = true;
            } else if(['bike'].includes(this.value)) {
              fuelSel.innerHTML += '<option value=\\'petrol\\'>Petrol</option><option value=\\'electric\\'>Electric</option>';
              fuelWrap.style.display = 'block';
              fuelSel.required = true;
            } else if(['bus'].includes(this.value)) {
              fuelSel.innerHTML += '<option value=\\'diesel\\'>Diesel</option><option value=\\'cng\\'>CNG</option><option value=\\'electric\\'>Electric</option>';
              fuelWrap.style.display = 'block';
              fuelSel.required = true;
            } else if(['train'].includes(this.value)) {
              fuelSel.innerHTML += '<option value=\\'diesel\\'>Diesel</option><option value=\\'electric\\'>Electric</option>';
              fuelWrap.style.display = 'block';
              fuelSel.required = true;
            } else if(['metro'].includes(this.value)) {
              fuelSel.innerHTML += '<option value=\\'electricity\\'>Electricity</option>';
              fuelWrap.style.display = 'block';
              fuelSel.required = true;
            } else {
              fuelSel.innerHTML += '<option value=\\'none\\' selected>No Fuel</option>';
              fuelWrap.style.display = 'none';
              fuelSel.required = false;
            }
          ">
            <option value="" selected disabled></option>
          </select>
          <label class="fl-label" for="mode">Mode of transport</label>
        </div>
        <p class="field-error">Please choose a mode.</p>
      </div>
      <div class="field" style="display: none;">
        <div class="fl-field select">
          <div class="fl-icon">${icon("fuel", 18)}</div>
          <select class="fl-input" id="fuel" name="fuel">
            <option value="" selected disabled></option>
          </select>
          <label class="fl-label" for="fuel">Fuel type (if applicable)</label>
        </div>
        <p class="field-error">Please choose a fuel type.</p>
      </div>
      <div class="field">
        <div class="fl-field">
          <div class="fl-icon">${icon("mountain", 18)}</div>
          <input class="fl-input" type="number" id="distance" name="distance" min="0" step="any" inputmode="decimal" placeholder=" " required />
          <label class="fl-label" for="distance">Average distance per day (km)</label>
        </div>
        <p class="field-error">Please enter a valid distance (0 or more).</p>
      </div>
      <div class="field">
        <div class="fl-field">
          <div class="fl-icon">${icon("calendar", 18)}</div>
          <input class="fl-input" type="number" id="days" name="days" min="1" max="7" step="1" inputmode="numeric" placeholder=" " required />
          <label class="fl-label" for="days">Travel days per week</label>
        </div>
        <p class="field-error">Please enter days per week (1–7).</p>
      </div>
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("users", 18)}</div>
          <select class="fl-input" id="occupancy" name="occupancy" required>
            <option value="" selected disabled></option>
            <option value="1">Alone</option>
            <option value="2">2 persons</option>
            <option value="3">3+ persons</option>
          </select>
          <label class="fl-label" for="occupancy">How many travel together?</label>
        </div>
        <p class="field-error">Please choose an occupancy.</p>
      </div>`
    : step === 1 ? `
      <div class="field">
        <div class="fl-field">
          <div class="fl-icon">${icon("bolt", 18)}</div>
          <input class="fl-input" type="number" id="kwh" name="kwh" min="0" step="any" inputmode="decimal" placeholder=" " required />
          <label class="fl-label" for="kwh">Monthly electricity (kWh)</label>
        </div>
        <p class="field-error">Please enter your monthly kWh.</p>
      </div>
      <div class="field">
        <div class="fl-field">
          <div class="fl-icon">${icon("users", 18)}</div>
          <input class="fl-input" type="number" id="people" name="people" min="1" max="99" step="1" inputmode="numeric" placeholder=" " required />
          <label class="fl-label" for="people">People in household</label>
        </div>
        <p class="field-error">Please enter how many people live there.</p>
      </div>
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("sun", 18)}</div>
          <select class="fl-input" id="renewable" name="renewable" required>
            <option value="" selected disabled></option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
          <label class="fl-label" for="renewable">Renewable energy source?</label>
        </div>
        <p class="field-error">Please choose yes or no.</p>
      </div>`
    : `
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("trash", 18)}</div>
          <select class="fl-input" id="tier" name="tier" required>
            <option value="" selected disabled></option>
            <option value="1">Low (≈0.5 kg/day)</option>
            <option value="2">Medium (≈1 kg/day)</option>
            <option value="3">High (≈2 kg/day)</option>
          </select>
          <label class="fl-label" for="tier">Waste generation tier</label>
        </div>
        <p class="field-error">Please choose a waste tier.</p>
      </div>
      <div class="field">
        <div class="fl-field select">
          <div class="fl-icon">${icon("recycle", 18)}</div>
          <select class="fl-input" id="recycle" name="recycle" required>
            <option value="" selected disabled></option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
          <label class="fl-label" for="recycle">Recycling practiced?</label>
        </div>
        <p class="field-error">Please choose yes or no.</p>
      </div>`;

  return `
    <div class="wizard-card">
      <div class="wc-head">
        <span class="wc-step-pill">Step ${step + 1} of 3</span>
        <h2>${STEP_META[step].name}</h2>
        <p>${step === 0 ? "How do you get around?" : step === 1 ? "How does your home stay powered?" : "What does your household throw away?"}</p>
      </div>
      <form id="assessment-form" novalidate>
        <fieldset>${fields}</fieldset>
        <div class="form-actions">
          ${backBtn}
          <button type="submit" class="btn btn-primary">${nextLabel} <span class="btn-arrow" aria-hidden="true">→</span></button>
        </div>
      </form>
    </div>`;
}

function clearOnInput(form) {
  form.querySelectorAll(".field").forEach((field) => {
    const input = field.querySelector("input, select");
    input.addEventListener("input", () => field.classList.remove("invalid"));
    input.addEventListener("change", () => field.classList.remove("invalid"));
  });
}
// whether the user has entered valid data in
function validateForm(form) {// The program checks whether the input is required and empty
  let ok = true; // variabes are declared and initialized
  let firstInvalid = null;
  form.querySelectorAll(".field").forEach((field) => {// for each loop is used here
    const input = field.querySelector("input, select");
    const value = input.value;// this is what the user has entered 
    let bad = false;
    if (input.required && String(value).trim() === "") bad = true;// ifstatement 
    if (input.type === "number" && value !== "") {
      const n = Number(value);// convert the sting into the number 
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      if (!Number.isFinite(n) || n < min || n > max) bad = true;
    }
    if (bad) {
      ok = false;
      field.classList.add("invalid", "shake");
      if (!firstInvalid) firstInvalid = input;
      setTimeout(() => field.classList.remove("shake"), 500);
    } else {
      field.classList.remove("invalid");
    }
  });
  if (firstInvalid) firstInvalid.focus();
  return ok;
}

function bindStep(step) {
  const form = document.getElementById("assessment-form");
  if (!form) return;
  clearOnInput(form);
  const back = form.querySelector("[data-back]");
  if (back) {
    back.addEventListener("click", () => { wizard.dir = "back"; wizard.step -= 1; showStep(); });
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    const data = new FormData(form);
    if (step === 0) {
      appState.assessment.transport = {
        mode: data.get("mode"),
        fuel: data.get("fuel"),
        distance: Number(data.get("distance")),
        days: Number(data.get("days")),
        occupancy: Number(data.get("occupancy")),
      };
      saveState();
      wizard.dir = "forward"; wizard.step = 1; showStep();
    } else if (step === 1) {
      appState.assessment.electricity = {
        kwh: Number(data.get("kwh")),
        people: Number(data.get("people")),
        renewable: data.get("renewable") === "yes",// boolean datatype 
      };
      saveState();
      wizard.dir = "forward"; wizard.step = 2; showStep();
    } else {
      appState.assessment.waste = {
        tier: Number(data.get("tier")),
        recycle: data.get("recycle") === "yes",
      };
      saveState();
      // Persisting the assessment to Supabase now happens inside
      // calculateResults() (via eco-data.js), so this is the only place
      // the wizard produces final numbers — no second insert here.
      
      // Render skeleton while awaiting calculateResults
      renderResultsSkeleton();
      scrollTop();
      
      calculateResults().then((results) => {
        if (!results) {
          devWarn("Results were not produced; staying on the last step.");
          return;
        }
        setTimeout(() => { location.hash = "#result"; }, 650);
      });
    }
  });
}

function renderResultsSkeleton() {
  const html = `
  <section class="results-page">
    <div class="container">
      <div class="results-hero">
        <div class="skeleton" style="height:1.6rem;width:180px;margin:0 auto 0.9rem;border-radius:9999px;"></div>
        <div class="skeleton" style="height:3rem;width:260px;margin:0 auto 1.2rem;"></div>
        <div class="skeleton" style="height:2.4rem;width:320px;margin:0 auto;"></div>
      </div>
      <div class="score-layout">
        <div class="skeleton" style="height:360px;"></div>
        <div class="skeleton" style="height:360px;"></div>
      </div>
      <div class="metric-grid">
        <div class="skeleton" style="height:92px;"></div>
        <div class="skeleton" style="height:92px;"></div>
        <div class="skeleton" style="height:92px;"></div>
        <div class="skeleton" style="height:92px;"></div>
        <div class="skeleton" style="height:92px;"></div>
        <div class="skeleton" style="height:92px;"></div>
      </div>
      <div class="charts-grid">
        <div class="skeleton" style="height:340px;"></div>
        <div class="skeleton" style="height:340px;"></div>
        <div class="skeleton" style="height:320px;"></div>
      </div>
    </div>
  </section>`;
  setAppHtml(html);
}

// ---------------------- Emission engine (kg CO2e / month) ----------------------
// Three PURE category functions. Each depends ONLY on its own category's inputs —
// Transport never reads electricity/waste state, and vice versa. The only place
// categories combine is the final total = transport + electricity + waste.
function transportFactor(mode, fuel) {
  const m = TRANSPORT_FACTORS[mode];
  if (!m) return 0;
  
  if (fuel && m[fuel] !== undefined) {
    return m[fuel];
  }
  
  // Validation check: If fuel doesn't match the valid options, reject calculation
  console.warn("Invalid transport + fuel combination:", mode, fuel);
  return 0;
}
function transportMonthly(t) {
  const factor = transportFactor(t.mode, t.fuel);
  return (t.distance * t.days * WEEKS_PER_MONTH * factor) / t.occupancy;
}
function electricityMonthly(e) {
  const base = (e.kwh * GRID_FACTOR_KG_PER_KWH) / e.people;
  return e.renewable ? base * RENEWABLE_MULTIPLIER : base;
}
function wasteMonthly(w) {
  const tierKg = w.tierKgOverride != null ? w.tierKgOverride : WASTE_TIER_DAILY_KG[w.tier - 1];
  const base = tierKg * DAYS_PER_MONTH * LANDFILL_FACTOR_KG_PER_KG;
  return w.recycle ? base * RECYCLE_MULTIPLIER : base;
}

// ONE ratio drives Index, Grade, and vs-benchmark. Index uses a continuous curve that
// never flatlines inside any realistic input range:
//   ratio              = user_total_monthly / benchmark_total_monthly   (benchmark never 0)
//   conservation_index = 100 / (1 + ratio)      → continuous, monotonic, 0 < index <= 100
//   vs_benchmark_pct   = (ratio - 1) * 100      (unbounded: -100% .. +900%+; negative = better)
//   grade              = gradeFromIndex(conservation_index)  — banded off the SAME index value.
// Behaviour: ratio 0 (zero emissions) → 100 (only true zero-emitters reach 100); ratio 1
// (exactly benchmark) → 50 (average sits at the midpoint); ratio → ∞ → index → 0
// asymptotically. Index and vs-benchmark ALWAYS agree on direction (both > 50 / positive
// mean worse, both < 50 / negative mean better) but are NOT expected to match in magnitude —
// vs-benchmark is unbounded, index is bounded 0-100.
function footprintRatio(totalMonthly) {
  return totalMonthly / BENCHMARK.total;
}
function conservationIndex(totalMonthly) {
  if (!Number.isFinite(totalMonthly) || totalMonthly <= 0) return 100; // ratio = 0 limit
  return 100 / (1 + footprintRatio(totalMonthly));
}
function vsBenchmarkPercent(totalMonthly) {
  return (footprintRatio(totalMonthly) - 1) * 100;
}
// Explicit grade bands rebuilt around the new midpoint (ratio 1 → index 50):
// A 70-100 meaningfully better, B 55-69 somewhat better, C 40-54 around average,
// D 20-39 meaningfully worse, F 0-19 significantly worse.
function gradeFromIndex(index) {
  if (index >= 70) return "A";
  if (index >= 55) return "B";
  if (index >= 40) return "C";
  if (index >= 20) return "D";
  return "F";
}

function logCalculation(t, e, w, transport, electricity, waste, totalMonthly) {
  console.group("%cEcoTrack emission engine (kg CO2e / month)", "color:#0F9D6E;font-weight:bold");
  console.log(
    "Transport  = distance(%s km/day) x days(%s/week) x weeks/month(%s) x factor(%s kg/km) / occupancy(%s) = %s kg/mo",
    t.distance, t.days, WEEKS_PER_MONTH, transportFactor(t.mode, t.fuel), t.occupancy, fmt(transport, 1)
  );
  console.log(
    "Electricity= kWh(%s/month) x grid(%s kg/kWh) x renewable(%s) / people(%s) = %s kg/mo",
    e.kwh, GRID_FACTOR_KG_PER_KWH, e.renewable ? RENEWABLE_MULTIPLIER : 1.0, e.people, fmt(electricity, 1)
  );
  console.log(
    "Waste      = tier(%s -> %s kg/day) x days/month(%s) x landfill(%s kg/kg) x recycle(%s) = %s kg/mo",
    w.tier, WASTE_TIER_DAILY_KG[w.tier - 1], DAYS_PER_MONTH, LANDFILL_FACTOR_KG_PER_KG, w.recycle ? RECYCLE_MULTIPLIER : 1.0, fmt(waste, 1)
  );
  console.log("Total      = %s + %s + %s = %s kg CO2e/month  (%s t CO2e/year)", fmt(transport, 1), fmt(electricity, 1), fmt(waste, 1), fmt(totalMonthly, 1), fmt(totalMonthly * 12 / 1000, 2));
  console.log("Ratio      = user / benchmark = %s / %s = %s", fmt(totalMonthly, 1), BENCHMARK.total, footprintRatio(totalMonthly).toFixed(3));
  console.log("Index      = 100 / (1 + ratio) = %s%%  |  vs benchmark = (ratio - 1) x 100 = %s%%  (agree on direction, NOT magnitude)", fmt(conservationIndex(totalMonthly), 1), fmt(vsBenchmarkPercent(totalMonthly), 1));
  console.log("Benchmark  = FIXED constant %s kg/mo (Transport %s + Electricity %s + Waste %s). Never derived from session state.", BENCHMARK.total, BENCHMARK.transport, BENCHMARK.electricity, BENCHMARK.waste);
  console.log("Sources: transport DEFRA/BEIS 2022 (kg/km); electricity India CEA grid factor 0.82 kg/kWh (region-specific); waste EPA WARM 0.52 kg/kg; tiers World Bank 'What a Waste 2.0'; trees 21 kg CO2/tree/yr; renewable/recycling adjustments are labelled assumptions.");
  console.groupEnd();
}

function buildRecommendations(t, e, w, values) {
  // values = { transport, electricity, waste } in kg CO2e/month.
  // Every saving below is the DELTA of re-running the pure category formula with one
  // input changed — no standalone/percentage guesses.
  const { transport, electricity, waste } = values;
  const totalMonthly = transport + electricity + waste;
  const recs = [];
  const meaningful = (v) => (totalMonthly > 0 ? v / totalMonthly >= 0.1 : false);

  if (t.mode === "car" && t.occupancy === 1 && meaningful(transport)) {
    const saving = transport - transportMonthly(Object.assign({}, t, { occupancy: 2 }));
    recs.push({ category: "Transport", title: "Carpool your commute",
      desc: `You drive alone ${t.days} day${t.days > 1 ? "s" : ""}/week (${t.distance} km/day). Re-running your transport formula at occupancy 2 gives the saving shown.`,
      saving });
  }
  if (t.mode === "car" && t.fuel !== "electric" && meaningful(transport)) {
    const saving = transport - transportMonthly(Object.assign({}, t, { fuel: "electric" }));
    recs.push({ category: "Transport", title: "Switch to an electric car",
      desc: `At ${t.distance} km/day your ${t.fuel} car uses ${transportFactor(t.mode, t.fuel).toFixed(3)} kg CO2e/km vs ${TRANSPORT_ELECTRIC} for an EV — the saving is the formula delta.`,
      saving });
  }
  if (t.mode !== "walking" && t.mode !== "bicycle" && meaningful(transport) && t.distance <= 8) {
    const saving = transport;
    recs.push({ category: "Transport", title: "Replace short trips with cycling or walking",
      desc: `Your trips are short (${t.distance} km). Cycling/walking carry a 0 kg CO2e/km factor, removing the entire transport line (${fmt(transport, 1)} kg CO2e/month).`,
      saving });
  }

  if (!e.renewable && meaningful(electricity)) {
    const saving = electricity - electricityMonthly(Object.assign({}, e, { renewable: true }));
    recs.push({ category: "Electricity", title: "Switch to renewable electricity",
      desc: `Your home uses ${e.kwh} kWh/month. Re-running the formula with renewable: true applies the ${Math.round((1 - RENEWABLE_MULTIPLIER) * 100)}% renewable reduction (grid ${GRID_FACTOR_KG_PER_KWH} kg CO2e/kWh).`,
      saving });
  }
  if (e.kwh > 400 && meaningful(electricity)) {
    const saving = electricity - electricityMonthly(Object.assign({}, e, { kwh: e.kwh * 0.85 }));
    recs.push({ category: "Electricity", title: "Trim your electricity use",
      desc: `At ${e.kwh} kWh/month you're above a typical ~400 kWh/month. Re-running the formula at ${Math.round(e.kwh * 0.85)} kWh (15% lower) gives the saving.`,
      saving });
  }

  if (!w.recycle && meaningful(waste)) {
    const saving = waste - wasteMonthly(Object.assign({}, w, { recycle: true }));
    recs.push({ category: "Waste", title: "Start recycling",
      desc: `Recycling re-runs the waste formula with the ${Math.round((1 - RECYCLE_MULTIPLIER) * 100)}% recycling adjustment (landfill ${LANDFILL_FACTOR_KG_PER_KG} kg CO2e/kg).`,
      saving });
  }
  if (w.tier >= 2 && meaningful(waste)) {
    const tierKg = WASTE_TIER_DAILY_KG[w.tier - 1];
    const saving = waste - wasteMonthly(Object.assign({}, w, { tierKgOverride: tierKg * 0.75 }));
    recs.push({ category: "Waste", title: "Reduce and compost food waste",
      desc: `Composting organics and cutting food waste reduces your ${fmt(tierKg, 1)} kg/day waste stream by ~25% — the saving is the formula delta.`,
      saving });
  }

  recs.sort((a, b) => b.saving - a.saving);
  return recs;
}

function projectScore(totalMonthly, recommendations) {
  const top = recommendations.slice(0, 2);
  const saved = top.reduce((s, r) => s + Math.min(r.saving, totalMonthly * 0.5), 0);
  const newTotal = Math.max(0, totalMonthly - saved);
  const currentIndex = conservationIndex(totalMonthly);
  const newIndex = conservationIndex(newTotal);
  return {
    saved,
    total: newTotal,
    index: newIndex,
    grade: gradeFromIndex(newIndex),
    fromIndex: currentIndex,
    fromGrade: gradeFromIndex(currentIndex),
    benchmarkTotal: BENCHMARK.total,
  };
}

async function calculateResults() {
  const a = appState.assessment;
  const t = a.transport, e = a.electricity, w = a.waste;

  if (!t || !e || !w) {
    devWarn("calculateResults() called before all three categories were collected.");
    return null;
  }

  const mTransport = transportMonthly(t);
  const mElectricity = electricityMonthly(e);
  const mWaste = wasteMonthly(w);
  const totalMonthly = mTransport + mElectricity + mWaste;

  logCalculation(t, e, w, mTransport, mElectricity, mWaste, totalMonthly);

  // ONE ratio drives Index, Grade, and vs-benchmark. Index = 100/(1+ratio), continuous and
  // never flatlined; vs-benchmark stays unbounded. They agree on direction, not magnitude.
  const ratio = footprintRatio(totalMonthly);          // user : benchmark (1 = exactly benchmark)
  const cIndex = conservationIndex(totalMonthly);      // 100 / (1 + ratio)
  const grade = gradeFromIndex(cIndex);                // banded off the SAME index value
  const vsAvgPct = vsBenchmarkPercent(totalMonthly);   // (ratio - 1) * 100 — unbounded, unclamped
  const vsAvgBetter = vsAvgPct < 0;

  const contributions = [
    { name: "Transport", value: mTransport, color: "transport" },
    { name: "Electricity", value: mElectricity, color: "electricity" },
    { name: "Waste", value: mWaste, color: "waste" },
  ];
  const highest = contributions.reduce((acc, c) => (c.value > acc.value ? c : acc));

  // Bug 2 guard — the months-of-electricity comparison must never silently show 0
  if (!Number.isFinite(mElectricity) || mElectricity < 0 || !Number.isFinite(AVG_HOME_ELEC_MONTHLY) || AVG_HOME_ELEC_MONTHLY <= 0) {
    devWarn("Months-of-electricity comparison got a non-finite numerator or denominator — data-flow bug.");
  }
  const equivalents = {
    kmCar: totalMonthly / TRANSPORT_PETROL,
    monthsElectric: mElectricity / AVG_HOME_ELEC_MONTHLY,
    treesAnnual: (totalMonthly * 12) / TREE_KG_PER_YR,
  };

  const recommendations = buildRecommendations(t, e, w, { transport: mTransport, electricity: mElectricity, waste: mWaste });
  const projected = projectScore(totalMonthly, recommendations);

  appState.results = {
    monthly: { transport: mTransport, electricity: mElectricity, waste: mWaste },
    totalKg: totalMonthly,
    totalTonnesYear: (totalMonthly * 12) / 1000,
    conservationIndex: cIndex,
    grade,
    vsAvgPct,
    vsAvgBetter,
    highestContributor: highest,
    equivalents,
    recommendations,
    projected,
    saveFailed: false, // Default to false
  };
  saveState();
  // ---- Persist to the signed-in user's account. Runs only once all
  // three categories have produced real numbers, so a half-finished
  // assessment is never stored. Values are passed through unchanged —
  // the maths above is still the only source of these numbers.
  if (window.EcoData) {
    try {
      const saved = await window.EcoData.saveAssessment(appState.assessment, appState.results);
      if (saved) {
        console.log("EcoTrack: assessment saved for this account.");
      } else {
        console.warn("EcoTrack: assessment was not saved (no active session?).");
        appState.results.saveFailed = true;
      }
    } catch (err) {
      console.error("EcoTrack: could not save the assessment.", err);
      appState.results.saveFailed = true;
    }
    saveState();
  }
  return appState.results;
}

// ---------------------- Results dashboard ----------------------
let chartInstances = [];
function destroyCharts() {
  chartInstances.forEach((c) => { try { c.destroy(); } catch (e) {} });
  chartInstances = [];
}
function chartTooltip() {
  return {
    backgroundColor: themeColor("--color-surface", "#fff"),
    titleColor: themeColor("--color-text", "#1F2A22"),
    bodyColor: themeColor("--color-text-secondary", "#5B6558"),
    borderColor: themeColor("--color-border", "#E2E8E3"),
    borderWidth: 1,
    cornerRadius: 14,
    padding: 12,
    displayColors: false,
    titleFont: { family: DISPLAY_FONT, size: 13 },
    bodyFont: { family: BODY_FONT, size: 12 },
  };
}
function ctxOf(id) {
  const el = document.getElementById(id);
  return el && el.getContext ? el.getContext("2d") : null;
}
// Scriptable gradients — evaluated at draw time when chartArea is ready.
function hbarFill(top, bottom) {
  return (context) => {
    const { chart } = context;
    if (!chart.chartArea) return top;
    const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };
}
function areaFill(top, bottom) {
  return (context) => {
    const { chart } = context;
    if (!chart.chartArea) return top;
    const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };
}

// Animated circular progress ring — score 0 → final.
function mountScoreRing(value) {
  const ring = document.getElementById("ring-progress");
  if (!ring) return;
  const C = 2 * Math.PI * 120;
  const target = C * (1 - clamp(value, 0, 100) / 100);
  ring.style.strokeDasharray = C.toFixed(1);
  ring.style.strokeDashoffset = C.toFixed(1);
  const start = performance.now();
  const dur = 1200;
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    ring.style.strokeDashoffset = (C - (C - target) * eased).toFixed(1);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Needle position is a pure function of the SAME conservation_index value shown as text.
// Arc spans 180° (left, index 0 / red) → 0° (right, index 100 / green).
function gaugeNeedleAngle(value) {
  return 180 - clamp(value, 0, 100) * 1.8;
}

function mountGauge(value, grade) {
  const mount = document.getElementById("gauge-mount");
  if (!mount) return;
  const cx = 100, cy = 100, r = 80;
  const pt = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy - r * Math.sin((a * Math.PI) / 180)];
  const arc = (a1, a2) => {
    const p1 = pt(a1), p2 = pt(a2);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  };
  const border = themeColor("--color-border", "#E2E8E3");
  const red = themeColor("--color-cat-transport", "#EF6351");
  const amber = themeColor("--color-cat-electricity", "#F5A524");
  const green = themeColor("--color-cat-waste", "#0F9D6E");
  const ink = themeColor("--color-text", "#1F2A22");
  mount.innerHTML = `
    <svg viewBox="0 0 200 118" class="gauge-svg" role="img" aria-label="Conservation index ${value.toFixed(1)} percent">
      <path d="${arc(0, 180)}" stroke="${border}" stroke-width="12" fill="none" stroke-linecap="round"/>
      <path d="${arc(120, 180)}" stroke="${red}" stroke-width="12" fill="none" stroke-linecap="round"/>
      <path d="${arc(60, 120)}" stroke="${amber}" stroke-width="12" fill="none" stroke-linecap="round"/>
      <path d="${arc(0, 60)}" stroke="${green}" stroke-width="12" fill="none" stroke-linecap="round"/>
      <line id="gauge-needle" x1="100" y1="100" x2="${pt(180)[0].toFixed(1)}" y2="${pt(180)[1].toFixed(1)}" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="100" cy="100" r="5" fill="${ink}"/>
      <text x="16" y="112" font-size="9" font-family="IBM Plex Mono, monospace" fill="${ink}" opacity="0.55">0</text>
      <text x="180" y="112" font-size="9" font-family="IBM Plex Mono, monospace" fill="${ink}" opacity="0.55">100</text>
    </svg>`;
  const needle = document.getElementById("gauge-needle");
  const targetAngle = gaugeNeedleAngle(value); // same value as the displayed text/grade
  const start = performance.now();
  const dur = 900;
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const a = 180 - (180 - targetAngle) * eased;
    const p2 = pt(a);
    needle.setAttribute("x2", p2[0].toFixed(1));
    needle.setAttribute("y2", p2[1].toFixed(1));
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function mountChart(breakdown, totalMonthly) {
  const ctx = ctxOf("emissionBar");
  if (!ctx) return;
  if (typeof Chart === "undefined") { devWarn("Chart.js failed to load — emission breakdown unavailable."); return; }
  const maxVal = Math.max(...breakdown.map((b) => b.value));
  const domainMax = Math.max(10, maxVal * 1.1);
  chartInstances.push(new Chart(ctx, {
    type: "bar",
    data: {
      labels: breakdown.map((b) => b.name),
      datasets: [{
        label: "kg CO₂e / month",
        data: breakdown.map((b) => b.value),
        backgroundColor: breakdown.map((b) => hbarFill(b.color, b.color + "55")),
        hoverBackgroundColor: breakdown.map((b) => b.color),
        borderRadius: 14,
        borderSkipped: false,
        maxBarThickness: 26,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 6, bottom: 6 } },
      animation: {
        duration: 900,
        easing: "easeOutQuart",
        delay(context) {
          if (context.type === "data" && context.mode === "default") return context.dataIndex * 140;
          return 0;
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          max: domainMax,
          grid: { color: themeColor("--color-gridline", "#E8ECE7"), drawBorder: false },
          ticks: { color: themeColor("--color-text-muted", "#8A9186"), font: { family: BODY_FONT, size: 12 }, callback: (v) => v + " kg" },
          title: { display: true, text: "kg CO₂e / month", color: themeColor("--color-text-muted", "#8A9186"), font: { family: BODY_FONT, size: 12 } },
        },
        y: {
          grid: { display: false },
          ticks: { color: themeColor("--color-text-secondary", "#5B6558"), font: { family: BODY_FONT, size: 13 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(),
          callbacks: {
            label(lc) {
              const v = lc.raw;
              const pct = totalMonthly > 0 ? ((v / totalMonthly) * 100).toFixed(1) : "0.0";
              return ` ${v.toFixed(1)} kg CO₂e / month · ${pct}% of total`;
            },
          },
        },
      },
    },
  }));
}

function mountDonut(breakdown, totalMonthly) {
  const ctx = ctxOf("contributionDonut");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  chartInstances.push(new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: breakdown.map((b) => b.name),
      datasets: [{
        data: breakdown.map((b) => b.value),
        backgroundColor: breakdown.map((b) => b.color),
        hoverBackgroundColor: breakdown.map((b) => b.color),
        borderWidth: 0,
        borderRadius: 12,
        spacing: 5,
        hoverOffset: 10,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      layout: { padding: 6 },
      animation: { animateRotate: true, animateScale: true, duration: 1100, easing: "easeOutQuart" },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: themeColor("--color-text-secondary", "#5B6558"),
            font: { family: BODY_FONT, size: 12 },
            padding: 18,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
          },
        },
        tooltip: {
          ...chartTooltip(),
          callbacks: {
            label(lc) {
              const v = lc.raw;
              const pct = totalMonthly > 0 ? ((v / totalMonthly) * 100).toFixed(1) : "0.0";
              return ` ${lc.label} · ${v.toFixed(1)} kg · ${pct}%`;
            },
          },
        },
      },
    },
  }));
}

function mountSavings(projected, totalKg) {
  const ctx = ctxOf("savingsBar");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  chartInstances.push(new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Current monthly footprint", "Projected after top recommendations"],
      datasets: [{
        data: [totalKg, projected.total],
        backgroundColor: (context) => {
          if (!context.chart.chartArea) return "#0F9D6E";
          const projected = context.dataIndex === 1;
          const top = projected ? "#2DBE8E" : "#EF6351";
          const bottom = projected ? "#0F9D6E" : "#EF6351BB";
          return hbarFill(top, bottom)(context);
        },
        borderRadius: 14,
        borderSkipped: false,
        maxBarThickness: 64,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 10 } },
      animation: { duration: 1000, easing: "easeOutQuart" },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: themeColor("--color-text-secondary", "#5B6558"), font: { family: BODY_FONT, size: 12 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: themeColor("--color-gridline", "#E8ECE7"), drawBorder: false },
          ticks: { color: themeColor("--color-text-muted", "#8A9186"), font: { family: BODY_FONT, size: 12 }, callback: (v) => v + " kg" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(),
          callbacks: { label: (lc) => ` ${lc.raw.toFixed(1)} kg CO₂e / month` },
        },
      },
    },
  }));
}

function mountTrend(totalKg) {
  const ctx = ctxOf("trendArea");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  chartInstances.push(new Chart(ctx, {
    type: "line",
    data: {
      labels: months,
      datasets: [
        {
          label: "Your footprint",
          data: Array(12).fill(totalKg),
          fill: true,
          tension: 0.4,
          borderColor: "#0F9D6E",
          backgroundColor: areaFill("rgba(15,157,110,0.30)", "rgba(15,157,110,0.02)"),
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#0F9D6E",
          borderWidth: 3,
        },
        {
          label: "Benchmark",
          data: Array(12).fill(BENCHMARK.total),
          fill: false,
          tension: 0,
          borderColor: "#F5A524",
          borderDash: [7, 7],
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 6 } },
      interaction: { intersect: false, mode: "index" },
      animation: { duration: 1200, easing: "easeOutQuart" },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: themeColor("--color-text-muted", "#8A9186"), font: { family: BODY_FONT, size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: themeColor("--color-gridline", "#E8ECE7"), drawBorder: false },
          ticks: { color: themeColor("--color-text-muted", "#8A9186"), font: { family: BODY_FONT, size: 12 }, callback: (v) => v + " kg" },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: themeColor("--color-text-secondary", "#5B6558"),
            font: { family: BODY_FONT, size: 12 },
            padding: 18,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
          },
        },
        tooltip: {
          ...chartTooltip(),
          callbacks: { label: (lc) => ` ${lc.dataset.label}: ${lc.raw.toFixed(1)} kg CO₂e / month` },
        },
      },
    },
  }));
}

function recMeta(rec) {
  const base = {
    "Transport": { icon: "car", color: "#EF6351", difficulty: "Medium", cost: "Varies", time: "This week", priority: "High" },
    "Electricity": { icon: "bolt", color: "#F5A524", difficulty: "Easy", cost: "Varies", time: "This month", priority: "Medium" },
    "Waste": { icon: "trash", color: "#0F9D6E", difficulty: "Easy", cost: "Low", time: "This week", priority: "Medium" },
  }[rec.category] || { icon: "leaf", color: "#0F9D6E", difficulty: "Easy", cost: "Low", time: "Anytime", priority: "Medium" };
  const overrides = {
    "Switch to an electric car": { difficulty: "Hard", cost: "High upfront", time: "At next car purchase", priority: "Medium" },
    "Switch to renewable electricity": { difficulty: "Medium", cost: "Medium", time: "Provider switch", priority: "High" },
    "Start recycling": { difficulty: "Easy", cost: "Free", time: "This week", priority: "High" },
    "Reduce and compost food waste": { difficulty: "Easy", cost: "Low", time: "This month", priority: "Medium" },
    "Carpool your commute": { difficulty: "Easy", cost: "Free", time: "This week", priority: "High" },
    "Trim your electricity use": { difficulty: "Easy", cost: "Saves money", time: "This month", priority: "Medium" },
    "Replace short trips with cycling or walking": { difficulty: "Easy", cost: "Free", time: "This week", priority: "Medium" },
  };
  return Object.assign({}, base, overrides[rec.title] || {});
}

function renderRecommendations(r) {
  if (!r.recommendations.length) return `<p class="rec-empty">No recommendations for your current inputs.</p>`;
  const total = r.totalKg;
  return `<div class="rec-cards">
    ${r.recommendations.map((rec, idx) => {
      const m = recMeta(rec);
      const pctW = total > 0 ? clamp((rec.saving / total) * 100, 2, 100) : 0;
      return `
      <article class="rec-card reveal reveal-up" style="transition-delay:${idx * 80}ms;--rc-color:${m.color};border-left-color:${m.color}">
        <div class="rec-card-top">
          <div class="rec-card-icon">${icon(m.icon, 20)}</div>
          <div class="rec-cat">${rec.category}</div>
          <span class="rec-priority p-${m.priority.toLowerCase()}">${m.priority}</span>
        </div>
        <h3>${rec.title}</h3>
        <p class="rec-desc">${rec.desc}</p>
        <div class="rec-meta">
          <div class="rec-meta-item">${icon("trendDown", 14)} <b>−${fmt(rec.saving, 1)} kg</b>&nbsp;/ mo</div>
          <div class="rec-meta-item">${icon("flag", 14)} ${m.difficulty}</div>
          <div class="rec-meta-item">${icon("dollar", 14)} ${m.cost}</div>
          <div class="rec-meta-item">${icon("clock", 14)} ${m.time}</div>
        </div>
        <div class="rec-save-bar"><div class="rec-save-fill" style="width:${pctW}%"></div></div>
        <div class="rec-card-foot">
          <span class="rec-save-amt">${icon("checkCircle", 14)} Saves ${fmt(rec.saving, 1)} kg CO₂e / month</span>
          <a href="#resources" class="rec-learn">Learn more ${icon("arrowRight", 14)}</a>
        </div>
      </article>`;
    }).join("")}
  </div>`;
}

function renderProjected(r) {
  const p = r.projected;
  const n = Math.min(2, r.recommendations.length);
  if (!n) return "";
  return `
    <div class="projected-callout">
      <div class="pc-icon">${icon("target", 22)}</div>
      <div class="pc-text">
        <div class="pc-title">Projected score if you follow the top ${n} recommendation${n === 1 ? "" : "s"}</div>
        <div class="pc-detail">Estimated saving ≈ ${fmt(p.saved, 1)} kg CO₂e/month → ${fmt(p.total, 1)} kg CO₂e/month total.</div>
      </div>
      <div class="pc-score">${fmt(p.index, 0)}%<span style="font-size:0.85rem;color:var(--color-text-muted)"> (${p.fromGrade} → ${p.grade})</span></div>
    </div>`;
}

function kpi(iconName, valueHtml, label, cls) {
  return `
  <div class="kpi-card ${cls} reveal reveal-up">
    <div class="kpi-icon">${icon(iconName, 22)}</div>
    <div class="kpi-body">
      <div class="kpi-value">${valueHtml}</div>
      <div class="kpi-label">${label}</div>
    </div>
  </div>`;
}

async function renderDashboard() {
  const r = appState.results;
  if (!r) { devWarn("renderDashboard() called with no results."); renderCalculator(); return; }
  
  // Phase 9 & 10: Fetch Streak and Challenge data asynchronously
  let streakHtml = "";
  let challengeHtml = "";
  let ctaHtml = "";

  // Fetch the streak to decide whether to show the CTA. The streak row
  // itself is created automatically by the server, so "does this row
  // exist" is no longer a useful test — the meaningful one is whether
  // any challenge has been completed yet.
  if (window.EcoData && (await window.EcoData.isSignedIn())) {
    try {
      const dash = await window.EcoData.getDashboard();
      const completed = Number(dash?.streak?.challenges_completed) || 0;
      if (completed === 0) {
        // No challenge completed yet, show CTA
        ctaHtml = `
          <!-- Start Streak CTA -->
          <section class="streak-cta" id="streak-cta" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;padding:2rem;text-align:center;margin-bottom:2rem;" class="reveal reveal-up">
            <h2>Ready to start your carbon-saving journey?</h2>
            <p style="color:var(--color-text-muted);margin-bottom:1.5rem;">Turn these insights into action! Join the daily challenge and build your conservation streak.</p>
            <div style="display:flex;gap:1rem;justify-content:center;">
              <button class="btn btn-primary" onclick="startStreak()">Start My Streak</button>
              <button class="btn btn-secondary" style="background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);padding:0.75rem 1.5rem;border-radius:8px;font-family:inherit;font-weight:600;cursor:pointer;" onclick="hideStreakCTA()">Maybe Later</button>
            </div>
          </section>
        `;
      }
    } catch (e) {
      // A failed stats read must not block the results page.
      console.warn("EcoTrack: could not read the streak for the CTA.", e);
    }
  }
  const C = r.monthly;
  const colors = {
    transport: themeColor("--color-cat-transport", "#EF6351"),
    electricity: themeColor("--color-cat-electricity", "#F5A524"),
    waste: themeColor("--color-cat-waste", "#0F9D6E"),
  };
  const breakdown = [
    { name: "Transport", value: C.transport, color: colors.transport },
    { name: "Electricity", value: C.electricity, color: colors.electricity },
    { name: "Waste", value: C.waste, color: colors.waste },
  ];
  const vsClass = r.vsAvgBetter ? "better" : "worse";
  const vsIcon = r.vsAvgBetter ? "trendDown" : "trendUp";
  const vsText = `${r.vsAvgBetter ? "−" : "+"}${Math.abs(r.vsAvgPct).toFixed(1)}%`;
  const gradeW = { A: 92, B: 75, C: 58, D: 38, F: 18 }[r.grade] || 50;
  const rankPct = clamp(Math.round(r.conservationIndex), 0, 99);
  const pSaved = r.recommendations.length ? r.projected.saved : 0;

  const html = `
  <section class="results-page">
    <div class="results-bg" aria-hidden="true">
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
      <span class="leaf leaf-1" style="--rot:-18deg">${icon("leaf", 22)}</span>
      <span class="leaf leaf-3" style="--rot:12deg">${icon("leaf", 26)}</span>
    </div>
    <div class="container">
      ${r.saveFailed ? `
      <div style="background:#FDECEC;color:#B91C1C;border:1px solid #F5B5B5;border-radius:12px;padding:1rem;margin-bottom:2rem;text-align:center;">
        <strong>Warning: Your assessment was calculated but could not be saved to your account.</strong>
        <p style="margin:0.5rem 0 0;font-size:0.9rem;">Check the console for details. You can view your results, but they won't appear in your History.</p>
      </div>` : ''}
      <header class="results-hero reveal reveal-up">
        <span class="eyebrow">Assessment complete</span>
        <h1>Your <span class="text-gradient">results</span></h1>
        <div class="headline-metric">
          <span class="headline-number" data-countup-target="${r.totalKg.toFixed(1)}" data-decimals="1">0</span>
          <span class="headline-unit">kg CO₂e / month</span>
        </div>
        <div class="headline-sub">${fmt(r.totalTonnesYear, 2)} t CO₂e per year · ${fmt(r.equivalents.treesAnnual, 0)} trees would need a year to offset this</div>
      </header>

      <div class="score-layout">
        <div class="score-ring-card reveal reveal-up">
          <div class="ring-wrap">
            <svg viewBox="0 0 280 280" role="img" aria-label="Conservation index ${r.conservationIndex.toFixed(1)} percent">
              <defs>
                <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#2DBE8E"/>
                  <stop offset="100%" stop-color="#0F9D6E"/>
                </linearGradient>
              </defs>
              <circle class="ring-track" cx="140" cy="140" r="120"></circle>
              <circle class="ring-progress" id="ring-progress" cx="140" cy="140" r="120"></circle>
            </svg>
            <div class="ring-center">
              <div><span data-countup-target="${r.conservationIndex.toFixed(1)}" data-decimals="1">0</span>%</div>
              <div class="ring-label">Conservation Index</div>
            </div>
          </div>
          <div class="ring-caption">vs benchmark <strong class="font-mono">${fmt(r.vsAvgPct, 1)}%</strong> <span class="${vsClass}-text">(${r.vsAvgBetter ? "better than average" : "above average"})</span></div>
        </div>

        <div class="grade-card reveal reveal-up" style="transition-delay:100ms">
          <div class="grade-badge">
            <div class="grade-icon">${icon("trophy", 30)}</div>
            <div class="grade-letter">${r.grade}</div>
          </div>
          <div class="grade-body">
            <div class="grade-title">Eco Grade</div>
            <div class="grade-track"><div class="grade-bar" data-width="${gradeW}"></div></div>
            <div class="grade-rank">${icon("users", 15)} Better than ${rankPct}% of the community</div>
          </div>
        </div>
      </div>

      <div class="metric-grid">
        ${kpi("leaf", r.grade, "Eco Grade", "grad-green")}
        ${kpi("gauge", `<span data-countup-target="${r.conservationIndex.toFixed(1)}" data-decimals="1">0</span>%`, "Conservation Index", "grad-orange")}
        ${kpi("bolt", `<span data-countup-target="${r.totalKg.toFixed(1)}" data-decimals="1">0</span> kg`, "Monthly Footprint", "grad-beige")}
        ${kpi(categoryIconName(r.highestContributor.name), r.highestContributor.name, "Highest Contributor", "grad-ink")}
        ${kpi(vsIcon, vsText, "Community Comparison", vsClass)}
      </div>

      <div class="charts-grid">
        <div class="chart-card reveal reveal-up">
          <div class="chart-head"><h2>Emission breakdown</h2><span class="chart-badge">kg CO₂e / month</span></div>
          <div class="chart-wrap"><canvas id="emissionBar"></canvas></div>
        </div>
        <div class="chart-card reveal reveal-up" style="transition-delay:80ms">
          <div class="chart-head"><h2>Contribution</h2><span class="chart-badge">share of total</span></div>
          <div class="chart-wrap chart-wrap-sm"><canvas id="contributionDonut"></canvas></div>
        </div>
        <div class="chart-card chart-wide reveal reveal-up">
          <div class="chart-head"><h2>Savings projection</h2><span class="chart-badge">top recommendations applied</span></div>
          <div class="chart-wrap"><canvas id="savingsBar"></canvas></div>
        </div>
        <div class="chart-card chart-wide reveal reveal-up">
          <div class="chart-head"><h2>Monthly trend</h2><span class="chart-badge">current level vs benchmark</span></div>
          <div class="chart-wrap"><canvas id="trendArea"></canvas></div>
        </div>
      </div>

      <div class="real-life-grid">
        <div class="real-life-card reveal reveal-up">
          <div class="rl-icon">${icon("car", 24)}</div>
          <div class="rl-number" data-countup-target="${fmt(r.equivalents.kmCar, 0)}" data-decimals="0">0</div>
          <div class="rl-label">km driven in a petrol car, at your current monthly rate</div>
        </div>
        <div class="real-life-card reveal reveal-up" style="transition-delay:80ms">
          <div class="rl-icon">${icon("plug", 24)}</div>
          <div class="rl-number" data-countup-target="${r.equivalents.monthsElectric.toFixed(1)}" data-decimals="1">0</div>
          <div class="rl-label">months of average home electricity</div>
        </div>
        <div class="real-life-card reveal reveal-up" style="transition-delay:160ms">
          <div class="rl-icon">${icon("tree", 24)}</div>
          <div class="rl-number" data-countup-target="${fmt(r.equivalents.treesAnnual, 0)}" data-decimals="0">0</div>
          <div class="rl-label">mature trees needed to absorb this over a year, at your current monthly rate</div>
        </div>
      ${ctaHtml}

      <section class="rec-section" id="recommendations">
        <h2>Recommendations, ranked by monthly impact</h2>
        ${renderRecommendations(r)}
        ${renderProjected(r)}
      </section>
    </div>
  </section>`;

  setAppHtml(html);
  destroyCharts();
  mountScoreRing(r.conservationIndex);
  mountChart(breakdown, r.totalKg);
  mountDonut(breakdown, r.totalKg);
  mountSavings(r.projected, r.totalKg);
  mountTrend(r.totalKg);
  initGradeBar();
  initPageEffects(document.getElementById("app"));
}

// ---------------------- Streak Functions ----------------------
//
// The streak row itself is created by the server (a trigger on
// auth.users plus ensure_personal_rows), so starting a streak is just
// "make sure my rows exist, then show me the dashboard".
window.startStreak = async function() {
  if (!window.EcoData) {
    alert("Supabase is not initialized yet. Cannot start streak.");
    return;
  }
  const user = await window.EcoData.currentUser();
  if (!user) {
    alert("Please log in to start your streak.");
    window.location.href = "login.html?auth=required";
    return;
  }

  try {
    // Loads today's assessment, streak and challenge in one call, which
    // also creates the profile/streak rows if they are missing.
    await window.EcoData.getDashboard();
  } catch (e) {
    console.error("EcoTrack: could not initialise the streak.", e);
    alert("Unable to start your streak because the streak data could not be saved.\n\nDetails: " + e.message);
    return;
  }

  // Dashboard will be rendered directly via routing
  location.hash = "#dashboard";
};

window.hideStreakCTA = function() {
  const cta = document.getElementById("streak-cta");
  if (cta) cta.style.display = "none";
};

// Completing a challenge sends ONLY the assignment id, exactly as the
// server gave it to us. Nothing about the id is converted here, and no
// streak or carbon value is touched in the browser: the RPC decides
// everything and get_my_dashboard() reads the result back.
//
// This is the single completion entry point for the whole app:
//   button -> completeDailyChallenge() -> EcoData.completeChallenge()
//          -> complete_daily_challenge RPC -> database
//          -> getDashboard() -> renderStreakDashboard()
window.completeDailyChallenge = async function(assignmentId, button) {
  // 1. Data layer present.
  if (!window.EcoData) {
    alert('Data layer not ready. Please refresh the page.');
    return;
  }

  // 2. Signed in.
  const user = await window.EcoData.currentUser();
  if (!user) {
    alert('Please log in to complete challenges.');
    return;
  }

  // 3. A usable id. String()-normalised only -- never Number()/parseInt(),
  //    which would turn a UUID into NaN and could round a large serial.
  const id = String(assignmentId === null || assignmentId === undefined ? '' : assignmentId).trim();
  if (!id) {
    console.error('EcoTrack: invalid challenge ID');
    alert('Invalid challenge.');
    return;
  }

  // Guard against a double click while the request is in flight. The RPC
  // is idempotent as well, so this is belt-and-braces rather than the
  // only protection.
  if (button) {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Saving…';
  }

  let result = null;
  try {
    result = await window.EcoData.completeChallenge(id);
  } catch (err) {
    console.error('EcoTrack: completeDailyChallenge failed:', err);
    if (button) {
      button.disabled = false;
      button.textContent = 'Complete Challenge';
    }
    alert('Unable to record challenge completion.\n\nDetails: ' + (err && err.message ? err.message : 'Unknown error'));
    return;
  }

  // Never claim success unless the server actually returned a result.
  if (!result) {
    console.error('EcoTrack: completeDailyChallenge failed:', result);
    if (button) {
      button.disabled = false;
      button.textContent = 'Complete Challenge';
    }
    alert('Unable to record challenge completion.');
    return;
  }

  if (result.already_completed) {
    console.log('EcoTrack: challenge was already recorded today; nothing was added again.');
  }

  // Fresh data from the database drives the UI. No local arithmetic.
  await window.renderStreakDashboard();
};

// ---------------------- Eco Streak Dashboard ----------------------
//
// One round trip (get_my_dashboard) returns the newest assessment, the
// streak and today's challenge, all derived from the signed-in user's
// own calendar day in their own timezone.
window.renderStreakDashboard = async function() {
  if (typeof window.ecoTrackRequireLogin === "function" && !window.ecoTrackRequireLogin()) return;
  if (!window.EcoData) return;
  const user = await window.EcoData.currentUser();
  if (!user) return;

  let data;
  try {
    data = await window.EcoData.getDashboard();
  } catch (e) {
    console.error('EcoTrack: could not load the streak dashboard.', e);
    setAppHtml('<div class="container" style="padding:4rem 0"><div class="kpi-card">Could not load your streak right now. Please refresh the page.</div></div>');
    return;
  }
  if (!data) {
    renderDashboard();
    return;
  }

  const tz = data.timezone || 'UTC';
  const streak = data.streak || {};
  const assessment = data.assessment || null;
  const challenge = data.challenge || null;

  const cur = Number(streak.current_streak) || 0;
  const best = Number(streak.longest_streak) || 0;
  const saved = Number(streak.total_carbon_saved) || 0;
  const done = Number(streak.challenges_completed) || 0;

  // ---- Today's challenge card -------------------------------------
  let challengeCardHtml = '';
  if (!challenge) {
    challengeCardHtml = `<div class="kpi-card" style="grid-column: 1 / -1;">Your streak is active, but today's challenge could not be loaded. Please refresh and try again.</div>`;
  } else if (challenge.status === 'no_assessment') {
    challengeCardHtml = `
      <div class="kpi-card reveal reveal-up" style="grid-column: 1 / -1; padding: 2rem;">
        <div class="eyebrow" style="margin-bottom: 0.75rem;">TODAY'S ECO CHALLENGE</div>
        <h3 style="margin:0 0 .5rem; font-size:1.35rem;">${challenge.message || 'Complete your assessment to receive your personalized daily goal.'}</h3>
        <p style="margin:0; color:var(--color-text-muted);">Challenges are chosen from the area that drives your footprint, so an assessment is needed first.</p>
        <a href="#calculator" class="btn btn-primary" style="align-self: flex-start; margin-top:1.5rem;">Start assessment <span class="btn-arrow" aria-hidden="true">→</span></a>
      </div>`;
  } else if (challenge.status === 'completed') {
    const amount = Number(window.EcoData.challengeSaving(challenge) ?? challenge.carbon_saved) || 0;
    const when = window.EcoData.prettyDateTime(challenge.completed_at, tz);
    challengeCardHtml = `
      <div class="kpi-card grad-beige reveal reveal-up" style="grid-column: 1 / -1; padding: 2rem;">
        <div style="display:flex; align-items:center; gap: 1rem;">
          <div class="kpi-icon" style="color: #2DBE8E;">${icon("checkCircle", 32)}</div>
          <div>
            <h3 style="margin:0; font-size:1.4rem;">Challenge completed</h3>
            <p style="margin:0.5rem 0 0.25rem; color:var(--color-text-muted); font-size:1rem;">${challenge.title || ''}</p>
            <p style="margin:0; font-size:1rem;">You saved <strong>${window.EcoData.num(amount, 2)} kg CO₂e</strong> · ${when}</p>
          </div>
        </div>
      </div>`;
  } else {
    const tags = [];
    if (challenge.difficulty) tags.push(`Difficulty: ${challenge.difficulty}`);
    if (challenge.target_category && challenge.target_category !== challenge.category) {
      tags.push(`Targets: ${window.EcoData.categoryLabel(challenge.target_category)}`);
    }
    if (challenge.target_value) tags.push(`Target: ${challenge.target_value}`);
    tags.push(`Saving: ${window.EcoData.num(window.EcoData.challengeSaving(challenge), 2)} kg CO₂e`);

    challengeCardHtml = `
      <div class="kpi-card grad-green reveal reveal-up" style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 1.5rem; padding: 2rem;">
        <div class="eyebrow" style="margin-bottom: 0;">TODAY'S ECO CHALLENGE</div>
        <div style="display:flex; align-items:flex-start; gap: 1rem;">
          <div class="kpi-icon">${icon("target", 24)}</div>
          <div>
            <h3 style="margin:0; font-size:1.4rem;">${challenge.title || ''}</h3>
            ${challenge.description ? `<p style="margin:0.5rem 0 0.5rem; color:var(--color-text-muted); font-size:1rem;">${challenge.description}</p>` : ''}
            ${challenge.action ? `<p style="margin:0 0 1rem; font-size:1rem;"><strong>Do this:</strong> ${challenge.action}</p>` : ''}
            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
              ${tags.map((t) => `<span style="background: rgba(255,255,255,0.4); padding: 0.25rem 0.75rem; border-radius: 99px; font-size: 0.85rem; font-weight: 600;">${t}</span>`).join('')}
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-primary js-complete-challenge" data-challenge-id="${window.EcoData.attr(challenge.id)}" style="align-self: flex-start; margin-left: 3.5rem;">Complete Challenge</button>
        <p style="margin:-1rem 0 0 3.5rem; font-size:0.85rem; color:var(--color-text-muted);">One challenge per day, for ${window.EcoData.prettyDate(challenge.challenge_date, tz)}.</p>
      </div>`;
  }

  const isCompleted = !!(challenge && challenge.status === 'completed');
  const tick = (on) => `<span style="color:${on ? '#2DBE8E' : 'var(--color-text-muted)'};">${on ? icon("checkCircle", 20) : '○'}</span>`;

  const html = `
  <section class="results-page">
    <div class="results-bg" aria-hidden="true">
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
      <span class="leaf leaf-1" style="--rot:-18deg">${icon("leaf", 22)}</span>
      <span class="leaf leaf-3" style="--rot:12deg">${icon("leaf", 26)}</span>
    </div>
    <div class="container">
      <header class="results-hero reveal reveal-up">
        <span class="eyebrow">Your Eco Streak 🌱</span>
        <h1>${cur > 0 ? `${cur} day${cur === 1 ? '' : 's'} strong` : 'Your journey <span class="text-gradient">starts today</span>'}</h1>
        <p style="color:var(--color-text-muted); max-width: 46rem; margin: 0 auto;">
          Your streak is tracked against your local day (${tz}). Come back each day to keep it alive.
        </p>
      </header>

      <div class="metric-grid" style="margin-bottom: 2rem;">
        ${challengeCardHtml}
      </div>

      <div class="score-layout" style="grid-template-columns: 1fr; margin-bottom: 2rem;">
        <div class="grade-card reveal reveal-up">
          <div class="grade-body" style="padding: 1.5rem;">
            <div class="grade-title" style="margin-bottom: 1rem; font-size: 1.1rem;">TODAY'S PROGRESS</div>
            <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.75rem;">
              <li style="display:flex; align-items:center; gap: 0.75rem;">${tick(challenge && challenge.status !== 'no_assessment')} Challenge Assigned</li>
              <li style="display:flex; align-items:center; gap: 0.75rem;">${tick(isCompleted)} Challenge Completed</li>
              <li style="display:flex; align-items:center; gap: 0.75rem;">${tick(isCompleted)} Carbon Saved</li>
              <li style="display:flex; align-items:center; gap: 0.75rem;">${tick(isCompleted)} Streak Updated</li>
            </ul>
          </div>
        </div>
      </div>

      <h2 style="font-size: 1.4rem; margin-bottom: 1rem; margin-top: 3rem;" class="reveal reveal-up">Your Eco Profile</h2>
      <div class="metric-grid" style="margin-bottom: 3rem;">
        ${assessment
          ? kpi("chart", window.EcoData.num(assessment.monthly_footprint, 1) + " kg CO₂e", "Monthly Footprint", "")
            + kpi("trophy", assessment.eco_grade || "—", "Eco Grade", "")
            + kpi("trendDown", window.EcoData.categoryLabel(assessment.target_category), "Main Improvement Area", "")
          : '<div class="kpi-card" style="grid-column: 1/-1">Complete your assessment to receive your personalized daily goal.</div>'}
      </div>

      <h2 style="font-size: 1.4rem; margin-bottom: 1rem; margin-top: 3rem;" class="reveal reveal-up">Your Impact</h2>
      <div class="metric-grid" style="margin-bottom: 2rem;">
        ${kpi("flame", `<span style="color:#EF6351">${cur} day${cur === 1 ? '' : 's'}</span>`, "Current Streak", "grad-orange")}
        ${kpi("bolt", `${window.EcoData.num(saved, 1)} kg CO₂e`, "Total Carbon Saved", "grad-green")}
        ${kpi("checkCircle", `${done}`, "Challenges Completed", "grad-beige")}
        ${kpi("trophy", `${best} day${best === 1 ? '' : 's'}`, "Longest Streak", "grad-ink")}
      </div>
      <p style="text-align:center; color:var(--color-text-muted); font-size:0.9rem; margin-bottom: 4rem;">
        <a href="history.html" style="color:inherit;">See your full history →</a>
      </p>
    </div>
  </section>`;

  setAppHtml(html);
  initPageEffects(document.getElementById("app"));
  bindCompleteChallengeButtons(document.getElementById("app"));
};

// Wires every "Complete Challenge" button inside a freshly rendered
// dashboard. The id is read from the data attribute, exactly as the
// server supplied it, and handed to completeDailyChallenge() unmodified.
// Delegated from the app root so it keeps working after a re-render.
function bindCompleteChallengeButtons(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const buttons = root.querySelectorAll(".js-complete-challenge");
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    // Guard against double-binding if the same node is seen twice.
    if (btn.dataset && btn.dataset.etBound === "1") continue;
    if (btn.dataset) btn.dataset.etBound = "1";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      const id = btn.dataset ? btn.dataset.challengeId : "";
      window.completeDailyChallenge(id, btn);
    });
  }
}

// ---------------------- Init ----------------------
window.addEventListener("load", router);

// Test/dev hook
if (typeof window !== "undefined") {
  window.__ecoTrack = {
    calculateResults,
    get state() { return appState; },
    BENCHMARK,
    GRID_FACTOR_KG_PER_KWH,
    WASTE_TIER_DAILY_KG,
    TRANSPORT_FACTORS,
    RENEWABLE_MULTIPLIER,
    RECYCLE_MULTIPLIER,
    AVG_HOME_ELEC_MONTHLY,
    conservationIndex,
    vsBenchmarkPercent,
    footprintRatio,
    gaugeNeedleAngle,
    mountGauge,
    transportFactor,
    gradeFromIndex,
    renderDashboard,
  };
}
