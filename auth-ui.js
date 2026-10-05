// ============================================================
// EcoTrack — Authentication UI bridge (index.html only)
// ------------------------------------------------------------
// Responsibilities:
//   1. Show "Welcome, <First Name>" in the navbar when logged in
//   2. Toggle Login button / Logout button / History nav link
//   3. Logout: remove ONLY the session ("currentUser")
//   4. Guard the calculator so an assessment cannot start while
//      logged out (used by script.js via window.ecoTrackRequireLogin)
//
// Assessment history is NOT stored here. Every completed assessment
// goes to Postgres through eco-data.js, and history.js reads it back
// from there, so no page needs a local copy any more.
// ============================================================

"use strict";

// ---------------------- State ----------------------
let currentSupabaseUser = null;

function etGetCurrentUser() {
  return currentSupabaseUser;
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
  const dashboardEls = document.querySelectorAll("[data-auth-dashboard]");

  // FOR LOOP - updating multiple navigation elements in one pass.
  // Each loop walks its element collection and syncs it with the
  // current login state stored in localStorage.
  for (let i = 0; i < nameEls.length; i++) {
    nameEls[i].textContent = user ? etFirstName(user.user_metadata?.full_name || user.email) : "";
  }
  for (let i = 0; i < avatarEls.length; i++) {
    avatarEls[i].textContent = user ? etFirstName(user.user_metadata?.full_name || user.email).charAt(0).toUpperCase() : "U";
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
  for (let i = 0; i < dashboardEls.length; i++) {
    dashboardEls[i].hidden = !user;     // Dashboard link hidden when logged out
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
    buttons[i].addEventListener("click", async function () {
      if (typeof window.ecoTrackSupabase !== 'undefined') {
        await window.ecoTrackSupabase.auth.signOut();
      }
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

// Keep the navbar in sync if another tab logs in/out.
window.addEventListener("storage", function () {
  applyAuthState();
});

// ---- Init ----
async function initAuthUI() {
  if (window.ecoTrackSupabase) {
    const { data: { session } } = await window.ecoTrackSupabase.auth.getSession();
    currentSupabaseUser = session ? session.user : null;
    applyAuthState();
    
    window.ecoTrackSupabase.auth.onAuthStateChange((event, session) => {
      currentSupabaseUser = session ? session.user : null;
      applyAuthState();
    });
  } else {
    applyAuthState();
  }
  bindLogoutButtons();
}

initAuthUI();
