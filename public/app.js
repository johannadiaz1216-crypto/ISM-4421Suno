(() => {
  "use strict";

  // ---------- Config ----------
  const API_BASE = "/api/suno/v1"; // Netlify Function proxy -> https://api.sunoapi.org/api/v1
  const POLL_MS = 5000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const LIBRARY_KEY = "suno-studio.library.v1";
  const JOBS_KEY = "suno-studio.jobs.v1";

  const ERROR_CODES = {
    400: "Invalid parameters. Check your inputs.",
    401: "Your API key was rejected. Check that it is correct.",
    404: "Endpoint not found.",
    405: "Rate limit exceeded. Wait a moment and try again.",
    413: "Prompt or lyrics are too long.",
    429: "Not enough credits. Top up your Suno API account.",
    430: "Too many requests. Please try again shortly.",
    455: "Suno API is under maintenance. Try again later.",
    500: "Suno API server error. Try again later.",
    502: "Could not reach the Suno API.",
  };

  const TASK_FAILURES = {
    CREATE_TASK_FAILED: "Failed to create the task.",
    GENERATE_AUDIO_FAILED: "Failed to generate audio.",
    GENERATE_LYRICS_FAILED: "Failed to generate lyrics.",
    CALLBACK_EXCEPTION: "The task hit an error.",
    SENSITIVE_WORD_ERROR: "Your prompt contains words Suno does not allow. Please rephrase.",
  };

  const IDEAS = [
    "Lo-fi hip hop beat for studying on a rainy night",
    "Epic orchestral trailer music with choir",
    "Upbeat 80s synth-pop song about summer love",
    "Acoustic folk ballad about leaving home",
    "High-energy EDM festival anthem with a big drop",
    "Smooth jazz with saxophone, late night lounge",
  ];
  const STYLES = ["pop", "rock", "hip hop", "lo-fi", "EDM", "jazz", "R&B", "country", "cinematic", "acoustic", "synthwave", "reggaeton"];
  const VARIETY_LABELS = ["Off", "Normal", "High", "Extra", "Max"];

  // ---------- State ----------
  // The API key lives only in this variable: never written to storage, never sent anywhere but the proxy.
  let apiKey = "";
  let mode = "simple";
  let library = load(LIBRARY_KEY, []);
  let jobs = load(JOBS_KEY, []);
  const activePolls = new Set();
  let extendTarget = null;

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const el = {
    credits: $("#credits"),
    keyButton: $("#keyButton"),
    keyDialog: $("#keyDialog"),
    keyForm: $("#keyForm"),
    keyInput: $("#keyInput"),
    keyError: $("#keyError"),
    forgetKey: $("#forgetKey"),
    tabs: document.querySelectorAll(".tab"),
    simple: $(".mode-simple"),
    custom: $(".mode-custom"),
    form: $("#generateForm"),
    description: $("#description"),
    title: $("#title"),
    style: $("#style"),
    lyrics: $("#lyrics"),
    lyricsCount: $("#lyricsCount"),
    negativeTags: $("#negativeTags"),
    vocalGender: $("#vocalGender"),
    duration: $("#duration"),
    styleWeight: $("#styleWeight"),
    weirdness: $("#weirdness"),
    variety: $("#variety"),
    useSliders: $("#useSliders"),
    instrumental: $("#instrumental"),
    model: $("#model"),
    generateButton: $("#generateButton"),
    jobs: $("#jobs"),
    tracks: $("#tracks"),
    empty: $("#emptyState"),
    clearLibrary: $("#clearLibrary"),
    player: $("#player"),
    audio: $("#audio"),
    playerCover: $("#playerCover"),
    playerTitle: $("#playerTitle"),
    playerTags: $("#playerTags"),
    lyricsDialog: $("#lyricsDialog"),
    lyricsAiButton: $("#lyricsAiButton"),
    lyricsPrompt: $("#lyricsPrompt"),
    lyricsGo: $("#lyricsGo"),
    lyricsStatus: $("#lyricsStatus"),
    lyricsOptions: $("#lyricsOptions"),
    extendDialog: $("#extendDialog"),
    extendForm: $("#extendForm"),
    extendName: $("#extendName"),
    continueAt: $("#continueAt"),
    extendStyle: $("#extendStyle"),
    extendLyrics: $("#extendLyrics"),
    toast: $("#toast"),
  };

  // ---------- Helpers ----------
  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    el.toast.textContent = msg;
    el.toast.classList.toggle("error", isError);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), isError ? 6000 : 3000);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtDuration(sec) {
    if (!sec && sec !== 0) return "";
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function callBackUrl() {
    // Suno requires a callback URL; the app polls for status, so this endpoint just acknowledges.
    return location.protocol.startsWith("http")
      ? `${location.origin}/api/callback`
      : "https://example.com/callback";
  }

  function safeFilename(name) {
    return (name || "suno-track").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "suno-track";
  }

  // ---------- API ----------
  async function api(path, { method = "GET", body } = {}) {
    if (!apiKey) {
      openKeyDialog();
      throw new Error("Add your API key first.");
    }
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Network error. Check your connection.");
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(ERROR_CODES[res.status] || `Unexpected response (HTTP ${res.status}).`);
    }
    const code = data?.code ?? res.status;
    if (code !== 200) {
      const err = new Error(data?.msg && code !== 401 ? `${data.msg}` : ERROR_CODES[code] || `Request failed (${code}).`);
      err.code = code;
      throw err;
    }
    return data.data;
  }

  async function refreshCredits() {
    try {
      const credits = await api("/generate/credit");
      const n = typeof credits === "object" && credits !== null ? credits.credits : credits;
      el.credits.textContent = `${n ?? "?"} credits`;
      el.credits.hidden = false;
    } catch (e) {
      if (e.code === 401) setKey("");
    }
  }

  // ---------- API key ----------
  function setKey(key) {
    apiKey = key.trim();
    el.keyButton.textContent = apiKey ? "API key ✓" : "Set API key";
    if (!apiKey) el.credits.hidden = true;
  }

  function openKeyDialog() {
    el.keyError.hidden = true;
    el.keyInput.value = "";
    if (!el.keyDialog.open) el.keyDialog.showModal();
    el.keyInput.focus();
  }

  el.keyButton.addEventListener("click", openKeyDialog);

  el.keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = el.keyInput.value.trim();
    if (!key) {
      el.keyError.textContent = "Please paste your API key.";
      el.keyError.hidden = false;
      return;
    }
    const saveBtn = $("#saveKey");
    saveBtn.disabled = true;
    saveBtn.textContent = "Checking…";
    const previous = apiKey;
    setKey(key);
    try {
      const credits = await api("/generate/credit");
      const n = typeof credits === "object" && credits !== null ? credits.credits : credits;
      el.credits.textContent = `${n ?? "?"} credits`;
      el.credits.hidden = false;
      el.keyInput.value = "";
      el.keyDialog.close();
      toast("API key accepted.");
      resumeJobs();
    } catch (err) {
      setKey(previous);
      el.keyError.textContent = err.message;
      el.keyError.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Use key";
    }
  });

  el.forgetKey.addEventListener("click", () => {
    setKey("");
    el.keyInput.value = "";
    el.keyDialog.close();
    toast("API key cleared from memory.");
  });

  // ---------- Mode tabs & inputs ----------
  el.tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      mode = tab.dataset.mode;
      el.tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab);
      });
      el.simple.hidden = mode !== "simple";
      el.custom.hidden = mode !== "custom";
    })
  );

  IDEAS.forEach((idea) =>
    $("#ideaChips").append(h("button", { type: "button", class: "chip", onclick: () => (el.description.value = idea) }, idea))
  );
  STYLES.forEach((s) =>
    $("#styleChips").append(
      h("button", {
        type: "button",
        class: "chip",
        onclick: () => {
          const cur = el.style.value.split(",").map((x) => x.trim()).filter(Boolean);
          if (!cur.includes(s)) cur.push(s);
          el.style.value = cur.join(", ");
        },
      }, s)
    )
  );

  el.lyrics.addEventListener("input", () => (el.lyricsCount.textContent = el.lyrics.value.length));
  el.instrumental.addEventListener("change", () => {
    const off = el.instrumental.checked;
    el.lyrics.disabled = off;
    el.lyricsAiButton.disabled = off;
    el.vocalGender.disabled = off;
  });
  const bindRange = (input, out, fmt) => {
    const update = () => (out.textContent = fmt(input.value));
    input.addEventListener("input", update);
    update();
  };
  bindRange(el.styleWeight, $("#styleWeightOut"), (v) => Number(v).toFixed(2));
  bindRange(el.weirdness, $("#weirdnessOut"), (v) => Number(v).toFixed(2));
  bindRange(el.variety, $("#varietyOut"), (v) => VARIETY_LABELS[v]);

  // ---------- Generate ----------
  function buildRequest() {
    const instrumental = el.instrumental.checked;
    const model = el.model.value;
    const body = { customMode: mode === "custom", instrumental, model, callBackUrl: callBackUrl() };

    if (mode === "simple") {
      const prompt = el.description.value.trim();
      if (!prompt) throw new Error("Describe the song you want.");
      body.prompt = prompt;
      return { body, label: prompt };
    }

    const title = el.title.value.trim();
    const style = el.style.value.trim();
    const lyrics = instrumental ? "" : el.lyrics.value.trim();
    const negativeTags = el.negativeTags.value.trim();
    if (!style && !lyrics && !negativeTags) {
      throw new Error(instrumental ? "Add a style for your instrumental." : "Add a style or some lyrics.");
    }
    if (title) body.title = title;
    if (style) body.style = style;
    if (lyrics) body.lyrics = lyrics;
    if (negativeTags) body.negativeTags = negativeTags;
    if (!instrumental && el.vocalGender.value) body.vocalGender = el.vocalGender.value;
    const duration = Number(el.duration.value);
    if (el.duration.value) {
      if (!(duration >= 10 && duration <= 360)) throw new Error("Duration must be between 10 and 360 seconds.");
      body.duration = Math.round(duration);
    }
    if (el.useSliders.checked) {
      body.styleWeight = Number(el.styleWeight.value);
      body.weirdnessConstraint = Number(el.weirdness.value);
      body.variety = Number(el.variety.value);
    }
    return { body, label: title || style || "Custom song" };
  }

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!apiKey) return openKeyDialog();
    let req;
    try {
      req = buildRequest();
    } catch (err) {
      return toast(err.message, true);
    }
    el.generateButton.disabled = true;
    el.generateButton.textContent = "Submitting…";
    try {
      const data = await api("/generate", { method: "POST", body: req.body });
      startJob({ taskId: data.taskId, label: req.label, model: req.body.model, kind: "generate" });
      toast("Song is being created…");
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.generateButton.disabled = false;
      el.generateButton.textContent = "Create";
    }
  });

  // ---------- Jobs / polling ----------
  function startJob(job) {
    job.startedAt = Date.now();
    jobs = jobs.filter((j) => j.taskId !== job.taskId).concat(job);
    save(JOBS_KEY, jobs);
    renderJobs();
    pollJob(job);
  }

  function finishJob(taskId) {
    jobs = jobs.filter((j) => j.taskId !== taskId);
    save(JOBS_KEY, jobs);
    activePolls.delete(taskId);
    renderJobs();
  }

  function resumeJobs() {
    jobs.forEach((job) => pollJob(job));
  }

  function setJobStatus(taskId, text, failed = false) {
    const job = jobs.find((j) => j.taskId === taskId);
    if (!job) return;
    job.statusText = text;
    job.failed = failed;
    renderJobs();
  }

  async function pollJob(job) {
    if (activePolls.has(job.taskId) || !apiKey) return;
    activePolls.add(job.taskId);
    setJobStatus(job.taskId, "Queued…");

    while (Date.now() - job.startedAt < POLL_TIMEOUT_MS) {
      let info;
      try {
        info = await api(`/generate/record-info?taskId=${encodeURIComponent(job.taskId)}`);
      } catch (err) {
        if (err.code === 401) {
          activePolls.delete(job.taskId);
          setJobStatus(job.taskId, "Waiting for a valid API key…");
          return;
        }
        setJobStatus(job.taskId, `Retrying… (${err.message})`);
        await sleep(POLL_MS * 2);
        continue;
      }

      const status = info?.status || "PENDING";
      const items = info?.response?.sunoData || info?.response?.data || [];
      if (items.length) upsertTracks(items, job, status === "SUCCESS");

      if (status === "SUCCESS") {
        finishJob(job.taskId);
        toast(`“${job.label.slice(0, 40)}” is ready!`);
        refreshCredits();
        return;
      }
      if (TASK_FAILURES[status]) {
        activePolls.delete(job.taskId);
        setJobStatus(job.taskId, info?.errorMessage || TASK_FAILURES[status], true);
        refreshCredits();
        return;
      }
      setJobStatus(job.taskId, {
        PENDING: "Composing…",
        TEXT_SUCCESS: "Lyrics done, producing audio…",
        FIRST_SUCCESS: "First track ready to stream, finishing the second…",
      }[status] || "Working…");
      await sleep(POLL_MS);
    }
    activePolls.delete(job.taskId);
    setJobStatus(job.taskId, "Timed out waiting for Suno. Try again later.", true);
  }

  function renderJobs() {
    el.jobs.replaceChildren(
      ...jobs.map((job) =>
        h("div", { class: `job${job.failed ? " failed" : ""}` },
          job.failed ? h("span", {}, "⚠️") : h("div", { class: "spinner", "aria-hidden": "true" }),
          h("div", { class: "job-text" },
            h("div", { class: "job-title" }, job.kind === "extend" ? `Extending: ${job.label}` : job.label),
            h("div", { class: "job-status" }, job.statusText || (apiKey ? "Starting…" : "Add your API key to resume"))
          ),
          job.failed && h("button", { class: "btn small ghost", type: "button", onclick: () => finishJob(job.taskId) }, "Dismiss")
        )
      )
    );
    renderEmpty();
  }

  // ---------- Library ----------
  function upsertTracks(items, job, final) {
    for (const it of items) {
      if (!it?.id) continue;
      const audio = it.audio_url || "";
      const stream = it.stream_audio_url || it.source_stream_audio_url || "";
      if (!audio && !stream) continue;
      const existing = library.find((t) => t.id === it.id);
      const track = {
        id: it.id,
        taskId: job.taskId,
        model: job.model,
        title: it.title || job.label,
        tags: it.tags || "",
        image: it.image_url || it.source_image_url || "",
        audio,
        stream,
        duration: it.duration || 0,
        lyrics: it.prompt || "",
        createdAt: existing?.createdAt || Date.now(),
        ready: final || !!audio,
      };
      if (existing) Object.assign(existing, track);
      else library.unshift(track);
    }
    save(LIBRARY_KEY, library);
    renderTracks();
  }

  function renderEmpty() {
    el.empty.hidden = library.length > 0 || jobs.length > 0;
    el.clearLibrary.hidden = library.length === 0;
  }

  function renderTracks() {
    el.tracks.replaceChildren(...library.map(trackCard));
    renderEmpty();
  }

  function trackCard(t) {
    const src = t.audio || t.stream;
    const isPlaying = el.audio.dataset.id === t.id && !el.audio.paused;
    return h("article", { class: `track${el.audio.dataset.id === t.id ? " playing" : ""}` },
      h("div", { class: "cover" },
        t.image ? h("img", { src: t.image, alt: "", loading: "lazy" }) : null,
        !t.ready && h("span", { class: "badge" }, "Streaming preview"),
        h("button", { class: "play", type: "button", "aria-label": `Play ${t.title}`, onclick: () => play(t) }, isPlaying ? "❚❚" : "▶")
      ),
      h("div", { class: "track-body" },
        h("div", { class: "track-title" }, t.title),
        t.tags && h("div", { class: "track-tags" }, t.tags),
        h("div", { class: "track-meta" },
          [fmtDuration(t.duration), t.model?.replace("_", " "), new Date(t.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")
        ),
        t.lyrics && h("details", {}, h("summary", {}, "Lyrics"), h("pre", {}, t.lyrics)),
        h("div", { class: "track-actions" },
          t.audio
            ? h("button", { class: "btn small", type: "button", onclick: () => download(t) }, "⬇ MP3")
            : h("span", { class: "track-meta" }, "Download available when finished"),
          t.ready && h("button", { class: "btn small", type: "button", onclick: () => openExtend(t) }, "Extend"),
          src && h("button", { class: "btn small ghost", type: "button", onclick: () => copyLink(src) }, "Copy link"),
          h("button", { class: "btn small ghost", type: "button", "aria-label": "Remove", onclick: () => removeTrack(t.id) }, "✕")
        )
      )
    );
  }

  function play(t) {
    const src = t.audio || t.stream;
    if (!src) return;
    if (el.audio.dataset.id === t.id) {
      el.audio.paused ? el.audio.play() : el.audio.pause();
      return;
    }
    el.audio.src = src;
    el.audio.dataset.id = t.id;
    el.playerTitle.textContent = t.title;
    el.playerTags.textContent = t.tags;
    if (t.image) el.playerCover.src = t.image;
    else el.playerCover.removeAttribute("src");
    el.player.hidden = false;
    el.audio.play().catch(() => toast("Could not play this track.", true));
  }
  ["play", "pause", "ended"].forEach((ev) => el.audio.addEventListener(ev, renderTracks));

  async function download(t) {
    const name = `${safeFilename(t.title)}.mp3`;
    try {
      const res = await fetch(t.audio);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      // Cross-origin hosts may block blob downloads; fall back to opening the file.
      window.open(t.audio, "_blank", "noopener");
    }
  }

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast("Could not copy the link.", true);
    }
  }

  function removeTrack(id) {
    library = library.filter((t) => t.id !== id);
    save(LIBRARY_KEY, library);
    renderTracks();
  }

  el.clearLibrary.addEventListener("click", () => {
    if (!confirm("Remove all tracks from this list? (Files on Suno are not deleted.)")) return;
    library = [];
    save(LIBRARY_KEY, library);
    renderTracks();
  });

  // ---------- Extend ----------
  function openExtend(t) {
    if (!apiKey) return openKeyDialog();
    extendTarget = t;
    el.extendName.textContent = t.title;
    const max = Math.max(1, Math.floor(t.duration || 60) - 1);
    el.continueAt.max = max;
    el.continueAt.value = Math.max(1, Math.min(max, Math.floor((t.duration || 60) - 10)));
    el.extendStyle.value = t.tags || "";
    el.extendLyrics.value = "";
    el.extendDialog.showModal();
  }

  el.extendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = extendTarget;
    if (!t) return;
    const continueAt = Number(el.continueAt.value);
    if (!(continueAt > 0) || (t.duration && continueAt >= t.duration)) {
      return toast(`Pick a point between 1 and ${Math.floor(t.duration) - 1} seconds.`, true);
    }
    const body = {
      audioId: t.id,
      taskId: t.taskId,
      model: t.model || "V6",
      continueAt,
      title: `${t.title} (Extended)`.slice(0, 100),
      callBackUrl: callBackUrl(),
    };
    const style = el.extendStyle.value.trim();
    const lyrics = el.extendLyrics.value.trim();
    if (style) body.style = style;
    if (lyrics) body.lyrics = lyrics;
    try {
      const data = await api("/generate/extend", { method: "POST", body });
      el.extendDialog.close();
      startJob({ taskId: data.taskId, label: t.title, model: body.model, kind: "extend" });
      toast("Extending your track…");
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- AI lyrics ----------
  el.lyricsAiButton.addEventListener("click", () => {
    if (!apiKey) return openKeyDialog();
    el.lyricsStatus.hidden = true;
    el.lyricsOptions.replaceChildren();
    if (!el.lyricsPrompt.value) el.lyricsPrompt.value = el.title.value || "";
    el.lyricsDialog.showModal();
    el.lyricsPrompt.focus();
  });

  el.lyricsPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.lyricsGo.click();
    }
  });

  el.lyricsGo.addEventListener("click", async () => {
    const prompt = el.lyricsPrompt.value.trim();
    if (!prompt) return toast("Tell the AI what the song is about.", true);
    el.lyricsGo.disabled = true;
    el.lyricsOptions.replaceChildren();
    const status = (text, spinning = true) => {
      el.lyricsStatus.replaceChildren(spinning ? h("div", { class: "spinner" }) : "", text);
      el.lyricsStatus.hidden = false;
    };
    status("Writing lyrics…");
    try {
      const { taskId } = await api("/lyrics", { method: "POST", body: { prompt, callBackUrl: callBackUrl() } });
      const started = Date.now();
      while (Date.now() - started < 3 * 60 * 1000) {
        await sleep(3000);
        const info = await api(`/lyrics/record-info?taskId=${encodeURIComponent(taskId)}`);
        if (TASK_FAILURES[info?.status]) throw new Error(info.errorMessage || TASK_FAILURES[info.status]);
        if (info?.status === "SUCCESS") {
          const options = (info.response?.data || []).filter((o) => o.text && o.status !== "failed");
          if (!options.length) throw new Error("No lyrics were returned. Try a different prompt.");
          status(`Pick one of ${options.length} options:`, false);
          el.lyricsOptions.replaceChildren(
            ...options.map((o) =>
              h("div", { class: "lyrics-option" },
                h("strong", {}, o.title || "Untitled"),
                h("pre", {}, o.text),
                h("button", {
                  class: "btn small primary",
                  type: "button",
                  onclick: () => {
                    el.lyrics.value = o.text.slice(0, 5000);
                    el.lyricsCount.textContent = el.lyrics.value.length;
                    if (!el.title.value && o.title) el.title.value = o.title.slice(0, 80);
                    el.lyricsDialog.close();
                    toast("Lyrics added.");
                  },
                }, "Use these lyrics")
              )
            )
          );
          refreshCredits();
          return;
        }
      }
      throw new Error("Timed out waiting for lyrics.");
    } catch (err) {
      status(err.message, false);
    } finally {
      el.lyricsGo.disabled = false;
    }
  });

  // ---------- Dialog close buttons ----------
  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close())
  );

  // ---------- Init ----------
  renderTracks();
  renderJobs();
  openKeyDialog();
})();
