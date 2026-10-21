// User profiles: display name, @username, bio, favorite genres, and avatar photo.
// Data lives in public.profiles (one row per user, RLS: own row only); photos in the "avatars" bucket.
// Exposes window.SunoProfile = { onSignedIn(user) -> Promise, onSignedOut(), current }.
window.SunoProfile = (() => {
  "use strict";

  const client = window.SunoAuth.client;
  const BUCKET = "avatars";
  const AVATAR_SIZE = 256;
  const MAX_GENRES = 8;
  const GENRES = [
    "pop", "rock", "hip hop", "R&B", "EDM", "lo-fi", "jazz", "classical", "country",
    "indie", "metal", "reggaeton", "latin", "k-pop", "afrobeats", "folk", "funk", "synthwave", "cinematic", "gospel",
  ];
  const COLUMNS = "id, email, display_name, username, bio, avatar_path, favorite_genres";

  const $ = (sel) => document.querySelector(sel);
  const el = {
    button: $("#profileButton"),
    buttonAvatar: $("#profileButtonAvatar"),
    buttonName: $("#profileButtonName"),
    dialog: $("#profileDialog"),
    form: $("#profileForm"),
    heading: $("#profileHeading"),
    intro: $("#profileIntro"),
    avatar: $("#profileAvatar"),
    file: $("#profileFile"),
    changePhoto: $("#profilePhotoButton"),
    removePhoto: $("#profilePhotoRemove"),
    displayName: $("#profileDisplayName"),
    username: $("#profileUsername"),
    usernameHint: $("#profileUsernameHint"),
    bio: $("#profileBio"),
    bioCount: $("#profileBioCount"),
    genres: $("#profileGenres"),
    genresCount: $("#profileGenresCount"),
    email: $("#profileEmail"),
    error: $("#profileError"),
    save: $("#profileSave"),
    skip: $("#profileSkip"),
  };

  let user = null;
  let profile = null; // row from public.profiles, or null if it doesn't exist yet
  let pendingAvatar = null; // { blob, url } chosen in the dialog but not saved yet
  let removeAvatar = false;
  let selectedGenres = new Set();
  let resolveOnboarding = null;

  // ---------- Helpers ----------
  const avatarUrl = (path) => (path ? client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : "");

  function initials(name) {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "♪";
  }

  function paintAvatar(node, url, name) {
    node.replaceChildren();
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      node.append(img);
    } else {
      node.textContent = initials(name);
    }
  }

  function friendlyError(error) {
    if (!error) return "Something went wrong.";
    if (error.code === "23505") return "That username is taken. Try another one.";
    if (error.code === "23514") {
      if (/username/.test(error.message)) return "Usernames are 3–20 lowercase letters, numbers or underscores.";
      if (/display_name/.test(error.message)) return "Display name must be 1–50 characters.";
      if (/bio/.test(error.message)) return "Bio must be 280 characters or fewer.";
      if (/genres/.test(error.message)) return `Pick up to ${MAX_GENRES} genres.`;
    }
    if (/payload too large|exceeded the maximum/i.test(error.message)) return "That image is too large.";
    if (/failed to fetch|network/i.test(error.message)) return "Network error. Check your connection.";
    return error.message || String(error);
  }

  function showError(msg) {
    el.error.textContent = msg || "";
    el.error.hidden = !msg;
  }

  const isComplete = (p) => !!p?.display_name;

  // ---------- Header button ----------
  function renderButton() {
    const name = profile?.display_name || user?.email || "";
    el.buttonName.textContent = profile?.display_name || "Create profile";
    paintAvatar(el.buttonAvatar, avatarUrl(profile?.avatar_path), name);
    el.button.hidden = !user;
    el.button.title = profile?.username ? `@${profile.username}` : user?.email || "";
  }

  // ---------- Genres ----------
  function renderGenres() {
    el.genres.replaceChildren(
      ...GENRES.map((g) => {
        const on = selectedGenres.has(g);
        const b = document.createElement("button");
        b.type = "button";
        b.className = `chip${on ? " selected" : ""}`;
        b.textContent = g;
        b.setAttribute("aria-pressed", on);
        b.addEventListener("click", () => {
          if (on) selectedGenres.delete(g);
          else if (selectedGenres.size < MAX_GENRES) selectedGenres.add(g);
          else return showError(`Pick up to ${MAX_GENRES} genres.`);
          showError("");
          renderGenres();
        });
        return b;
      })
    );
    el.genresCount.textContent = `${selectedGenres.size} / ${MAX_GENRES}`;
  }

  // ---------- Dialog ----------
  function openDialog({ onboarding = false } = {}) {
    if (!user) return;
    pendingAvatar = null;
    removeAvatar = false;
    showError("");
    el.heading.textContent = onboarding ? "Create your profile" : "Your profile";
    el.intro.hidden = !onboarding;
    el.skip.textContent = onboarding ? "Skip for now" : "Cancel";
    el.save.textContent = onboarding ? "Create profile" : "Save";
    el.email.textContent = user.email || "";
    el.displayName.value = profile?.display_name || "";
    el.username.value = profile?.username || "";
    el.bio.value = profile?.bio || "";
    el.bioCount.textContent = el.bio.value.length;
    selectedGenres = new Set((profile?.favorite_genres || []).filter((g) => GENRES.includes(g)));
    renderGenres();
    checkUsername();
    refreshDialogAvatar();
    if (!el.dialog.open) el.dialog.showModal();
    el.displayName.focus();
  }

  function refreshDialogAvatar() {
    const url = pendingAvatar?.url || (removeAvatar ? "" : avatarUrl(profile?.avatar_path));
    paintAvatar(el.avatar, url, el.displayName.value || user?.email);
    el.removePhoto.hidden = !url;
    el.changePhoto.textContent = url ? "Change photo" : "Upload photo";
  }

  function checkUsername() {
    const v = el.username.value;
    if (!v) {
      el.usernameHint.textContent = "Optional. 3–20 lowercase letters, numbers or _";
      el.usernameHint.className = "field-hint";
      return true;
    }
    const ok = /^[a-z0-9_]{3,20}$/.test(v);
    el.usernameHint.textContent = ok ? `Your handle: @${v}` : "Use 3–20 lowercase letters, numbers or _";
    el.usernameHint.className = `field-hint ${ok ? "ok" : "bad"}`;
    return ok;
  }

  el.username.addEventListener("input", () => {
    // Normalise as the user types: lowercase, spaces to underscores, drop anything else.
    const pos = el.username.selectionStart;
    const before = el.username.value;
    const cleaned = before.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (cleaned !== before) {
      el.username.value = cleaned;
      el.username.setSelectionRange(Math.min(pos, cleaned.length), Math.min(pos, cleaned.length));
    }
    checkUsername();
  });
  el.bio.addEventListener("input", () => (el.bioCount.textContent = el.bio.value.length));
  el.displayName.addEventListener("input", () => {
    if (!pendingAvatar && (removeAvatar || !profile?.avatar_path)) refreshDialogAvatar();
  });

  el.changePhoto.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", async () => {
    const file = el.file.files[0];
    el.file.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return showError("Please choose an image file.");
    if (file.size > 20 * 1024 * 1024) return showError("That image is over 20 MB. Please pick a smaller one.");
    try {
      const blob = await squareResize(file, AVATAR_SIZE);
      if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
      pendingAvatar = { blob, url: URL.createObjectURL(blob) };
      removeAvatar = false;
      showError("");
      refreshDialogAvatar();
    } catch {
      showError("Couldn't read that image. Try a JPG or PNG.");
    }
  });
  el.removePhoto.addEventListener("click", () => {
    if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
    pendingAvatar = null;
    removeAvatar = true;
    refreshDialogAvatar();
  });

  // Center-crop to a square and shrink, so uploads are small and consistent.
  function squareResize(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const src = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(src);
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return reject(new Error("empty image"));
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        canvas.toBlob(
          (webp) => {
            // Some browsers can't encode WebP and silently return PNG; fall back to JPEG in that case.
            if (webp && webp.type === "image/webp") return resolve(webp);
            canvas.toBlob((jpg) => (jpg ? resolve(jpg) : reject(new Error("encode failed"))), "image/jpeg", 0.9);
          },
          "image/webp",
          0.9
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error("decode failed"));
      };
      img.src = src;
    });
  }

  async function uploadAvatar(blob) {
    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    // Unique name per upload so browsers and the CDN never show a stale photo.
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    return path;
  }

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayName = el.displayName.value.trim();
    if (!displayName) {
      showError("Add a display name.");
      return el.displayName.focus();
    }
    if (!checkUsername()) return el.username.focus();

    el.save.disabled = true;
    const label = el.save.textContent;
    el.save.textContent = "Saving…";
    showError("");
    let uploadedPath = null;
    try {
      const oldPath = profile?.avatar_path || null;
      let avatarPath = oldPath;
      if (pendingAvatar) avatarPath = uploadedPath = await uploadAvatar(pendingAvatar.blob);
      else if (removeAvatar) avatarPath = null;

      const fields = {
        display_name: displayName,
        username: el.username.value || null,
        bio: el.bio.value.trim() || null,
        avatar_path: avatarPath,
        favorite_genres: [...selectedGenres],
      };
      const query = profile
        ? client.from("profiles").update(fields).eq("id", user.id)
        : client.from("profiles").insert({ id: user.id, ...fields });
      const { data, error } = await query.select(COLUMNS).single();
      if (error) throw error;

      profile = data;
      uploadedPath = null;
      if (oldPath && oldPath !== avatarPath) {
        client.storage.from(BUCKET).remove([oldPath]).catch(() => {}); // best-effort cleanup
      }
      if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
      pendingAvatar = null;
      renderButton();
      announce();
      el.dialog.close();
      window.dispatchEvent(new CustomEvent("sunoapp:toast", { detail: "Profile saved." }));
    } catch (err) {
      if (uploadedPath) client.storage.from(BUCKET).remove([uploadedPath]).catch(() => {});
      showError(friendlyError(err));
    } finally {
      el.save.disabled = false;
      el.save.textContent = label;
    }
  });

  el.skip.addEventListener("click", () => el.dialog.close());
  el.dialog.addEventListener("close", () => {
    if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
    pendingAvatar = null;
    if (resolveOnboarding) {
      const done = resolveOnboarding;
      resolveOnboarding = null;
      done();
    }
  });
  el.button.addEventListener("click", () => openDialog({ onboarding: !isComplete(profile) }));

  function announce() {
    window.dispatchEvent(new CustomEvent("sunoprofile:change", { detail: profile }));
  }

  // ---------- Lifecycle ----------
  async function load() {
    const { data, error } = await client.from("profiles").select(COLUMNS).eq("id", user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  /** Loads the profile; on first sign-in, asks the user to create one. Resolves when that step is done. */
  async function onSignedIn(u) {
    user = u;
    profile = null;
    renderButton();
    try {
      profile = await load();
    } catch {
      profile = null; // the dialog will insert the row on save
    }
    if (user !== u) return; // signed out (or switched) while loading
    renderButton();
    announce();
    if (isComplete(profile) || document.body.classList.contains("signed-out")) return;
    await new Promise((resolve) => {
      resolveOnboarding = resolve;
      openDialog({ onboarding: true });
    });
  }

  function onSignedOut() {
    user = null;
    profile = null;
    if (el.dialog.open) el.dialog.close();
    renderButton();
    announce();
  }

  return {
    onSignedIn,
    onSignedOut,
    open: () => openDialog({ onboarding: !isComplete(profile) }),
    get current() {
      return profile;
    },
  };
})();
