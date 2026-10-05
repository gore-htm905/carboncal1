// ============================================================
// EcoTrack — Supabase data layer
// ------------------------------------------------------------
// Single place that talks to Postgres. Every page uses it, so
// there is exactly one definition of "where the numbers come from".
//
// Rules this file enforces:
//   * No random or invented numbers. Anything the UI shows is either
//     returned by the server or left blank.
//   * Carbon savings, streaks and the community totals are computed
//     by SECURITY DEFINER functions, never in the browser.
//   * The client never sends a carbon saving value when completing a
//     challenge — only the assignment id.
// ============================================================

"use strict";

(function () {

  // ---------------------- Small helpers ----------------------

  // IANA timezone of this device, e.g. "Asia/Kolkata". The server
  // validates it and falls back to UTC when it cannot use it.
  function deviceTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === "string" && tz ? tz : "UTC";
    } catch (e) {
      return "UTC";
    }
  }

  // YYYY-MM-DD for a given date in a given IANA zone. Used only for
  // display; the authoritative "today" always comes from the server.
  function dateInZone(dateObj, timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dateObj || new Date());
    } catch (e) {
      return null;
    }
  }

  function client() {
    return window.ecoTrackSupabase || null;
  }

  function requireClient() {
    const c = client();
    if (!c) {
      console.warn("EcoTrack: Supabase is not initialised yet.");
    }
    return c;
  }

  // Unwrap a PostgREST { data, error } pair into a value or throw.
  function unwrap({ data, error }, what) {
    if (error) {
      console.error(`[EcoTrack][${what || "Supabase"}]`, {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      const err = new Error(error.message || "request failed");
      err.code = error.code;
      err.what = what || "request";
      throw err;
    }
    return data;
  }

  // ---------------------- Session ----------------------

  async function currentUser() {
    const supabase = requireClient();
    if (!supabase) return null;
    try {
      const session = await supabase.auth.getSession();
      return session?.data?.session?.user || null;
    } catch (e) {
      console.warn("EcoTrack: could not read the session.", e);
      return null;
    }
  }

  async function isSignedIn() {
    return (await currentUser()) !== null;
  }

  // ---------------------- Assessments ----------------------
  //
  // Assessments are append-only: the RLS policy allows a signed-in
  // user to insert a row for their own id and to read their own rows,
  // but never to update or delete. Each completed run of the wizard
  // adds one row, so History can show how the footprint changed.

  async function saveAssessment(assessment, results) {
    const supabase = requireClient();
    if (!supabase) return null;

    const user = await currentUser();
    if (!user) {
      console.warn("EcoTrack: assessment not saved — not signed in.");
      return null;
    }
    if (!assessment || !results) return null;

    // Round on the way in so the stored value matches what the UI shows.
    const r2 = (n) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(2)) : 0);

    // The first assessment a user ever completes is their baseline.
    // A head-only count is cheap, and this preserves the flag the
    // original schema already carries.
    let isBaseline = false;
    try {
      const { count } = await supabase
        .from("assessments")
        .select("id", { count: "exact", head: true });
      isBaseline = !count;
    } catch (e) {
      // A failed count only costs the flag, never the assessment.
      console.warn("EcoTrack: could not determine the baseline flag.", e);
    }

    const row = {
      user_id: user.id,
      is_baseline: isBaseline,
      monthly_footprint: r2(results.totalKg),
      eco_score: r2(results.conservationIndex),
      eco_grade: results.grade || null,
      // Original required NOT NULL columns
      transport_data: assessment.transport || {},
      electricity_data: assessment.electricity || {},
      waste_data: assessment.waste || {},
      // New columns from migration
      transport_emission: r2(results.monthly?.transport),
      electricity_emission: r2(results.monthly?.electricity),
      waste_emission: r2(results.monthly?.waste),
      other_emission: 0,
      // The raw wizard answers, so History can show what was entered.
      assessment_data: {
        transport: assessment.transport || null,
        electricity: assessment.electricity || null,
        waste: assessment.waste || null,
        total_kg_per_month: r2(results.totalKg),
        total_kg_per_year: r2(results.totalKg * 12),
        conservation_index: r2(results.conservationIndex),
        grade: results.grade || null,
        highest_contributor: results.highestContributor?.name || null,
      },
    };

    // Validate payload
    if (!row.user_id) throw new Error("Assessment save failed: user_id is missing");
    if (!row.transport_data || Object.keys(row.transport_data).length === 0) {
      console.warn("EcoTrack: transport_data is empty");
    }

    const saved = unwrap(
      await supabase.from("assessments").insert(row).select("id, created_at").single(),
      "saveAssessment"
    );
    return saved || null;
  }

  // ---------------------- Daily challenge ----------------------

  // Returns the assignment for the user's own "today", creating it on
  // first call. Safe to call on every page load and on every refresh:
  // the server is idempotent.
  async function getTodayChallenge(timezone) {
    const supabase = requireClient();
    if (!supabase) return null;
    return unwrap(
      await supabase.rpc("get_today_challenge", { p_tz: timezone || deviceTimezone() }),
      "getTodayChallenge"
    );
  }

  // Newest assessment + streak + today's challenge in one round trip.
  async function getDashboard(timezone) {
    const supabase = requireClient();
    if (!supabase) return null;
    return unwrap(
      await supabase.rpc("get_my_dashboard", { p_tz: timezone || deviceTimezone() }),
      "getDashboard"
    );
  }

  // Completes a challenge. Only the assignment id travels over the
  // wire; the saving, the streak and the community total are all
  // decided by the server, and repeating the call is a no-op.
  //
  // The id is normalised to a STRING and passed through untouched.
  // It is deliberately never passed through Number()/parseInt():
  //   * user_challenges.id is a bigint today, so a UUID would become
  //     NaN and a large serial would lose precision past 2^53;
  //   * if the column ever becomes a uuid, the string still works
  //     with no change here.
  // PostgREST casts the JSON string to the RPC's declared parameter
  // type, so the database stays the only place that interprets the id.
  async function completeChallenge(assignmentId, timezone) {
    const supabase = requireClient();
    if (!supabase) return null;

    const id = String(assignmentId === null || assignmentId === undefined ? "" : assignmentId).trim();
    if (!id) {
      throw new Error("A valid challenge id is required.");
    }

    return unwrap(
      await supabase.rpc("complete_daily_challenge", {
        p_challenge_id: id,
        p_tz: timezone || deviceTimezone(),
      }),
      "completeChallenge"
    );
  }

  // ---------------------- History ----------------------

  async function getHistory(limit) {
    const supabase = requireClient();
    if (!supabase) return null;
    return unwrap(
      await supabase.rpc("get_my_history", { p_limit: limit || 100 }),
      "getHistory"
    );
  }

  // ---------------------- Community ----------------------
  //
  // Public on purpose: the landing page shows "N members" and
  // "X kg saved this month" before anyone logs in. The function
  // returns only those three fields — never a person's rows.

  async function getCommunityStats() {
    const supabase = requireClient();
    if (!supabase) return null;
    try {
      return unwrap(await supabase.rpc("get_community_stats"), "getCommunityStats");
    } catch (e) {
      console.warn("EcoTrack: community stats unavailable.", e);
      return null;
    }
  }

  // ---------------------- Template library ----------------------

  // Public, read-only list of every challenge in the library.
  async function getChallengeTemplates() {
    const supabase = requireClient();
    if (!supabase) return [];
    try {
      const rows = unwrap(
        await supabase
          .from("challenge_templates")
          .select("*")
          .order("category", { ascending: true })
          .order("title", { ascending: true }),
        "getChallengeTemplates"
      );
      return rows || [];
    } catch (e) {
      console.warn("EcoTrack: challenge library unavailable.", e);
      return [];
    }
  }

  // ---------------------- Formatting ----------------------
  // Presentation only. No value is invented here; a missing number
  // renders as an em dash rather than a zero.

  // Escape a value for use inside an HTML attribute.
  //
  // The challenge id is a server value that we must preserve exactly, so
  // it is stringified rather than parsed. Escaping stops a quote or angle
  // bracket in the value from breaking out of the attribute; the id
  // itself still reaches the handler untouched.
  function attr(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // The saving an assignment represents.
  //
  // While a challenge is still pending the server deliberately leaves
  // carbon_saved at 0 (the value is only written on completion, so it
  // cannot be pre-credited), and publishes the expected figure as
  // target_carbon_saving instead. Reading the wrong one of those two
  // would show "0.00 kg saved" on a challenge worth 3.4 kg, so this
  // picks the field that matches the challenge's status.
function challengeSaving(challenge) {
    if (!challenge) return null;
    const completed = String(challenge.status || "").toLowerCase() === "completed";
    const raw = completed ? challenge.carbon_saved : challenge.target_carbon_saving;
    const n = asNumber(raw);
    return Number.isFinite(n) ? n : null;
  }

  // Guard the empty cases explicitly. Number(null) and Number("") are both
  // 0, which would turn a missing value into a fake "0.00" on screen.
  function asNumber(value) {
    if (value === null || value === undefined || value === "") return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function num(value, decimals) {
    const n = asNumber(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function kg(value, decimals) {
    const n = asNumber(value);
    if (!Number.isFinite(n)) return "—";
    return num(n, decimals === undefined ? 1 : decimals) + " kg CO₂e";
  }

  function prettyDate(isoDate, timeZone) {
    if (!isoDate) return "—";
    // A bare YYYY-MM-DD is already the calendar day we want; going
    // through Date would shift it by the viewer's offset.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
    try {
      if (m) {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(
          undefined,
          { day: "numeric", month: "short", year: "numeric" }
        );
      }
      return new Date(isoDate).toLocaleDateString(undefined, {
        timeZone: timeZone || undefined,
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch (e) {
      return String(isoDate);
    }
  }

  function prettyDateTime(iso, timeZone) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString(undefined, {
        timeZone: timeZone || undefined,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return String(iso);
    }
  }

  const CATEGORY_LABEL = {
    transport: "Transport",
    electricity: "Electricity",
    waste: "Waste",
    other: "Other",
    balanced: "All areas",
  };

  function categoryLabel(key) {
    return CATEGORY_LABEL[String(key || "").toLowerCase()] || "All areas";
  }

  // ---------------------- Exports ----------------------

  window.EcoData = {
    // session
    currentUser,
    isSignedIn,
    deviceTimezone,
    dateInZone,
    // data
    saveAssessment,
    getTodayChallenge,
    getDashboard,
    completeChallenge,
    getHistory,
    getCommunityStats,
    getChallengeTemplates,
    // formatting
    num,
    kg,
    attr,
    challengeSaving,
    prettyDate,
    prettyDateTime,
    categoryLabel,
  };

})();