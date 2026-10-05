// ============================================================
// EcoTrack — Assessment History page
// ------------------------------------------------------------
// Everything on this page comes from Postgres:
//   * assessments  — the signed-in user's own rows, read straight from
//     the table (RLS already restricts it to that one user).
//   * challenges   — get_my_history() for streak totals plus the day
//     by day challenge log.
// Nothing is read from localStorage and nothing is invented, so an
// empty account genuinely shows the empty state.
// ============================================================

"use strict";

function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setHistoryMessage(text) {
  const el = document.getElementById("hist-message");
  if (el) {
    el.textContent = text || "";
    el.hidden = !text;
  }
}

// Show or clear the load-failure banner. Called on every path so a stale
// error can never sit above a list that actually loaded fine.
function setHistoryError(text) {
  const el = document.getElementById("hist-error");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

async function renderHistory() {
  const supabase = window.ecoTrackSupabase;
  const data = window.EcoData;

  const listEl = document.getElementById("hist-list");
  const emptyEl = document.getElementById("hist-empty");
  const statsEl = document.getElementById("hist-stats");

  if (!supabase || !data) {
    setHistoryError("Could not reach EcoTrack's data service. Please refresh and try again.");
    return;
  }

  const user = await data.currentUser();
  if (!user) {
    window.location.href = "login.html?auth=required&next=history";
    return;
  }

  const userName = String(user.user_metadata?.full_name || user.email || "User").trim();
  const firstName = userName.split(/\s+/)[0];

  const chip = document.getElementById("hist-user-chip");
  if (chip) chip.hidden = false;
  const nameEl = document.getElementById("hist-name");
  if (nameEl) nameEl.textContent = firstName;
  const avatarEl = document.getElementById("hist-avatar");
  if (avatarEl) avatarEl.textContent = firstName.charAt(0).toUpperCase();

  const logoutBtn = document.getElementById("hist-logout");
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.dataset.bound = "1";
    logoutBtn.addEventListener("click", async () => {
      await supabase.auth.signOut();
      window.location.href = "login.html";
    });
  }

  // ---- Read the data ------------------------------------------------
  // Both calls are independent, so run them together.
  let history = null;
  let assessments = [];
  let loadError = null;

  const [historyResult, assessmentResult] = await Promise.allSettled([
    data.getHistory(200),
    supabase
      .from("assessments")
      .select("id, created_at, monthly_footprint, eco_grade, eco_score, transport_emission, electricity_emission, waste_emission, assessment_data")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (historyResult.status === "fulfilled") {
    history = historyResult.value;
  } else {
    loadError = historyResult.reason;
  }

  if (assessmentResult.status === "fulfilled") {
    const { data: rows, error } = assessmentResult.value;
    if (error) loadError = loadError || error;
    else assessments = rows || [];
  } else {
    loadError = loadError || assessmentResult.reason;
  }

  if (loadError) {
    console.error("EcoTrack: history could not be loaded.", loadError);
    setHistoryError("Your history could not be loaded right now. Please refresh and try again.");
    if (statsEl) statsEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    if (listEl) listEl.innerHTML = "";
    return;
  }
  // Everything below is a successful load, so clear any earlier banner.
  setHistoryError("");

  const streak = (history && history.streak) || {};
  const challenges = (history && history.challenges) || [];
  const assessmentCount = (history && history.assessment_count) || assessments.length;
  const tz = data.deviceTimezone();

  if (!challenges.length && !assessments.length) {
    if (emptyEl) emptyEl.hidden = false;
    if (statsEl) statsEl.hidden = true;
    if (listEl) listEl.innerHTML = "";
    setHistoryMessage("");
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (statsEl) statsEl.hidden = false;

  // ---- Summary strip ------------------------------------------------
  // Averages are computed from this user's own rows in the browser;
  // no total or average is invented when there is nothing to average.
  // asNumber semantics: a null/"" column must not become a real 0.
  const asNum = (v) =>
    v === null || v === undefined || v === "" ? NaN : Number(v);

  const footprints = assessments.map((r) => asNum(r.monthly_footprint)).filter(Number.isFinite);
  const scores = assessments.map((r) => asNum(r.eco_score)).filter(Number.isFinite);

  const avgFootprint = footprints.length
    ? data.num(footprints.reduce((a, b) => a + b, 0) / footprints.length, 1)
    : "—";
  const bestScore = scores.length ? data.num(Math.min.apply(null, scores), 1) : "—";

  const setStat = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setStat("stat-count", assessmentCount);
  setStat("stat-avg", avgFootprint);
  setStat("stat-best", bestScore);

  setStat("stat-streak-current", `${Number(streak.current_streak) || 0} / ${Number(streak.longest_streak) || 0}`);
  setStat("stat-saved", data.num(streak.total_carbon_saved, 1));

  // ---- Build the list ----------------------------------------------
  if (!listEl) return;
  listEl.innerHTML = "";

  const section = (title, subtitle) => {
    const head = document.createElement("div");
    head.className = "hist-section-head";
    head.innerHTML = `<h2>${esc(title)}</h2><p>${esc(subtitle)}</p>`;
    listEl.appendChild(head);
  };

  const card = (html) => {
    const article = document.createElement("article");
    article.className = "hist-card";
    article.innerHTML = html;
    listEl.appendChild(article);
  };

  if (assessments.length) {
    section(
      "Carbon assessments",
      `${assessmentCount} completed · newest first`
    );

    for (let i = 0; i < assessments.length; i++) {
      const row = assessments[i];
      const extra = row.assessment_data || {};
      const grade = row.eco_grade || extra.grade || "—";
      const parts = [];
      if (Number.isFinite(asNum(row.transport_emission))) {
        parts.push(`Transport ${data.num(row.transport_emission, 1)} kg`);
      }
      if (Number.isFinite(asNum(row.electricity_emission))) {
        parts.push(`Electricity ${data.num(row.electricity_emission, 1)} kg`);
      }
      if (Number.isFinite(asNum(row.waste_emission))) {
        parts.push(`Waste ${data.num(row.waste_emission, 1)} kg`);
      }

      card(`
        <div class="hist-card-top">
          <span class="hist-num">Assessment</span>
          <span class="hist-date-badge">${esc(data.prettyDateTime(row.created_at, tz))}</span>
          <span class="hist-grade" style="background:#0F9D6E;color:#fff;">${esc(grade)}</span>
        </div>
        <div style="margin-top: 1rem;">
          <h3 style="margin: 0 0 0.5rem;">${data.num(row.monthly_footprint, 1)} kg CO₂e per month</h3>
          <p style="margin:0; color:#64748B;">
            Conservation Index ${data.num(row.eco_score, 1)}${parts.length ? " · " + esc(parts.join(" · ")) : ""}
          </p>
          ${extra.highest_contributor ? `<p style="margin:0.5rem 0 0; color:#64748B;">Largest contributor: ${esc(extra.highest_contributor)}</p>` : ""}
        </div>
        <div class="hist-footprint-line" style="margin-top:1rem;">
          <span class="hist-total" style="color:#0F9D6E;">${data.num(Number.isFinite(asNum(row.monthly_footprint)) ? asNum(row.monthly_footprint) * 12 : null, 0)}</span>
          <span class="hist-total-unit">kg CO₂e per year</span>
        </div>
      `);
    }
  }

  if (challenges.length) {
    section(
      "Daily challenges",
      `${Number(streak.challenges_completed) || 0} completed of ${challenges.length} assigned`
    );

    for (let i = 0; i < challenges.length; i++) {
      const row = challenges[i];
      const isCompleted = row.status === "completed";
      card(`
        <div class="hist-card-top">
          <span class="hist-num">Challenge</span>
          <span class="hist-date-badge">${esc(data.prettyDate(row.challenge_date, tz))}</span>
          ${
            isCompleted
              ? '<span class="hist-grade" style="background:#2DBE8E;color:white;">Completed</span>'
              : '<span class="hist-grade" style="background:#E2E8F0;color:#64748B;">Pending</span>'
          }
        </div>
        <div style="margin-top: 1rem;">
          <h3 style="margin: 0 0 0.5rem;">${esc(row.title || "Untitled challenge")}</h3>
          <p style="margin:0; color:#64748B;">Category: ${esc(data.categoryLabel(row.category))}${
            row.difficulty ? " · " + esc(row.difficulty) : ""
          }</p>
        </div>
        ${
          isCompleted
            ? `<div class="hist-footprint-line" style="margin-top:1rem;">
                 <span class="hist-total" style="color:#2DBE8E;">${data.num(data.challengeSaving(row) ?? row.carbon_saved, 2)}</span>
                 <span class="hist-total-unit">kg CO₂e saved${
                   row.completed_at ? " · " + esc(data.prettyDateTime(row.completed_at, tz)) : ""
                 }</span>
               </div>`
            : ""
        }
      `);
    }
  }

  setHistoryMessage("");
}

document.addEventListener("DOMContentLoaded", function () {
  renderHistory();
});