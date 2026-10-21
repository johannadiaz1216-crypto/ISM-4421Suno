// Email + password sign-in with Supabase Auth.
// Exposes window.SunoAuth = { onChange(fn), getAccessToken(), signOut() }.
window.SunoAuth = (() => {
  "use strict";

  const { supabaseUrl, supabasePublishableKey } = window.APP_CONFIG;
  const client = window.supabase.createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const $ = (sel) => document.querySelector(sel);
  const el = {
    screen: $("#authScreen"),
    form: $("#authForm"),
    heading: $("#authHeading"),
    sub: $("#authSub"),
    email: $("#authEmail"),
    emailRow: $("#authEmailRow"),
    password: $("#authPassword"),
    passwordRow: $("#authPasswordRow"),
    submit: $("#authSubmit"),
    message: $("#authMessage"),
    toggle: $("#authToggle"),
    forgot: $("#authForgot"),
    back: $("#authBack"),
    userEmail: $("#userEmail"),
    signOut: $("#signOutButton"),
  };

  // view: "signin" | "signup" | "forgot" | "reset"
  let view = "signin";
  let currentUser = null;
  const listeners = [];

  const VIEWS = {
    signin: { heading: "Welcome back", sub: "Sign in to make music.", submit: "Sign in", email: true, password: true },
    signup: { heading: "Create your account", sub: "All you need is an email and a password.", submit: "Create account", email: true, password: true },
    forgot: { heading: "Reset your password", sub: "We'll email you a link to set a new password.", submit: "Send reset link", email: true, password: false },
    reset: { heading: "Choose a new password", sub: "Enter a new password for your account.", submit: "Save password", email: false, password: true },
  };

  function setView(next) {
    view = next;
    const v = VIEWS[view];
    el.heading.textContent = v.heading;
    el.sub.textContent = v.sub;
    el.submit.textContent = v.submit;
    el.emailRow.hidden = !v.email;
    el.passwordRow.hidden = !v.password;
    el.email.required = v.email;
    el.password.required = v.password;
    el.password.autocomplete = view === "signin" ? "current-password" : "new-password";
    el.toggle.hidden = view === "reset" || view === "forgot";
    el.toggle.textContent = view === "signup" ? "Have an account? Sign in" : "New here? Create an account";
    el.forgot.hidden = view !== "signin";
    el.back.hidden = view !== "forgot";
    showMessage("");
  }

  function showMessage(text, kind = "error") {
    el.message.textContent = text;
    el.message.className = `auth-message ${kind}`;
    el.message.hidden = !text;
  }

  function friendly(error) {
    const msg = error?.message || String(error);
    if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
    if (/email not confirmed/i.test(msg)) return "Please confirm your email first. Check your inbox for the link.";
    if (/already registered|already exists/i.test(msg)) return "That email already has an account. Try signing in.";
    if (/rate limit|too many/i.test(msg)) return "Too many attempts. Please wait a few minutes and try again.";
    if (/password should be at least/i.test(msg)) return msg;
    if (/failed to fetch|network/i.test(msg)) return "Can't reach the sign-in service. Check your connection.";
    return msg;
  }

  function showScreen(show) {
    el.screen.hidden = !show;
    document.body.classList.toggle("signed-out", show);
    if (show) setTimeout(() => (view === "reset" ? el.password : el.email).focus(), 0);
  }

  function setUser(user) {
    const changed = (user?.id || null) !== (currentUser?.id || null);
    currentUser = user;
    el.userEmail.textContent = user?.email || "";
    el.userEmail.hidden = !user;
    el.signOut.hidden = !user;
    if (view !== "reset") showScreen(!user);
    if (changed) listeners.forEach((fn) => fn(user));
  }

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el.email.value.trim();
    const password = el.password.value;
    if (VIEWS[view].email && !email) return showMessage("Enter your email.");
    if (VIEWS[view].password && password.length < 6) return showMessage("Password must be at least 6 characters.");

    el.submit.disabled = true;
    const label = el.submit.textContent;
    el.submit.textContent = "Please wait…";
    const redirectTo = `${location.origin}/`;
    try {
      if (view === "signin") {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (view === "signup") {
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (!data.session) {
          // Supabase hides whether the email exists; an empty identities list means it already does.
          if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
            throw new Error("That email already has an account. Try signing in.");
          }
          setView("signin");
          el.email.value = email;
          showMessage(`Almost done! We sent a confirmation link to ${email}. Click it, then sign in.`, "ok");
        }
      } else if (view === "forgot") {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        setView("signin");
        el.email.value = email;
        showMessage(`If ${email} has an account, a reset link is on its way.`, "ok");
      } else if (view === "reset") {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setView("signin");
        showScreen(false);
        window.dispatchEvent(new CustomEvent("sunoauth:toast", { detail: "Password updated." }));
      }
      el.password.value = "";
    } catch (err) {
      showMessage(friendly(err));
    } finally {
      el.submit.disabled = false;
      el.submit.textContent = el.submit.textContent === "Please wait…" ? label : el.submit.textContent;
    }
  });

  el.toggle.addEventListener("click", () => setView(view === "signup" ? "signin" : "signup"));
  el.forgot.addEventListener("click", () => setView("forgot"));
  el.back.addEventListener("click", () => setView("signin"));
  el.signOut.addEventListener("click", () => signOut());

  async function signOut() {
    await client.auth.signOut({ scope: "local" }).catch(() => {});
    setUser(null);
  }

  client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      setView("reset");
      showScreen(true);
    }
    // Defer so we never call back into supabase-js from inside its own callback.
    setTimeout(() => setUser(session?.user || null), 0);
  });

  // Errors from email links (expired/used links) arrive in the URL hash.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("error_description")) {
    const desc = hash.get("error_description").replace(/\+/g, " ");
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => showMessage(/expired|invalid/i.test(desc) ? "That email link is invalid or has expired. Please try again." : desc), 0);
  }

  setView("signin");

  return {
    onChange(fn) {
      listeners.push(fn);
    },
    get user() {
      return currentUser;
    },
    async getAccessToken() {
      const { data } = await client.auth.getSession();
      return data.session?.access_token || "";
    },
    signOut,
  };
})();
