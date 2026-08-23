// ============================================================
// EcoTrack — Assessment History page (frontend-only)
// ------------------------------------------------------------
// Responsibilities:
//   1. LOGIN PROTECTION: redirect to login.html when no session
//   2. Show ONLY the logged-in user's assessments (filter by email)
//   3. Render each saved assessment (FOR LOOP)
//   4. View Details toggle per assessment
//   5. Delete a single assessment after confirmation
// Data lives in localStorage under "assessmentHistory" and was
// written automatically after each completed assessment.
// ============================================================

"use strict";

// ---------------------- Constants & storage helpers ----------------------
const HIST_CURRENT_USER_KEY = "currentUser";
const HIST_HISTORY_KEY = "assessmentHistory";

function histGetCurrentUser() {
  const raw = localStorage.getItem(HIST_CURRENT_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function histReadAllHistory() {
  try {
    const raw = localStorage.getItem(HIST_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn("EcoTrack history: unreadable data.", e);
    return [];
  }
}

function histWriteHistory(list) {
  localStorage.setItem(HIST_HISTORY_KEY, JSON.stringify(list));
}

// ---------------------- LOGIN PROTECTION ----------------------
// A logged-out visitor must never see this page (Case 4 in tests).
const histUser = histGetCurrentUser();
if (!histUser) {
  // No currentUser -> go to login, which explains why (auth=required),
  // and returns here afterwards (next=history).
  window.location.href = "login.html?auth=required&next=history";
}

// ---------------------- Formatting helpers ----------------------
function fmtKg(n, d) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d == null ? 1 : d, maximumFractionDigits: d == null ? 1 : d });
}
function yesNo(v) { return v ? "Yes" : "No"; }

const MODE_LABELS = {
  car: "Car", bike: "Motorbike", bus: "Bus", train: "Train",
  metro: "Metro", bicycle: "Bicycle", walking: "Walking",
};

// Human-readable summary lines for one assessment entry.
function detailLines(item) {
  const t = item.transport || {};
  const e = item.electricity || {};
  const w = item.waste || {};
  const tierKg = { 1: "≈0.5 kg/day", 2: "≈1 kg/day", 3: "≈2 kg/day" }[w.tier] || String(w.tier);
  return [
    "<h4>Transport</h4><p>" +
      "Mode: <code>" + (MODE_LABELS[t.mode] || t.mode || "—") + "</code> · " +
      "Fuel: <code>" + (t.fuel ? (t.fuel === "cng" ? "CNG" : t.fuel.charAt(0).toUpperCase() + t.fuel.slice(1)) : "N/A") + "</code><br />" +
      "Distance: <code>" + t.distance + " km/day</code> · " +
      "Days/week: <code>" + t.days + "</code> · " +
      "Travelling together: <code>" + t.occupancy + "</code></p>",
    "<h4>Electricity</h4><p>" +
      "Usage: <code>" + e.kwh + " kWh/month</code> · " +
      "People in household: <code>" + e.people + "</code> · " +
      "Renewable source: <code>" + yesNo(e.renewable) + "</code></p>",
    "<h4>Waste</h4><p>" +
      "Generation tier: <code>" + tierKg + "</code> · " +
      "Recycling practiced: <code>" + yesNo(w.recycle) + "</code></p>",
    "<h4>Result</h4><p>" +
      "Transport <code>" + fmtKg((item.monthlyBreakdown || {}).transport) + " kg/mo</code> · " +
      "Electricity <code>" + fmtKg((item.monthlyBreakdown || {}).electricity) + " kg/mo</code> · " +
      "Waste <code>" + fmtKg((item.monthlyBreakdown || {}).waste) + " kg/mo</code><br />" +
      "Yearly total: <code>" + fmtKg(item.totalFootprint, 1) + " kg CO₂e/year</code> · " +
      "Conservation Index: <code>" + Number(item.conservationIndex).toFixed(1) + "%</code></p>",
  ].join("");
}

