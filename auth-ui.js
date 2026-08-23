// ============================================================
// EcoTrack — Authentication UI bridge (index.html only)
// ------------------------------------------------------------
// Responsibilities:
//   1. Show "Welcome, <First Name>" in the navbar when logged in
//   2. Toggle Login button / Logout button / History nav link
//   3. Logout: remove ONLY the session ("currentUser")
//   4. Guard the calculator so an assessment cannot start while
//      logged out (used by script.js via window.ecoTrackRequireLogin)
//   5. Save each COMPLETED assessment to the logged-in user's
//      history (used by script.js via window.saveEcoTrackHistory)
//
// This file never touches calculation logic — script.js remains
// the single owner of all formulas and flow.
// ============================================================

"use strict";

// ---------------------- Constants ----------------------
const ET_CURRENT_USER_KEY = "currentUser";     // logged-in session key
const ET_HISTORY_KEY = "assessmentHistory";    // ALL users' completed assessments

// ---------------------- Functions: storage helpers ----------------------
function etGetCurrentUser() {
  const raw = localStorage.getItem(ET_CURRENT_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Read every saved assessment (all users). Filtering per user happens later.
function etReadHistory() {
  try {
    const raw = localStorage.getItem(ET_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn("EcoTrack: could not read assessment history.", e);
    return [];
  }
}

// First name from a full name string.
function etFirstName(fullName) {
  return String(fullName || "").trim().split(/\s+/)[0] || "User";
}

// ============================================================
// NAVBAR STATE — welcome chip, Login/Logout, History link
// ============================================================
function applyAuthState() {
  const user = etGetCurrentUser();

  // Collect every element that reacts to the auth state.
  const loginEls = document.querySelectorAll("[data-auth-login]");
  const logoutEls = document.querySelectorAll("[data-auth-logout]");
  const userChips = document.querySelectorAll("[data-auth-user]");
  const nameEls = document.querySelectorAll("[data-auth-name]");
  const avatarEls = document.querySelectorAll("[data-auth-avatar]");
  const historyEls = document.querySelectorAll("[data-auth-history]");

  // FOR LOOP - updating multiple navigation elements in one pass.
  // Each loop walks its element collection and syncs it with the
  // current login state stored in localStorage.
  for (let i = 0; i < nameEls.length; i++) {
    nameEls[i].textContent = user ? etFirstName(user.name) : "";
  }
  for (let i = 0; i < avatarEls.length; i++) {
    avatarEls[i].textContent = user ? etFirstName(user.name).charAt(0).toUpperCase() : "U";
  }
  for (let i = 0; i < userChips.length; i++) {
    userChips[i].hidden = !user;        // welcome chip visible only when logged in
  }
  for (let i = 0; i < logoutEls.length; i++) {
    logoutEls[i].hidden = !user;        // Logout visible only when logged in
  }
  for (let i = 0; i < loginEls.length; i++) {
    loginEls[i].hidden = !!user;        // Login visible only when logged out
  }
  for (let i = 0; i < historyEls.length; i++) {
    historyEls[i].hidden = !user;       // History link hidden when logged out
  }
}

// ============================================================
// LOGOUT — removes ONLY the current session.
// Registered accounts and assessment history remain untouched,
// so logging back in later restores everything.
// ============================================================
function bindLogoutButtons() {
  const buttons = document.querySelectorAll("[data-auth-logout]");
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      localStorage.removeItem("currentUser");   // end the session
      applyAuthState();                         // swap UI back to logged-out immediately
      window.location.href = "login.html";      // return to the login page
    });
  }
}

// ============================================================
// LOGIN REQUIRED — toast message before redirecting
// ============================================================
let etLoginRedirectPending = false;

function etShowLoginToast() {
  if (document.getElementById("et-auth-toast")) return; // already showing
  const toast = document.createElement("div");
  toast.id = "et-auth-toast";
  toast.className = "et-auth-toast";
  toast.setAttribute("role", "alert");
  toast.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' +
    '<div><div class="et-auth-toast-title">Login required</div>' +
    '<div class="et-auth-toast-text">Please login first to start your assessment.<br />' +
    "Your assessment history will be saved to your account.</div></div>";
  document.body.appendChild(toast);
}

// Called by script.js at the very top of renderCalculator().
// Returns true when a user is logged in (assessment proceeds).
// When logged out: shows the message, then redirects to login.html,
// and returns false so NO part of the assessment is rendered.
window.ecoTrackRequireLogin = function () {
  const user = etGetCurrentUser();
  if (user) return true;

  if (!etLoginRedirectPending) {
    etLoginRedirectPending = true;
    etShowLoginToast();
    setTimeout(function () {
      window.location.href = "login.html?auth=required";
    }, 1500);
  }
  return false;
};

// ============================================================
// HISTORY SAVER — called by script.js AFTER calculateResults()
// has produced final results (i.e., only on completion).
// One entry per completed assessment; entries are tagged with the
// user's email so each account sees only its own history.
// ============================================================
window.saveEcoTrackHistory = function (appState) {
  try {
    const user = etGetCurrentUser();
    if (!user || !appState || !appState.results || !appState.assessment) return;

    const r = appState.results;
    const a = appState.assessment;

    // New history entry built from the EXISTING app state — no new math.
    const entry = {
      id: Date.now(),                      // unique-ish id for deletion
      email: user.email,                   // ownership tag (user-specific history)
      date: new Date().toLocaleString(),   // human-readable timestamp
      transport: a.transport,              // { mode, fuel, distance, days, occupancy }
      electricity: a.electricity,          // { kwh, people, renewable }
      waste: a.waste,                      // { tier, recycle }
      monthlyBreakdown: r.monthly,         // { transport, electricity, waste } kg/mo
      monthlyFootprint: r.totalKg,         // total kg CO2e / month
      totalFootprint: r.totalKg * 12,      // total kg CO2e / year (simple sum of months)
      conservationIndex: r.conservationIndex,
      grade: r.grade,
    };

    const history = etReadHistory();
    history.push(entry);                   // never overwrite previous assessments
    localStorage.setItem(ET_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.warn("EcoTrack: failed to save assessment history.", e);
  }
};

// Keep the navbar in sync if another tab logs in/out.
window.addEventListener("storage", function () {
  applyAuthState();
});

// ---- Init ----
applyAuthState();
bindLogoutButtons();
