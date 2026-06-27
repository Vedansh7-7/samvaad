/*
  Samvaad — SDK-free auth/session helper, shared by login.html and app.html.

  No provider secrets live here. The Supabase anon key is public by design; Row-Level
  Security protects data. The signed-in session is kept in sessionStorage (per-tab,
  cleared when the tab closes) to match Samvaad's consent-first / data-minimisation
  posture — tokens don't linger on the device after the user leaves.

  Everything talks to Supabase GoTrue over REST; there is no @supabase/supabase-js here.
*/
(function (global) {
  var SB_URL = "https://bwcszkbtvbvwzioycxxp.supabase.co";
  // Public anon key (safe in the browser; RLS enforces per-user access).
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3Y3N6a2J0dmJ2d3ppb3ljeHhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0OTQ0NzIsImV4cCI6MjA5ODA3MDQ3Mn0.ev1PR3PmgX4GVVQj2EiR6hJGOKE0cLYF-qOZDDi0qjQ";

  var SESSION_KEY = "samvaad.session";
  var GUEST_KEY = "samvaad.guest";

  function nowSec() { return Math.floor(Date.now() / 1000); }
  function ss() { try { return global.sessionStorage; } catch (e) { return null; } }

  function saveSession(s) {
    var store = ss(); if (!store || !s) return;
    try { store.setItem(SESSION_KEY, JSON.stringify(s)); store.removeItem(GUEST_KEY); } catch (e) {}
  }
  function readSession() {
    var store = ss(); if (!store) return null;
    try { return JSON.parse(store.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }
  function clearSession() {
    var store = ss(); if (!store) return;
    try { store.removeItem(SESSION_KEY); store.removeItem(GUEST_KEY); } catch (e) {}
  }
  function setGuest() {
    var store = ss(); if (!store) return;
    try { store.setItem(GUEST_KEY, "1"); store.removeItem(SESSION_KEY); } catch (e) {}
  }
  function isGuest() {
    var store = ss(); if (!store) return false;
    try { return store.getItem(GUEST_KEY) === "1"; } catch (e) { return false; }
  }

  // Normalise any GoTrue token payload (verify, refresh, or hash) into our session shape.
  function fromTokenResponse(d) {
    if (!d || !d.access_token) return null;
    var expires_at = d.expires_at
      ? Number(d.expires_at)
      : (d.expires_in ? nowSec() + Number(d.expires_in) : nowSec() + 3600);
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token || null,
      expires_at: expires_at,
      user: d.user ? { id: d.user.id, email: d.user.email } : null
    };
  }

  // Parse a Supabase magic-link / implicit-grant hash:
  //   #access_token=...&refresh_token=...&expires_in=3600&token_type=bearer
  function sessionFromHash(hash) {
    if (!hash) return null;
    var h = String(hash).replace(/^#/, "");
    if (h.indexOf("access_token=") === -1) return null;
    var p = {};
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > -1) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return fromTokenResponse({
      access_token: p.access_token,
      refresh_token: p.refresh_token,
      expires_in: p.expires_in ? parseInt(p.expires_in, 10) : 0
    });
  }

  function hashHasToken() {
    try { return (global.location.hash || "").indexOf("access_token=") > -1; } catch (e) { return false; }
  }

  // Exchange a refresh_token for a fresh session (GoTrue REST).
  async function refresh(s) {
    if (!s || !s.refresh_token) return null;
    try {
      var r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      if (!r.ok) return null;
      var ns = fromTokenResponse(await r.json());
      if (ns) { if (!ns.user && s.user) ns.user = s.user; saveSession(ns); }
      return ns;
    } catch (e) { return null; }
  }

  // Resolve the user behind a token (used when we only have tokens from a hash).
  async function fetchUser(token) {
    try {
      var r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } });
      if (!r.ok) return null;
      var u = await r.json();
      return u && u.id ? { id: u.id, email: u.email } : null;
    } catch (e) { return null; }
  }

  // Return a valid session (refreshing if within 60s of expiry), or null.
  async function ensureValid() {
    var s = readSession();
    if (!s) return null;
    if (s.expires_at && (s.expires_at - nowSec()) < 60) {
      var ns = await refresh(s);
      if (!ns) { clearSession(); return null; }
      s = ns;
    }
    if (!s.user && s.access_token) {
      var u = await fetchUser(s.access_token);
      if (u) { s.user = u; saveSession(s); }
    }
    return s;
  }

  function token() { var s = readSession(); return (s && s.access_token) || null; }
  function authHeaders() { var t = token(); return t ? { Authorization: "Bearer " + t } : {}; }

  async function signOut() {
    var s = readSession();
    if (s && s.access_token) {
      try {
        await fetch(SB_URL + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: SB_KEY, Authorization: "Bearer " + s.access_token }
        });
      } catch (e) {}
    }
    clearSession();
  }

  global.SamvaadAuth = {
    SB_URL: SB_URL, SB_KEY: SB_KEY,
    saveSession: saveSession, readSession: readSession, clearSession: clearSession,
    setGuest: setGuest, isGuest: isGuest,
    fromTokenResponse: fromTokenResponse, sessionFromHash: sessionFromHash, hashHasToken: hashHasToken,
    refresh: refresh, ensureValid: ensureValid, fetchUser: fetchUser,
    token: token, authHeaders: authHeaders, signOut: signOut
  };
})(window);
