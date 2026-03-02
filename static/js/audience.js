/* --------------------------------------------------------------
   audience.js – Phase sounds with FULL MATCH gating (static/audio)

   FULL MATCH MODE (phase sounds enabled) only when:
     - schedule exists (/schedule/data has matches), AND
     - timer starts at ~timing.total seconds (tolerance window)

   Sounds (full match mode only):
     - start.wav at match start
     - end.wav at end of auto
     - wait 2s, then resume.wav
     - warning.wav at start of endgame
     - end.wav at match end (natural completion only)

   Ad-hoc timing (no schedule OR custom length):
     - NO phase sounds, NO pause/resume behavior
     - Still plays end.wav at timer completion (can disable if you want)

   Paths:
     /static/audio/start.wav
     /static/audio/end.wav
     /static/audio/resume.wav
     /static/audio/warning.wav
-------------------------------------------------------------- */

console.log("%cAUDIENCE.JS LOADED", "color:lime;font-size:20px");

const AUDIO_BASE = "/static/audio/";
const SOUND = {
  start: "start.wav",
  end: "end.wav",
  resume: "resume.wav",
  warning: "warning.wav",
};

const FULL_MATCH_TOLERANCE_SECONDS = 3; // allow small drift / rounding

// Default timing (will be replaced by /schedule/data if present)
let timing = { auto: 15, teleop: 105, endgame: 30, total: 150 };
let scheduleEnabled = false;

// Timer tracking
let lastRemaining = null;
let lastRunning = false;

// Run state
let fullMatchMode = false;      // <-- gating flag
let runTotalSeconds = null;
let autoEndThreshold = null;
let resumeTimeoutId = null;

// Phase state for current run (only meaningful when fullMatchMode)
let phase = {
  startPlayed: false,
  autoEndPlayed: false,
  endgameWarnPlayed: false,
  matchEndPlayed: false,
};

let lastSeenEndSeq = null;

const urlParams = new URLSearchParams(window.location.search);
const isReversed = urlParams.get("reversed")?.toLowerCase() === "true";

let audioUnlocked = false;

/* ---------- UI helpers ---------- */
function showAlert() {
  const a = document.getElementById("alert");
  if (!a) return;
  a.style.display = "block";
  setTimeout(() => (a.style.display = "none"), 3000);
}

function setMuteIndicatorVisible(visible) {
  const icon = document.getElementById("mute-indicator");
  if (!icon) return;
  if (visible) icon.classList.remove("hidden");
  else icon.classList.add("hidden");
}

/* ---------- Audio helpers (no popups) ---------- */
function getAudioEl() {
  return document.getElementById("buzzer");
}

function toAbsUrl(url) {
  try {
    return new URL(url, window.location.origin).toString();
  } catch (_) {
    return url;
  }
}

async function unlockAudio() {
  const el = document.getElementById("unlocker") || getAudioEl();
  if (!el) return false;

  const prevSrc = el.getAttribute("src") || el.src || "";
  const silent = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

  try {
    el.src = silent;
    el.load?.();
    await el.play();
    try { el.pause(); } catch (_) {}

    if (prevSrc) el.src = prevSrc;

    audioUnlocked = true;
    setMuteIndicatorVisible(false);
    console.log("%cAUDIO UNLOCKED", "color:green;font-weight:bold");
    return true;
  } catch (e) {
    if (prevSrc) el.src = prevSrc;
    console.warn("Audio unlock failed:", e);
    setMuteIndicatorVisible(true);
    return false;
  }
}

async function playWav(filename) {
  const el = getAudioEl();
  if (!el) {
    console.warn("No <audio id='buzzer'> found; cannot play sound:", filename);
    return false;
  }

  const url = AUDIO_BASE + filename;
  const absWanted = toAbsUrl(url);
  const absCurrent = toAbsUrl(el.getAttribute("src") || el.src || "");

  try {
    if (!absCurrent || absCurrent !== absWanted) {
      el.src = url;
      el.load?.();
    }

    try { el.currentTime = 0; } catch (_) {}

    await el.play();

    audioUnlocked = true;
    setMuteIndicatorVisible(false);
    return true;
  } catch (e) {
    console.warn("Audio play blocked/failed:", filename, e);
    setMuteIndicatorVisible(true);
    showAlert();
    return false;
  }
}

