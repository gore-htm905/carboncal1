// ============================================================
// EcoTrack — Login & Registration system (frontend-only)
// ------------------------------------------------------------
// Academic demonstration of JavaScript syllabus concepts:
//   variables, data types, objects, arrays, functions,
//   conditions, LOOPS (for / while / do...while), classes,
//   DOM manipulation, events, validation, localStorage.
//
// Storage keys used (all inside localStorage):
//   "users"        -> array of registered user objects
//   "currentUser"  -> object for the currently logged-in user
// No backend, no external authentication services.
// ============================================================

"use strict";

// ---------------------- Constants (variables) ----------------------
const USERS_KEY = "users";                 // localStorage key holding the users ARRAY
const CURRENT_USER_KEY = "currentUser";    // localStorage key holding the logged-in user OBJECT
const MIN_PASSWORD_LENGTH = 6;             // reasonable minimum password length (number data type)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // simple email format check (RegExp)

// ---------------------- CLASS — user account blueprint ----------------------
// A simple class demonstrating constructors, instance methods and getters.
class UserAccount {
  constructor(name, email, password) {
    this.name = name;         // string
    this.email = email;       // string (stored lowercase)
    this.password = password; // string (frontend-only academic demo)
  }
  // Getter returns the first name only — used for "Welcome, <name>".
  get firstName() {
    return this.name.trim().split(/\s+/)[0] || "User";
  }
}

// ---------------------- Functions: localStorage helpers ----------------------
// Read the registered-users array from localStorage.
function getUsers() {
  const raw = localStorage.getItem(USERS_KEY);      // always a string or null
  if (!raw) return [];                              // no users yet -> empty array
  try {
    return JSON.parse(raw);                         // parse JSON text back into an array
  } catch (e) {
    console.warn("EcoTrack auth: corrupted users data, resetting.", e);
    return [];
  }
}