// Build ONE history card's HTML from an entry object.
function historyCardHtml(item, numberLabel) {
  const b = item.monthlyBreakdown || {};
  const grade = item.grade ? '<span class="hist-grade">Grade ' + item.grade + "</span>" : "";
  return (
    '<article class="hist-card" data-id="' + item.id + '">' +
      '<div class="hist-card-top">' +
        '<span class="hist-num">' + numberLabel + "</span>" +
        '<span class="hist-date-badge">Date: ' + item.date + "</span>" +
        grade +
      "</div>" +
      '<div class="hist-footprint-line">' +
        '<span class="hist-total">' + fmtKg(item.monthlyFootprint) + "</span>" +
        '<span class="hist-total-unit">kg CO₂e / month</span>' +
      "</div>" +
      '<div class="hist-cats">' +
        '<div class="hist-cat cat-transport">Transport<b>' + fmtKg(b.transport) + " kg</b></div>" +
        '<div class="hist-cat cat-electricity">Electricity<b>' + fmtKg(b.electricity) + " kg</b></div>" +
        '<div class="hist-cat cat-waste">Waste<b>' + fmtKg(b.waste) + " kg</b></div>" +
      "</div>" +
      '<div class="hist-details">' + detailLines(item) + "</div>" +
      '<div class="hist-actions">' +
        '<button type="button" class="hist-action" data-details>View Details</button>' +
        '<button type="button" class="hist-action danger" data-delete>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
          "Delete</button>" +
      "</div>" +
    "</article>"
  );
}

// ============================================================
// RENDER — user-specific history
// ============================================================
function renderHistory() {
  const allHistory = histReadAllHistory();

  // USER-SPECIFIC FILTER: only entries tagged with THIS user's email.
  // One user can never see another user's assessments.
  const userHistory = allHistory.filter(function (item) {
    return item.email === histUser.email;
  });

  const listEl = document.getElementById("hist-list");
  const emptyEl = document.getElementById("hist-empty");
  const statsEl = document.getElementById("hist-stats");

  listEl.innerHTML = "";

  if (!userHistory.length) {
    emptyEl.hidden = false;
    statsEl.hidden = true;
    return;
  }
  emptyEl.hidden = true;

  // Newest first (id is a timestamp).
  userHistory.sort(function (a, b) { return b.id - a.id; });

  // FOR LOOP - processes/displays multiple history records.
  // Each pass builds one card for one saved assessment.
  for (let i = 0; i < userHistory.length; i++) {
    const label = "Assessment #" + (userHistory.length - i);
    listEl.innerHTML += historyCardHtml(userHistory[i], label);
  }

  // ---- Summary strip (computed with another small for loop) ----
  let sum = 0;
  let bestIndex = -Infinity;
  for (let i = 0; i < userHistory.length; i++) {
    sum += Number(userHistory[i].monthlyFootprint) || 0;
    bestIndex = Math.max(bestIndex, Number(userHistory[i].conservationIndex) || 0);
  }
  document.getElementById("stat-count").textContent = String(userHistory.length);
  document.getElementById("stat-avg").textContent = fmtKg(sum / userHistory.length);
  document.getElementById("stat-best").textContent = Number(bestIndex).toFixed(1) + "%";
  statsEl.hidden = false;
}

// ============================================================
// EVENTS — details toggle + single-item delete
// ============================================================
function bindListActions() {
  const listEl = document.getElementById("hist-list");

  listEl.addEventListener("click", function (e) {
    const card = e.target.closest(".hist-card");
    if (!card) return;
    const idNum = Number(card.getAttribute("data-id"));

    // View Details — expand/collapse this card's input summary.
    if (e.target.closest("[data-details]")) {
      card.classList.toggle("open");
      const btn = card.querySelector("[data-details]");
      btn.textContent = card.classList.contains("open") ? "Hide Details" : "View Details";
      return;
    }

    // Delete — remove ONLY this assessment, after confirmation.
    if (e.target.closest("[data-delete]")) {
      const ok = window.confirm("Delete this assessment permanently?\nThis removes only this one entry.");
      if (!ok) return;

      const all = histReadAllHistory();
      // Find its position in the FULL array (entries are email-tagged,
      // and ids are unique, so deleting by id never touches other users).
      let targetIdx = -1;
      let i = 0;
      while (i < all.length) {          // small search loop to locate the entry
        if (all[i].id === idNum && all[i].email === histUser.email) {
          targetIdx = i;
          break;
        }
        i++;
      }
      if (targetIdx !== -1) {
        all.splice(targetIdx, 1);       // remove just that one assessment
        histWriteHistory(all);
        renderHistory();                // refresh the displayed list
      }
    }
  });
}

// ---------------------- Topbar user area + logout ----------------------
function initTopbar() {
  document.getElementById("hist-user-chip").hidden = false;
  document.getElementById("hist-name").textContent =
    String(histUser.name || "User").trim().split(/\s+/)[0];
  document.getElementById("hist-avatar").textContent =
    String(histUser.name || "U").trim().charAt(0).toUpperCase();

  // Logout: remove ONLY the session — accounts and history remain.
  document.getElementById("hist-logout").addEventListener("click", function () {
    localStorage.removeItem(HIST_CURRENT_USER_KEY);
    window.location.href = "login.html";
  });
}

// ---------------------- Init ----------------------
if (histUser) {           // only render when the guard above passed
  initTopbar();
  bindListActions();
  renderHistory();
}