/* ---------- Resume scheduling (FULL MATCH only) ---------- */
function clearResumeTimeout() {
  if (resumeTimeoutId) {
    clearTimeout(resumeTimeoutId);
    resumeTimeoutId = null;
  }
}

function scheduleResumeIn2s() {
  clearResumeTimeout();
  resumeTimeoutId = setTimeout(async () => {
    // Only play if still running AND still in full match mode
    if (window.__aud_timer_running === true && fullMatchMode === true) {
      console.log("SOUND: resume (delayed 2s)");
      await playWav(SOUND.resume);
    }
  }, 2000);
}

/* ---------- Timer display ---------- */
function formatTime(s) {
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return `${m}:${sec}`;
}

function renderTimer(s) {
  const el = document.getElementById("timer");
  if (el) el.textContent = formatTime(Math.max(0, s | 0));
}

/* ---------- Teams ---------- */
function renderTeamsFromData(teamsObj) {
  const redDiv = document.getElementById("red-teams");
  const blueDiv = document.getElementById("blue-teams");
  if (!redDiv || !blueDiv) return;

  redDiv.innerHTML = "";
  blueDiv.innerHTML = "";

  const redStations = ["red1", "red2", "red3"];
  const blueStations = ["blue1", "blue2", "blue3"];
  const teams = teamsObj || {};

  const makeBox = (team, isRed) => {
    const box = document.createElement("div");
    box.className = `team-box ${isRed ? "red" : "blue"}`;
    box.textContent = team && team.trim() !== "" ? team : "\u00A0";
    return box;
  };

  if (!isReversed) {
    redStations.forEach((st) => redDiv.appendChild(makeBox(teams[st], true)));
    blueStations.forEach((st) => blueDiv.appendChild(makeBox(teams[st], false)));
  } else {
    blueStations.forEach((st) => redDiv.appendChild(makeBox(teams[st], false)));
    redStations.forEach((st) => blueDiv.appendChild(makeBox(teams[st], true)));
  }
}

/* ---------- Run init / gating ---------- */
function resetForNewRun(initialRemaining) {
  clearResumeTimeout();

  phase = {
    startPlayed: false,
    autoEndPlayed: false,
    endgameWarnPlayed: false,
    matchEndPlayed: false,
  };

  const rem = Math.max(0, Math.floor(initialRemaining || 0));

  // Determine whether this run is "full match mode"
  // Must have schedule enabled AND the run appears to start at total match length.
  const hasTiming = timing && Number.isFinite(timing.total) && timing.total > 0;
  const nearTotal = hasTiming && Math.abs(rem - timing.total) <= FULL_MATCH_TOLERANCE_SECONDS;

  fullMatchMode = (scheduleEnabled === true) && hasTiming && nearTotal;

  // Always set these for logging/clarity
  runTotalSeconds = hasTiming ? timing.total : rem;

  // Only meaningful in fullMatchMode
  if (fullMatchMode) {
    autoEndThreshold = Math.max(0, runTotalSeconds - (timing.auto || 0));
  } else {
    autoEndThreshold = null;
  }

  console.log("NEW RUN:", {
    remainingAtStart: rem,
    scheduleEnabled,
    hasTiming,
    timingTotal: timing.total,
    fullMatchMode,
    autoEndThreshold,
  });
}