// Write the users array back to localStorage as JSON text.
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// Get the currently logged-in user (or null).
function getCurrentUser() {
  const raw = localStorage.getItem(CURRENT_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Store the logged-in user (called after successful login).
function setCurrentUser(user) {
  localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
}

// Remove only the login session (used by Logout). Accounts/history stay.
function clearCurrentUser() {
  localStorage.removeItem(CURRENT_USER_KEY);
}

// ---------------------- WHILE LOOP — searches registered users ----------------------
// This function performs the ACTUAL user search used by:
//   1. Registration  -> to block duplicate emails
//   2. Login         -> to find the account by email
// A while loop walks the array one item at a time until a match is found.
function findUserByEmail(users, email) {
  let i = 0;                        // loop counter variable
  while (i < users.length) {        // WHILE LOOP - searches registered users
    if (users[i].email === email) {
      return users[i];              // found: stop searching immediately
    }
    i++;                            // move to the next registered user
  }
  return null;                      // searched every entry — no match
}

// ---------------------- DOM helpers ----------------------
function fieldById(id) {
  return document.getElementById(id);
}

// Show a validation message under one field and mark it invalid.
function setFieldError(inputEl, errorId, message) {
  inputEl.closest(".auth-field").classList.add("invalid");
  const errEl = fieldById(errorId);
  if (errEl) errEl.textContent = message;
}

// Clear the validation state of one field.
function clearFieldError(fieldWrap) {
  fieldWrap.classList.remove("invalid");
  const errEl = fieldWrap.querySelector(".auth-error");
  if (errEl) errEl.textContent = "";
}

// Show the banner at the top of the card (success / error / info).
function showAlert(type, html) {
  const box = document.getElementById("auth-alert");
  if (!box) return;
  box.className = "auth-alert " + type;   // replaces hidden class combo
  box.innerHTML = html;
  box.hidden = false;
}

// Simple email format validator (condition + RegExp test).
function isValidEmail(email) {
  return EMAIL_PATTERN.test(email);
}

// ============================================================
// FOR LOOP — initializes repeated UI elements
// Every .auth-field input gets an "input" listener that clears its
// error state while the user types. One loop wires all fields.
// ============================================================
function initFieldListeners() {
  const inputs = document.querySelectorAll(".auth-field input");
  for (let i = 0; i < inputs.length; i++) {          // FOR LOOP - processes repeated form fields
    const wrap = inputs[i].closest(".auth-field");
    inputs[i].addEventListener("input", function () {
      clearFieldError(wrap);
    });
  }
}

// Password show/hide eye buttons.
function initPasswordEyes() {
  const eyes = document.querySelectorAll(".auth-eye");
  for (let i = 0; i < eyes.length; i++) {
    eyes[i].addEventListener("click", function () {
      const target = fieldById(this.getAttribute("data-eye-for"));
      if (!target) return;
      const showing = target.type === "text";
      target.type = showing ? "password" : "text";
      this.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  }
}

// ============================================================
// REGISTRATION
// ============================================================
const registerForm = document.getElementById("register-form");

if (registerForm) {
  registerForm.addEventListener("submit", async function (e) {
    e.preventDefault();

    const name = document.getElementById("reg-name").value.trim();
    const email = document.getElementById("reg-email").value.trim().toLowerCase();
    const password = document.getElementById("reg-password").value;
    const confirm = document.getElementById("reg-confirm").value;

    const fields = [
      { id: "reg-name", errorId: "reg-name-error",
        validate: function () {
          if (!name) return "Please enter your full name.";
          return null;
        } },
      { id: "reg-email", errorId: "reg-email-error",
        validate: function () {
          if (!email) return "Please enter your email.";
          if (!isValidEmail(email)) return "Please enter a valid email address.";
          return null;
        } },
      { id: "reg-password", errorId: "reg-password-error",
        validate: function () {
          if (!password) return "Please enter a password.";
          if (password.length < MIN_PASSWORD_LENGTH) {
            return "Password must be at least " + MIN_PASSWORD_LENGTH + " characters.";
          }
          return null;
        } },
      { id: "reg-confirm", errorId: "reg-confirm-error",
        validate: function () {
          if (!confirm) return "Please confirm your password.";
          if (confirm !== password) return "Passwords do not match.";
          return null;
        } },
    ];

    let firstInvalid = null;
    let fIndex = 0;
    do {
      const field = fields[fIndex];
      const inputEl = document.getElementById(field.id);
      const message = field.validate();
      if (message) {
        setFieldError(inputEl, field.errorId, message);
        if (!firstInvalid) firstInvalid = inputEl;
      } else {
        clearFieldError(inputEl.closest(".auth-field"));
      }
      fIndex++;
    } while (fIndex < fields.length);

    if (firstInvalid) {
      firstInvalid.focus();
      showAlert("error", "Please fix the highlighted fields and try again.");
      return;
    }

    if (!window.ecoTrackSupabase) {
      showAlert("error", "Supabase client not initialized.");
      return;
    }

    const btn = document.getElementById("register-submit");
    btn.disabled = true;
    btn.textContent = "Creating account...";

    const { data, error } = await window.ecoTrackSupabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: { full_name: name }
      }
    });

    if (error) {
      showAlert("error", "<b>Registration failed.</b> " + error.message);
      btn.disabled = false;
      btn.textContent = "Create account";
      return;
    }

    btn.textContent = "Account created ✓";
    showAlert("success", "<b>Registration successful!</b> Redirecting you to login…");
    setTimeout(function () {
      window.location.href = "login.html?registered=1&email=" + encodeURIComponent(email);
    }, 900);
  });
}

// ============================================================
// LOGIN
// ============================================================
const loginForm = document.getElementById("login-form");

if (loginForm) {
  loginForm.addEventListener("submit", async function (e) {
    e.preventDefault();

    const email = document.getElementById("login-email").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;
    const emailInput = document.getElementById("login-email");
    const passwordInput = document.getElementById("login-password");

    let hasError = false;
    if (!email) {
      setFieldError(emailInput, "login-email-error", "Please enter your email.");
      hasError = true;
    } else if (!isValidEmail(email)) {
      setFieldError(emailInput, "login-email-error", "Please enter a valid email address.");
      hasError = true;
    } else {
      clearFieldError(emailInput.closest(".auth-field"));
    }
    if (!password) {
      setFieldError(passwordInput, "login-password-error", "Please enter your password.");
      hasError = true;
    } else {
      clearFieldError(passwordInput.closest(".auth-field"));
    }
    if (hasError) return;

    if (!window.ecoTrackSupabase) {
      showAlert("error", "Supabase client not initialized.");
      return;
    }

    const btn = document.getElementById("login-submit");
    btn.disabled = true;
    btn.textContent = "Logging in...";

    const { data, error } = await window.ecoTrackSupabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      showAlert("error", "<b>Login failed.</b> " + error.message);
      btn.disabled = false;
      btn.textContent = "Login";
      return;
    }

    // Start a FRESH assessment session for this user (removes any draft
    // state left over from another visitor of this browser).
    localStorage.removeItem("ecoTrack_v1");

    btn.textContent = "Login successful ✓";

    const params = new URLSearchParams(window.location.search);
    const next = params.get("next");
    setTimeout(function () {
      window.location.href = next === "history" ? "history.html" : "index.html";
    }, 700);
  });

  // ---- Prefill + banners driven by URL parameters ----
  const params = new URLSearchParams(window.location.search);

  if (params.get("registered") === "1") {
    showAlert(
      "success",
      "<b>Registration successful!</b> Your account was saved — you can log in below."
    );
    const preEmail = params.get("email");
    if (preEmail) document.getElementById("login-email").value = preEmail;
  }

  if (params.get("auth") === "required") {
    showAlert(
      "info",
      "<b>Please login first to start your assessment.</b><br />" +
      "Your assessment history will be saved to your account."
    );
  }

  // Already logged in? Offer a quick way back instead of logging in again.
  const existing = getCurrentUser();
  if (existing) {
    showAlert(
      "info",
      "You are already logged in as <b>" + existing.name.replace(/</g, "&lt;") + "</b>." +
      '<span class="alert-actions">' +
      '<a class="alert-btn" href="index.html">Continue</a>' +
      '<button type="button" class="alert-btn" id="switch-user">Use another account</button>' +
      "</span>"
    );
    const switchBtn = document.getElementById("switch-user");
    if (switchBtn) {
      switchBtn.addEventListener("click", function () {
        clearCurrentUser(); // logout only — account & history are kept
        location.reload();  // reload shows a clean login form
      });
    }
  }
}

// ---- Shared init (runs on whichever auth page loaded this file) ----
initFieldListeners();
initPasswordEyes();