/* ---------- Sound logic ---------- */
async function handleSoundsFromTimer(data, remaining, running) {
  window.__aud_timer_running = running;

  // Start of run
  if (running && !lastRunning) {
    resetForNewRun(remaining);

    // start.wav only in full match mode
    if (fullMatchMode && !phase.startPlayed) {
      phase.startPlayed = true;
      console.log("SOUND: start");
      await playWav(SOUND.start);
    }
  }

  // Manual stop clears pending resume
  if (!running && lastRunning) {
    clearResumeTimeout();
  }

  // Phase triggers ONLY in full match mode
  if (fullMatchMode && running && typeof lastRemaining === "number") {
    // 1) End of auto
    if (
      !phase.autoEndPlayed &&
      autoEndThreshold !== null &&
      lastRemaining > autoEndThreshold &&
      remaining <= autoEndThreshold
    ) {
      phase.autoEndPlayed = true;

      console.log("SOUND: end of auto");
      await playWav(SOUND.end);

      // wait 2 seconds, then resume.wav
      scheduleResumeIn2s();
    }

    // 2) Endgame warning
    const endgameSec = (timing && Number.isFinite(timing.endgame)) ? timing.endgame : 30;
    if (
      !phase.endgameWarnPlayed &&
      lastRemaining > endgameSec &&
      remaining <= endgameSec
    ) {
      phase.endgameWarnPlayed = true;

      console.log("SOUND: endgame warning");
      await playWav(SOUND.warning);
    }
  }

  // Match end: always play end.wav on natural completion (even in ad-hoc mode)
  // If you want to disable end.wav for ad-hoc too, tell me and I'll gate it behind fullMatchMode.
  if (typeof data.end_seq !== "undefined") {
    if (lastSeenEndSeq === null || typeof lastSeenEndSeq === "undefined") {
      lastSeenEndSeq = data.end_seq;
    } else if (data.end_seq !== lastSeenEndSeq) {
      lastSeenEndSeq = data.end_seq;

      if (data.end_reason === "completed" && !phase.matchEndPlayed) {
        phase.matchEndPlayed = true;
        clearResumeTimeout();

        console.log("SOUND: match end");
        await playWav(SOUND.end);
      } else {
        clearResumeTimeout();
      }
    }
  } else {
    // fallback if server doesn't provide end_seq/end_reason
    if (
      lastRunning &&
      !running &&
      typeof lastRemaining === "number" &&
      lastRemaining > 0 &&
      remaining === 0 &&
      !phase.matchEndPlayed
    ) {
      phase.matchEndPlayed = true;
      clearResumeTimeout();

      console.log("SOUND: match end (fallback)");
      await playWav(SOUND.end);
    }
  }

  lastRemaining = remaining;
  lastRunning = running;
}

/* ---------- SSE ---------- */
function initSSE() {
  console.log("SSE: connecting to /stream …");
  const es = new EventSource("/stream");

  es.addEventListener("timer", async (e) => {
    try {
      const d = JSON.parse(e.data);

      const running = !!d.running;
      const remaining = running ? Math.max(0, Math.floor(d.remaining || 0)) : 0;

      renderTimer(remaining);

      const nameEl = document.getElementById("event-name");
      if (nameEl && d.event_name) nameEl.textContent = d.event_name;

      await handleSoundsFromTimer(d, remaining, running);

      renderTeamsFromData(d.teams || {});
    } catch (err) {
      console.error("Bad SSE timer payload", err);
    }
  });

  es.onerror = () => {
    console.warn("SSE: reconnecting…");
    es.close();
    setTimeout(initSSE, 2000);
  };
}

/* ---------- Load schedule/timing ---------- */
async function loadScheduleAndTiming() {
  try {
    const res = await fetch("/schedule/data", { cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json();

    // schedule enabled only when actual matches exist
    scheduleEnabled = Array.isArray(data.matches) && data.matches.length > 0;

    // timing (optional)
    if (data && data.timing) {
      const t = data.timing;
      const auto = Number(t.auto);
      const teleop = Number(t.teleop);
      const endgame = Number(t.endgame);
      const total = Number(t.total);

      if ([auto, teleop, endgame, total].every((n) => Number.isFinite(n) && n >= 0)) {
        timing = { auto, teleop, endgame, total };
      }
    }

    console.log("SCHEDULE/TIMING:", { scheduleEnabled, timing });
  } catch (e) {
    console.warn("Schedule/timing load failed; using defaults", e);
  }
}

/* ---------- Mute indicator click unlock ---------- */
(function wireMuteUnlock() {
  const icon = document.getElementById("mute-indicator");
  if (!icon) return;

  // Visible until we successfully play at least once or unlock succeeds
  setMuteIndicatorVisible(true);

  icon.style.cursor = "pointer";
  icon.title = "Click to enable sound";

  icon.addEventListener("click", async () => {
    const ok = await unlockAudio();
    if (!ok) showAlert();
  });
})();

/* ---------- Start ---------- */
(async function start() {
  await loadScheduleAndTiming();
  initSSE();
})();