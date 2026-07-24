const OWNER = "AlexWinter124";
const REPO = "BriefWW2-Automation";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN_KEY = "bww2_control_panel_pat";
const PREVIEW_KEY = "bww2_preview_before_upload";

const els = {
  setupScreen: document.getElementById("setupScreen"),
  mainScreen: document.getElementById("mainScreen"),
  tokenInput: document.getElementById("tokenInput"),
  saveTokenBtn: document.getElementById("saveTokenBtn"),
  setupError: document.getElementById("setupError"),
  settingsBtn: document.getElementById("settingsBtn"),
  chkBriefww2: document.getElementById("chkBriefww2"),
  chkUnspoken: document.getElementById("chkUnspoken"),
  generateBtn: document.getElementById("generateBtn"),
  cancelGenerateBtn: document.getElementById("cancelGenerateBtn"),
  generateStatus: document.getElementById("generateStatus"),
  promptsCard: document.getElementById("promptsCard"),
  promptsContainer: document.getElementById("promptsContainer"),
};

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(value) {
  localStorage.setItem(TOKEN_KEY, value);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function ghFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function verifyToken() {
  try {
    const res = await ghFetch("");
    return res.ok;
  } catch {
    return false;
  }
}

function showSetup(message) {
  els.setupScreen.classList.remove("hidden");
  els.mainScreen.classList.add("hidden");
  if (message) {
    els.setupError.textContent = message;
    els.setupError.classList.remove("hidden");
  } else {
    els.setupError.classList.add("hidden");
  }
}

function showMain() {
  els.setupScreen.classList.add("hidden");
  els.mainScreen.classList.remove("hidden");
}

async function init() {
  const token = getToken();
  if (!token) {
    showSetup();
    return;
  }
  const ok = await verifyToken();
  if (!ok) {
    showSetup("Zugangscode ungueltig oder abgelaufen - bitte neu eingeben.");
    return;
  }
  showMain();
  // Zeigt IMMER das zuletzt erzeugte Prompt-Issue an, egal ob die Seite
  // waehrend eines laufenden Generate-Vorgangs geschlossen/pausiert wurde
  // (z.B. Handy-Browser im Hintergrund) - so geht das Ergebnis nie verloren.
  loadLatestIssue();
}

async function loadLatestIssue() {
  try {
    const res = await ghFetch("/issues?labels=content-job&state=all&sort=created&direction=desc&per_page=1");
    if (!res.ok) return;
    const issues = await res.json();
    if (issues.length > 0) renderPrompts(issues[0].body);
  } catch {
    // still, kein hartes Fehlverhalten - einfach nichts anzeigen
  }
}

els.saveTokenBtn.addEventListener("click", async () => {
  const value = els.tokenInput.value.trim();
  if (!value) return;
  setToken(value);
  els.saveTokenBtn.disabled = true;
  els.saveTokenBtn.textContent = "Pruefe...";
  const ok = await verifyToken();
  els.saveTokenBtn.disabled = false;
  els.saveTokenBtn.textContent = "Speichern & verbinden";
  if (!ok) {
    clearToken();
    showSetup("Zugangscode ungueltig - konnte nicht auf das Repo zugreifen. Bitte pruefen.");
    return;
  }
  els.tokenInput.value = "";
  showMain();
});

els.settingsBtn.addEventListener("click", () => {
  if (!confirm("Zugangscode wirklich zuruecksetzen? Du musst ihn danach neu eingeben.")) return;
  clearToken();
  showSetup();
});

// --- Content generieren ---

function selectedChannels() {
  const both = els.chkBriefww2.checked && els.chkUnspoken.checked;
  if (both) return "both";
  if (els.chkBriefww2.checked) return "briefww2";
  if (els.chkUnspoken.checked) return "unspoken_civilization";
  return null;
}

let activeRunId = null;
let cancelRequested = false;

function setGenerating(isGenerating) {
  els.generateBtn.disabled = isGenerating;
  els.cancelGenerateBtn.classList.toggle("hidden", !isGenerating);
}

els.generateBtn.addEventListener("click", async () => {
  const channels = selectedChannels();
  if (!channels) {
    els.generateStatus.textContent = "Bitte mindestens einen Kanal auswaehlen.";
    return;
  }

  cancelRequested = false;
  activeRunId = null;
  setGenerating(true);
  els.promptsCard.classList.add("hidden");
  els.promptsContainer.innerHTML = "";
  els.generateStatus.textContent = "Starte Workflow...";

  const triggerTime = new Date();

  try {
    const dispatchRes = await ghFetch("/actions/workflows/generate-content.yml/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { channels } }),
    });
    if (!dispatchRes.ok) {
      throw new Error(`Workflow konnte nicht gestartet werden (HTTP ${dispatchRes.status})`);
    }

    els.generateStatus.textContent = "Workflow laeuft (dauert i.d.R. 1-4 Minuten, mit Faktencheck)...";
    activeRunId = await findRunId(triggerTime);

    if (cancelRequested) return;
    const issue = await pollForNewIssue(triggerTime);

    if (cancelRequested) return;
    if (!issue) {
      els.generateStatus.textContent =
        "Kein Ergebnis nach 7 Minuten gefunden. Schau im Actions-Tab bzw. bei den Issues nach.";
      return;
    }

    els.generateStatus.textContent = "Fertig!";
    renderPrompts(issue.body);
  } catch (err) {
    if (!cancelRequested) els.generateStatus.textContent = `Fehler: ${err.message}`;
  } finally {
    if (!cancelRequested) setGenerating(false);
    activeRunId = null;
  }
});

els.cancelGenerateBtn.addEventListener("click", async () => {
  if (!confirm("Laufenden Content-Generierungsvorgang wirklich abbrechen?")) return;
  cancelRequested = true;
  els.generateStatus.textContent = "Breche ab...";

  if (activeRunId) {
    try {
      await ghFetch(`/actions/runs/${activeRunId}/cancel`, { method: "POST" });
    } catch {
      // Workflow evtl. schon fertig/nicht mehr abbrechbar - trotzdem lokal zuruecksetzen
    }
  }

  els.generateStatus.textContent = "Abgebrochen. Naechster Versuch startet komplett neu.";
  setGenerating(false);
  activeRunId = null;
});

async function findRunId(sinceDate, maxWaitMs = 20000, intervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (cancelRequested) return null;
    const res = await ghFetch("/actions/workflows/generate-content.yml/runs?event=workflow_dispatch&per_page=5");
    if (res.ok) {
      const data = await res.json();
      const fresh = (data.workflow_runs || []).find((r) => new Date(r.created_at) >= sinceDate);
      if (fresh) return fresh.id;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function pollForNewIssue(sinceDate, maxWaitMs = 420000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (cancelRequested) return null;
    const res = await ghFetch("/issues?labels=content-job&state=open&sort=created&direction=desc&per_page=5");
    if (res.ok) {
      const issues = await res.json();
      const fresh = issues.find((i) => new Date(i.created_at) >= sinceDate);
      if (fresh) return fresh;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function renderPrompts(body) {
  const sections = body.split(/\n---\n/);
  const blocks = sections
    .map((section) => {
      const headerMatch = section.match(/##\s*([a-z0-9_]+):\s*(.+)/i);
      const statusMatch = section.match(/\*\*Status:\s*`([^`]+)`/);
      const titleMatch = section.match(/\*\*Titel:\*\*\s*(.+)/);
      const promptMatch = section.match(/```\n([\s\S]*?)\n```/);
      if (!headerMatch || !promptMatch) return null;
      return {
        channel: headerMatch[1],
        topic: headerMatch[2].trim(),
        status: statusMatch ? statusMatch[1] : "pending_video",
        title: titleMatch ? titleMatch[1].trim() : "",
        prompt: promptMatch[1].trim(),
      };
    })
    .filter(Boolean);

  els.promptsContainer.innerHTML = "";
  blocks.forEach((b, idx) => {
    const div = document.createElement("div");
    div.className = "prompt-block";
    const warn = b.status !== "pending_video";
    div.innerHTML = `
      <h3>${b.channel}: ${escapeHtml(b.topic)}${warn ? `<span class="badge warn">${escapeHtml(b.status)}</span>` : ""}</h3>
      <div>${escapeHtml(b.title)}</div>
      <pre id="promptText${idx}">${escapeHtml(b.prompt)}</pre>
      <button class="copy-btn" data-idx="${idx}">Prompt kopieren</button>
    `;
    els.promptsContainer.appendChild(div);
  });

  els.promptsContainer.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = document.getElementById(`promptText${btn.dataset.idx}`).textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Kopiert!";
        setTimeout(() => (btn.textContent = "Prompt kopieren"), 1500);
      });
    });
  });

  els.promptsCard.classList.remove("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Video-Upload ---

const TRACKING_KEY_PREFIX = "bww2_tracking_";
const TRACKING_ACTIVE_POLL_MS = 4 * 60 * 1000; // 4 Minuten aktiv nachfragen, danach nur noch manuell
const TRACKING_POLL_INTERVAL_MS = 8000;

const els2 = {
  chkPreview: document.getElementById("chkPreview"),
};
els2.chkPreview.checked = localStorage.getItem(PREVIEW_KEY) === "1";
els2.chkPreview.addEventListener("change", () => {
  localStorage.setItem(PREVIEW_KEY, els2.chkPreview.checked ? "1" : "0");
});

function getTracking(channel) {
  try {
    const raw = localStorage.getItem(TRACKING_KEY_PREFIX + channel);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setTracking(channel, jobId) {
  localStorage.setItem(TRACKING_KEY_PREFIX + channel, JSON.stringify({ jobId, startedAt: Date.now(), approved: false }));
}

function setTrackingApproved(channel, approved) {
  const tracking = getTracking(channel);
  if (!tracking) return;
  tracking.approved = approved;
  localStorage.setItem(TRACKING_KEY_PREFIX + channel, JSON.stringify(tracking));
}

function clearTrackingStorage(channel) {
  localStorage.removeItem(TRACKING_KEY_PREFIX + channel);
}

// Ermittelt VOR dem Hochladen, welcher Job (FIFO, aeltester "pending_video"
// Job dieses Kanals) das gerade hochgeladene Video abbekommen wird - das ist
// dieselbe Zuordnungsregel wie render_video.py serverseitig verwendet.
async function getOldestPendingJobId(channel) {
  const listRes = await ghFetch("/contents/data/queue/pending");
  if (!listRes.ok) return null;
  const files = (await listRes.json())
    .filter((f) => f.name.startsWith(`${channel}_`) && f.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    const fileRes = await ghFetch(`/contents/${file.path}`);
    if (!fileRes.ok) continue;
    const data = await fileRes.json();
    const job = JSON.parse(decodeURIComponent(escape(atob(data.content))));
    if (job.status === "pending_video") return job.id;
  }
  return null;
}

async function fetchJobById(jobId) {
  const res = await ghFetch(`/contents/data/queue/pending/${jobId}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return JSON.parse(decodeURIComponent(escape(atob(data.content))));
}

// Ueber den "raw"-Media-Type geholt statt per JSON+base64 - das gerenderte
// Video kann mehrere MB gross sein, die JSON-Antwort der Contents API liefert
// den base64-Inhalt aber nur bis 1MB inline mit.
async function fetchRenderedVideoUrl(jobId) {
  const res = await ghFetch(`/contents/data/queue/rendered/${jobId}.mp4`, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Loescht eine Datei im Repo ueber die Contents API (braucht deren aktuelle
// sha, deshalb erst GET dann DELETE). Gibt true zurueck bei Erfolg oder wenn
// die Datei ohnehin schon nicht (mehr) existiert.
async function deleteGithubFile(path, message) {
  const getRes = await ghFetch(`/contents/${path}`);
  if (!getRes.ok) return true;
  const data = await getRes.json();
  const delRes = await ghFetch(`/contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha: data.sha, branch: "main" }),
  });
  return delRes.ok;
}

// Kanaele laufen unabhaengig voneinander (publish_all.py wartet nicht mehr
// auf den jeweils anderen Kanal) - eine offene "Publish-Warnung"-Issue, die
// diesen Job erwaehnt, ist daher immer ein echter Fehlschlag.
async function checkPublishWarning(jobId) {
  const res = await ghFetch("/issues?state=open&sort=created&direction=desc&per_page=20");
  if (!res.ok) return null;
  const issues = await res.json();
  const match = issues.find((i) => i.title.startsWith("Publish-Warnung") && (i.body || "").includes(jobId));
  if (!match) return null;
  return { body: match.body || "" };
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

document.querySelectorAll(".dropzone").forEach((zone) => {
  const channel = zone.dataset.channel;
  const input = zone.querySelector(".dz-input");
  const status = zone.querySelector(".dz-status");
  const previewBox = zone.querySelector(".dz-preview");
  const previewVideo = zone.querySelector(".dz-preview-video");
  const discardBtn = zone.querySelector(".dz-discard-btn");
  const confirmBtn = zone.querySelector(".dz-confirm-btn");
  const trackingBox = zone.querySelector(".dz-tracking");
  const trackingLabel = zone.querySelector(".dz-tracking-label");
  const trackingVideo = zone.querySelector(".dz-tracking-video");
  const trackingRefreshBtn = zone.querySelector(".dz-tracking-refresh-btn");
  const trackingClearBtn = zone.querySelector(".dz-tracking-clear-btn");
  const trackingDiscardBtn = zone.querySelector(".dz-tracking-discard-btn");
  const trackingApproveBtn = zone.querySelector(".dz-tracking-approve-btn");
  let pendingFile = null;
  let objectUrl = null;
  let trackingVideoObjectUrl = null;
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function resetTrackingUi() {
    stopPolling();
    if (trackingVideoObjectUrl) {
      URL.revokeObjectURL(trackingVideoObjectUrl);
      trackingVideoObjectUrl = null;
    }
    trackingVideo.src = "";
    trackingVideo.classList.add("hidden");
    trackingRefreshBtn.classList.add("hidden");
    trackingClearBtn.classList.add("hidden");
    trackingDiscardBtn.classList.add("hidden");
    trackingApproveBtn.classList.add("hidden");
    trackingBox.classList.add("hidden");
    trackingLabel.className = "dz-tracking-label";
    trackingLabel.textContent = "";
  }

  async function pollOnce(jobId) {
    const job = await fetchJobById(jobId);
    if (!job) {
      trackingLabel.textContent = "Job nicht gefunden (evtl. entfernt/verworfen).";
      trackingDiscardBtn.classList.add("hidden");
      trackingApproveBtn.classList.add("hidden");
      clearTrackingStorage(channel);
      stopPolling();
      return "unknown";
    }

    if (job.status === "published") {
      trackingLabel.className = "dz-tracking-label success";
      trackingLabel.textContent = "✅ Erfolgreich auf YouTube, Facebook und Instagram veröffentlicht!";
      trackingRefreshBtn.classList.add("hidden");
      trackingClearBtn.classList.add("hidden");
      trackingDiscardBtn.classList.add("hidden");
      trackingApproveBtn.classList.add("hidden");
      clearTrackingStorage(channel);
      stopPolling();
      setTimeout(resetTrackingUi, 4000);
      return "done";
    }

    if (job.status === "scheduled") {
      trackingLabel.className = "dz-tracking-label success";
      const when = job.publish_at ? fmtDateTime(job.publish_at) : "bald";
      trackingLabel.textContent =
        `✅ Hochgeladen zu YouTube & Facebook, geplant für ${when}. Instagram folgt automatisch kurz vorher.`;
      trackingRefreshBtn.classList.remove("hidden");
      trackingClearBtn.classList.remove("hidden");
      // Ab hier ist das Video schon extern bei YouTube/Facebook hochgeladen -
      // ein einfaches Loeschen des lokalen Jobs wuerde das nicht rueckgaengig
      // machen, deshalb den Loeschen-/Freigeben-Button nur VOR diesem Punkt
      // anbieten.
      trackingDiscardBtn.classList.add("hidden");
      trackingApproveBtn.classList.add("hidden");
      return "scheduled";
    }

    if (job.status === "rendered") {
      if (!trackingVideoObjectUrl) {
        const url = await fetchRenderedVideoUrl(jobId);
        if (url) {
          trackingVideoObjectUrl = url;
          trackingVideo.src = url;
          trackingVideo.classList.remove("hidden");
        }
      }
      const warning = await checkPublishWarning(jobId);
      const tracking = getTracking(channel);
      const approved = tracking?.approved === true;
      trackingRefreshBtn.classList.remove("hidden");
      trackingClearBtn.classList.remove("hidden");

      if (warning) {
        // Freigegeben, aber fehlgeschlagen (z.B. API-Fehler) - Job bleibt
        // auf "rendered" stehen (siehe publish_all.py), also erneut
        // versuchen ODER verwerfen anbieten statt hilflos stehenzulassen.
        trackingLabel.className = "dz-tracking-label error";
        trackingLabel.textContent = `❌ Fehler beim Veröffentlichen: ${warning.body.slice(0, 220)} - erneut versuchen oder verwerfen.`;
        trackingApproveBtn.classList.remove("hidden");
        trackingApproveBtn.textContent = "✅ Erneut versuchen";
        trackingDiscardBtn.classList.remove("hidden");
        setTrackingApproved(channel, false);
        stopPolling();
        return "error";
      }

      if (approved) {
        trackingLabel.className = "dz-tracking-label";
        trackingLabel.textContent = "⏳ Freigegeben - wird gerade veröffentlicht...";
        trackingApproveBtn.classList.add("hidden");
        trackingDiscardBtn.classList.add("hidden");
        return "rendered";
      }

      trackingLabel.className = "dz-tracking-label";
      trackingLabel.textContent = "🎬 Fertig gerendert - schau es dir an. Gefällt es dir nicht, kannst du es löschen.";
      trackingApproveBtn.classList.remove("hidden");
      trackingApproveBtn.textContent = "✅ Freigeben & veröffentlichen";
      trackingDiscardBtn.classList.remove("hidden");
      return "rendered";
    }

    trackingLabel.className = "dz-tracking-label";
    trackingLabel.textContent = "⏳ Warte auf Rendering...";
    trackingRefreshBtn.classList.remove("hidden");
    trackingClearBtn.classList.remove("hidden");
    trackingDiscardBtn.classList.add("hidden");
    trackingApproveBtn.classList.add("hidden");
    return "pending";
  }

  // Setzt das Nachfragen fuer eine BESTEHENDE Tracking-Session fort (nach
  // Seiten-Neuladen oder nach einer Freigabe) - fasst KEINEN neuen
  // localStorage-Eintrag an, damit z.B. das approved-Flag erhalten bleibt.
  function resumePolling(jobId, { activePoll }) {
    trackingBox.classList.remove("hidden");

    if (!activePoll) {
      pollOnce(jobId);
      return;
    }

    const start = Date.now();
    const tick = async () => {
      const result = await pollOnce(jobId);
      if (result === "done" || result === "error") return;
      if (Date.now() - start > TRACKING_ACTIVE_POLL_MS) return; // ab hier nur noch manueller Refresh-Button
      pollTimer = setTimeout(tick, TRACKING_POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, TRACKING_POLL_INTERVAL_MS);
  }

  // Startet eine NEUE Tracking-Session (frisch hochgeladenes Video) - legt
  // den localStorage-Eintrag neu an (approved: false).
  function startTracking(jobId, { activePoll }) {
    setTracking(channel, jobId);
    trackingLabel.textContent = "⏳ Hochgeladen - warte auf Rendering...";
    trackingRefreshBtn.classList.add("hidden");
    trackingClearBtn.classList.remove("hidden");
    resumePolling(jobId, { activePoll });
  }

  trackingRefreshBtn.addEventListener("click", async () => {
    const tracking = getTracking(channel);
    if (!tracking) return;
    trackingRefreshBtn.disabled = true;
    await pollOnce(tracking.jobId);
    trackingRefreshBtn.disabled = false;
  });

  trackingClearBtn.addEventListener("click", () => {
    if (!confirm("Verfolgung dieses Uploads beenden? Der Job laeuft im Hintergrund trotzdem weiter.")) return;
    clearTrackingStorage(channel);
    resetTrackingUi();
  });

  trackingApproveBtn.addEventListener("click", async () => {
    const tracking = getTracking(channel);
    if (!tracking) return;
    if (
      !confirm(
        "Dieses Video jetzt wirklich freigeben? Es wird dann zu YouTube und Facebook hochgeladen " +
          "(geplant) und fuer Instagram vorgemerkt - das ist live und nicht mehr rueckgaengig zu machen."
      )
    ) {
      return;
    }
    trackingApproveBtn.disabled = true;
    trackingLabel.textContent = "Starte Veroeffentlichung...";
    try {
      const dispatchRes = await ghFetch("/actions/workflows/publish-job.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs: { job_id: tracking.jobId } }),
      });
      if (!dispatchRes.ok) {
        throw new Error(`Konnte nicht gestartet werden (HTTP ${dispatchRes.status})`);
      }
      setTrackingApproved(channel, true);
      trackingApproveBtn.classList.add("hidden");
      trackingDiscardBtn.classList.add("hidden");
      trackingLabel.textContent = "⏳ Freigegeben - wird gerade veröffentlicht...";
      // Aktives Nachfragen (re-)starten, falls das 4-Minuten-Fenster vom
      // urspruenglichen Upload schon abgelaufen war - OHNE das approved-Flag
      // zurueckzusetzen (siehe resumePolling vs. startTracking).
      resumePolling(tracking.jobId, { activePoll: true });
    } catch (err) {
      trackingLabel.className = "dz-tracking-label error";
      trackingLabel.textContent = `Freigabe fehlgeschlagen: ${err.message}`;
    } finally {
      trackingApproveBtn.disabled = false;
    }
  });

  trackingDiscardBtn.addEventListener("click", async () => {
    const tracking = getTracking(channel);
    if (!tracking) return;
    if (
      !confirm(
        "Dieses gerenderte Video wirklich komplett loeschen? Der Job wird entfernt (noch nicht " +
          "veroeffentlicht, also unbedenklich) - fuer diesen Kanal muss danach neuer Content " +
          "generiert werden."
      )
    ) {
      return;
    }
    trackingDiscardBtn.disabled = true;
    trackingLabel.textContent = "Loesche Video und Job...";
    try {
      await deleteGithubFile(
        `data/queue/rendered/${tracking.jobId}.mp4`,
        `Verworfenes Video geloescht (${channel}, ueber Control Panel)`
      );
      await deleteGithubFile(
        `data/queue/pending/${tracking.jobId}.json`,
        `Verworfener Job geloescht (${channel}, ueber Control Panel)`
      );
      clearTrackingStorage(channel);
      resetTrackingUi();
      status.className = "dz-status";
      status.textContent = "🗑️ Video verworfen - fuer diesen Kanal bitte neuen Content generieren.";
    } catch (err) {
      trackingLabel.className = "dz-tracking-label error";
      trackingLabel.textContent = `Loeschen fehlgeschlagen: ${err.message}`;
    } finally {
      trackingDiscardBtn.disabled = false;
    }
  });

  // Beim (Neu-)Laden pruefen, ob fuer diesen Kanal noch ein Upload verfolgt
  // wird (z.B. Tab war zwischenzeitlich im Hintergrund/geschlossen) - setzt
  // die BESTEHENDE Session fort (approved-Flag bleibt erhalten).
  const existingTracking = getTracking(channel);
  if (existingTracking) {
    resumePolling(existingTracking.jobId, { activePoll: true });
  }

  function resetPreview() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    pendingFile = null;
    previewVideo.src = "";
    previewBox.classList.add("hidden");
    input.value = "";
  }

  function handleFile(file) {
    if (!file) return;
    if (els2.chkPreview.checked) {
      pendingFile = file;
      objectUrl = URL.createObjectURL(file);
      previewVideo.src = objectUrl;
      previewBox.classList.remove("hidden");
      status.className = "dz-status";
      status.textContent = "";
    } else {
      handleUpload(channel, file, status, startTracking);
    }
  }

  input.addEventListener("change", () => handleFile(input.files[0]));

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    handleFile(e.dataTransfer.files[0]);
  });

  discardBtn.addEventListener("click", () => {
    if (!confirm("Dieses Video wirklich verwerfen? Es wird NICHT hochgeladen.")) return;
    resetPreview();
  });

  confirmBtn.addEventListener("click", async () => {
    const file = pendingFile;
    resetPreview();
    await handleUpload(channel, file, status, startTracking);
  });
});

async function handleUpload(channel, file, statusEl, startTracking) {
  statusEl.className = "dz-status";
  statusEl.textContent = "Suche passenden Job...";
  const targetJobId = await getOldestPendingJobId(channel).catch(() => null);

  statusEl.textContent = `Lade "${file.name}" hoch...`;

  try {
    const base64 = await fileToBase64(file);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `data/queue/incoming/${channel}/${Date.now()}_${safeName}`;

    const res = await ghFetch(`/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Rohvideo hochgeladen ueber Control Panel (${channel})`,
        content: base64,
        branch: "main",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    if (targetJobId) {
      statusEl.className = "dz-status success";
      statusEl.textContent = `✓ Hochgeladen: ${file.name}`;
      startTracking(targetJobId, { activePoll: true });
    } else {
      statusEl.className = "dz-status error";
      statusEl.textContent =
        `✓ Hochgeladen: ${file.name} - ⚠️ aber KEIN wartender Job fuer diesen Kanal gefunden! ` +
        "Bitte pruefen, ob zuerst 'Content generieren' noetig ist.";
    }
  } catch (err) {
    statusEl.className = "dz-status error";
    statusEl.textContent = `Fehler: ${err.message}`;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Tabs ---

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "tab-dashboard") loadDashboard();
  });
});

// --- Dashboard / Kalender ---

const CHANNEL_LABELS = { briefww2: "BriefWW2", unspoken_civilization: "Unspoken Civilization" };

let allJobs = null; // Cache fuer die Dauer der Session
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

const calEls = {
  monthLabel: document.getElementById("calMonthLabel"),
  grid: document.getElementById("calendarGrid"),
  prevBtn: document.getElementById("calPrevBtn"),
  nextBtn: document.getElementById("calNextBtn"),
  unscheduledList: document.getElementById("unscheduledList"),
};

calEls.prevBtn.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
calEls.nextBtn.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});

async function loadDashboard() {
  if (allJobs === null) {
    calEls.unscheduledList.textContent = "Lade Jobs...";
    allJobs = await fetchAllJobs();
  }
  renderCalendar();
  renderUnscheduled();

  if (statsHistory === null) await loadStats();
}

async function fetchAllJobs() {
  const listRes = await ghFetch("/contents/data/queue/pending");
  if (!listRes.ok) return [];
  const files = (await listRes.json()).filter((f) => f.name.endsWith(".json"));

  const jobs = [];
  for (const file of files) {
    try {
      const fileRes = await ghFetch(`/contents/${file.path}`);
      if (!fileRes.ok) continue;
      const data = await fileRes.json();
      const content = JSON.parse(decodeURIComponent(escape(atob(data.content))));
      jobs.push(content);
    } catch {
      // einzelne kaputte/unlesbare Datei ueberspringen, Rest trotzdem anzeigen
    }
  }
  return jobs;
}

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  calEls.monthLabel.textContent = calendarMonth.toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  const jobsByDay = {};
  for (const job of allJobs || []) {
    if (!job.publish_at) continue;
    const d = new Date(job.publish_at);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const key = d.getDate();
    (jobsByDay[key] = jobsByDay[key] || []).push(job);
  }

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Montag = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  let html = "";
  ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].forEach((d) => {
    html += `<div class="cal-weekday">${d}</div>`;
  });
  for (let i = 0; i < firstWeekday; i++) html += `<div class="cal-day empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
    const jobsToday = jobsByDay[day] || [];
    const dotsHtml = jobsToday
      .map((j) => `<span class="cal-dot ${j.channel}${j.status !== "published" ? " dim" : ""}" title="${escapeHtml(j.channel)}: ${escapeHtml(j.topic)} (${escapeHtml(j.status)})"></span>`)
      .join("");
    html += `<div class="cal-day${isToday ? " today" : ""}">
      <div class="cal-day-num">${day}</div>
      <div class="cal-day-dots">${dotsHtml}</div>
    </div>`;
  }

  calEls.grid.innerHTML = html;
}

function renderUnscheduled() {
  const unscheduled = (allJobs || []).filter((j) => !j.publish_at);
  if (unscheduled.length === 0) {
    calEls.unscheduledList.textContent = "Alles eingeplant - nichts Offenes.";
    return;
  }
  calEls.unscheduledList.innerHTML = unscheduled
    .map(
      (j) => `<div class="unscheduled-item">
        <strong>${escapeHtml(CHANNEL_LABELS[j.channel] || j.channel)}</strong>: ${escapeHtml(j.topic)}
        <span class="badge${j.status === "needs_review" ? " warn" : ""}">${escapeHtml(j.status)}</span>
      </div>`
    )
    .join("");
}

// --- Statistiken ---

const statsEls = {
  grid: document.getElementById("statsGrid"),
  updatedAt: document.getElementById("statsUpdatedAt"),
  status: document.getElementById("statsStatus"),
  refreshBtn: document.getElementById("refreshStatsBtn"),
};

let statsHistory = null;

async function loadStats() {
  statsEls.status.textContent = "Lade Statistiken...";
  statsHistory = await fetchStatsHistory();
  renderStats();
  renderTrendCharts();
  statsEls.status.textContent = "";
}

async function fetchStatsHistory() {
  try {
    const res = await ghFetch("/contents/data/stats/history.json");
    if (!res.ok) return [];
    const data = await res.json();
    return JSON.parse(decodeURIComponent(escape(atob(data.content))));
  } catch {
    return [];
  }
}

function renderStats() {
  if (!statsHistory || statsHistory.length === 0) {
    statsEls.updatedAt.textContent = "";
    statsEls.grid.innerHTML = "";
    statsEls.status.textContent = "Noch keine Statistiken gesammelt - auf 🔄 tippen.";
    return;
  }

  const latest = statsHistory[statsHistory.length - 1];
  const updated = new Date(latest.collected_at);
  statsEls.updatedAt.textContent = `Stand: ${updated.toLocaleString("de-DE")}`;

  const fmt = (n) => (n === undefined || n === null ? "–" : n.toLocaleString("de-DE"));

  statsEls.grid.innerHTML = Object.entries(latest.channels)
    .map(([channel, data]) => {
      const yt = data.youtube || {};
      return `
        <div class="stat-channel-block" data-channel="${channel}">
          <div class="stat-channel-name">${escapeHtml(CHANNEL_LABELS[channel] || channel)}</div>
          <div class="stat-tiles">
            <div class="stat-tile"><div class="stat-tile-value">${fmt(yt.subscribers)}</div><div class="stat-tile-label">YT Abonnenten</div></div>
            <div class="stat-tile"><div class="stat-tile-value">${fmt(yt.views)}</div><div class="stat-tile-label">YT Views</div></div>
            <div class="stat-tile"><div class="stat-tile-value">${fmt(yt.videos)}</div><div class="stat-tile-label">YT Videos</div></div>
            <div class="stat-tile"><div class="stat-tile-value">${fmt(data.facebook_followers)}</div><div class="stat-tile-label">FB Follower</div></div>
            <div class="stat-tile"><div class="stat-tile-value">${fmt(data.instagram_followers)}</div><div class="stat-tile-label">IG Follower</div></div>
            <div class="stat-tile"><div class="stat-tile-value">${fmt(data.instagram_media_count)}</div><div class="stat-tile-label">IG Posts</div></div>
          </div>
        </div>
      `;
    })
    .join("");
}

statsEls.refreshBtn.addEventListener("click", async () => {
  statsEls.refreshBtn.disabled = true;
  statsEls.status.textContent = "Starte Aktualisierung...";
  const triggerTime = new Date();

  try {
    const dispatchRes = await ghFetch("/actions/workflows/collect-stats.yml/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: "main" }),
    });
    if (!dispatchRes.ok) {
      throw new Error(`Konnte nicht gestartet werden (HTTP ${dispatchRes.status})`);
    }

    statsEls.status.textContent = "Sammle Statistiken (dauert i.d.R. 20-40s)...";
    const updated = await pollForStatsUpdate(triggerTime);

    if (!updated) {
      statsEls.status.textContent = "Kein Ergebnis nach 2 Minuten - schau im Actions-Tab nach.";
      return;
    }

    statsHistory = updated;
    renderStats();
    renderTrendCharts();
    statsEls.status.textContent = "Aktualisiert!";
  } catch (err) {
    statsEls.status.textContent = `Fehler: ${err.message}`;
  } finally {
    statsEls.refreshBtn.disabled = false;
  }
});

async function pollForStatsUpdate(sinceDate, maxWaitMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const history = await fetchStatsHistory();
    const latest = history[history.length - 1];
    if (latest && new Date(latest.collected_at) >= sinceDate) return history;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// --- Trend-Charts ---

const CHANNEL_COLORS = {
  briefww2: "var(--ch-briefww2)",
  unspoken_civilization: "var(--ch-unspoken)",
};

const METRIC_DEFS = [
  { key: "yt_subs", label: "YouTube Abonnenten", accessor: (c) => c?.youtube?.subscribers },
  { key: "yt_views", label: "YouTube Views", accessor: (c) => c?.youtube?.views },
  { key: "fb_followers", label: "Facebook Follower", accessor: (c) => c?.facebook_followers },
  { key: "ig_followers", label: "Instagram Follower", accessor: (c) => c?.instagram_followers },
];

let selectedRangeDays = 30;

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedRangeDays = Number(btn.dataset.days);
    renderTrendCharts();
  });
});

function fmtCompact(n) {
  if (n === undefined || n === null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let niceNorm;
  if (normalized <= 1) niceNorm = 1;
  else if (normalized <= 2) niceNorm = 2;
  else if (normalized <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * magnitude;
}

function renderTrendCharts() {
  const container = document.getElementById("trendCharts");
  container.innerHTML = "";

  if (!statsHistory || statsHistory.length === 0) {
    container.innerHTML = '<div class="trend-empty">Noch keine Verlaufsdaten - sammle sich mit jedem Update.</div>';
    return;
  }

  const cutoff = Date.now() - selectedRangeDays * 24 * 60 * 60 * 1000;
  const snapshots = statsHistory
    .map((s) => ({ date: new Date(s.collected_at), channels: s.channels }))
    .filter((s) => s.date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date);

  METRIC_DEFS.forEach((metric) => {
    const block = document.createElement("div");
    block.className = "trend-chart-block";
    block.innerHTML = `<div class="trend-chart-title">${escapeHtml(metric.label)}</div>`;
    container.appendChild(block);
    renderLineChart(block, metric, snapshots);
  });
}

function renderLineChart(block, metric, snapshots) {
  const W = 600, H = 180;
  const marginLeft = 38, marginRight = 54, marginTop = 12, marginBottom = 22;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;

  const channels = Object.keys(CHANNEL_COLORS);
  const seriesByChannel = {};
  let hasAnyData = false;
  channels.forEach((ch) => {
    seriesByChannel[ch] = snapshots
      .map((s) => ({ x: s.date, y: metric.accessor(s.channels[ch]) }))
      .filter((p) => p.y !== undefined && p.y !== null);
    if (seriesByChannel[ch].length > 0) hasAnyData = true;
  });

  if (!hasAnyData) {
    block.innerHTML += '<div class="trend-empty">Keine Daten in diesem Zeitraum.</div>';
    return;
  }

  const allPoints = channels.flatMap((ch) => seriesByChannel[ch]);
  const xMin = Math.min(...allPoints.map((p) => p.x.getTime()));
  const xMax = Math.max(...allPoints.map((p) => p.x.getTime()));
  const yMaxRaw = Math.max(...allPoints.map((p) => p.y));
  const yMax = niceMax(yMaxRaw * 1.15);
  const yMin = 0;

  const xScale = (t) => (xMax === xMin ? marginLeft + plotW / 2 : marginLeft + ((t - xMin) / (xMax - xMin)) * plotW);
  const yScale = (v) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const tickCount = 4;
  let gridlines = "";
  for (let i = 0; i <= tickCount; i++) {
    const v = (yMax / tickCount) * i;
    const y = yScale(v);
    gridlines += `<line class="trend-gridline" x1="${marginLeft}" x2="${W - marginRight}" y1="${y}" y2="${y}"></line>`;
    gridlines += `<text class="trend-axis-label" x="${marginLeft - 6}" y="${y + 3}" text-anchor="end">${fmtCompact(Math.round(v))}</text>`;
  }

  let linesAndDots = "";
  const endLabelPositions = [];
  channels.forEach((ch) => {
    const pts = seriesByChannel[ch];
    if (pts.length === 0) return;
    const colorVar = CHANNEL_COLORS[ch];
    if (pts.length > 1) {
      const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x.getTime())},${yScale(p.y)}`).join(" ");
      linesAndDots += `<path class="trend-line" d="${pathD}" style="stroke:${colorVar}; color:${colorVar};"></path>`;
    }
    const last = pts[pts.length - 1];
    const lx = xScale(last.x.getTime());
    const ly = yScale(last.y);
    linesAndDots += `<circle class="trend-end-dot" cx="${lx}" cy="${ly}" r="5" style="fill:${colorVar};"></circle>`;
    endLabelPositions.push({ ch, ly, value: last.y, colorVar, lx });
  });

  // Kollisions-Vermeidung: wenn Endlabels zu nah beieinander, leicht auseinanderschieben
  endLabelPositions.sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < endLabelPositions.length; i++) {
    const minGap = 14;
    if (endLabelPositions[i].ly - endLabelPositions[i - 1].ly < minGap) {
      endLabelPositions[i].ly = endLabelPositions[i - 1].ly + minGap;
    }
  }
  let endLabels = "";
  endLabelPositions.forEach((p) => {
    endLabels += `<text class="trend-end-label" x="${W - marginRight + 8}" y="${p.ly + 3}">${fmtCompact(p.value)}</text>`;
  });

  const svg = `
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${gridlines}
      ${linesAndDots}
      ${endLabels}
      <line class="trend-crosshair" id="crosshair-${metric.key}" x1="0" x2="0" y1="${marginTop}" y2="${marginTop + plotH}"></line>
    </svg>
    <div class="trend-legend">
      ${channels
        .map(
          (ch) => `<span class="trend-legend-item"><span class="trend-legend-key" style="background:${CHANNEL_COLORS[ch]};"></span>${escapeHtml(CHANNEL_LABELS[ch])}</span>`
        )
        .join("")}
    </div>
  `;

  const wrap = document.createElement("div");
  wrap.className = "trend-svg-wrap";
  wrap.innerHTML = svg;
  const tooltip = document.createElement("div");
  tooltip.className = "trend-tooltip";
  wrap.appendChild(tooltip);
  block.appendChild(wrap);

  const svgEl = wrap.querySelector(".trend-svg");
  const crosshairEl = wrap.querySelector(".trend-crosshair");

  function handleMove(clientX) {
    const rect = svgEl.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W;
    if (relX < marginLeft || relX > W - marginRight || allPoints.length === 0) {
      crosshairEl.style.opacity = 0;
      tooltip.style.opacity = 0;
      return;
    }
    // Naechsten Snapshot-Zeitpunkt finden
    let nearest = snapshots[0];
    let nearestDist = Infinity;
    snapshots.forEach((s) => {
      const dist = Math.abs(xScale(s.date.getTime()) - relX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = s;
      }
    });

    const px = xScale(nearest.date.getTime());
    crosshairEl.setAttribute("x1", px);
    crosshairEl.setAttribute("x2", px);
    crosshairEl.style.opacity = 1;

    const rows = channels
      .map((ch) => {
        const v = metric.accessor(nearest.channels[ch]);
        if (v === undefined || v === null) return "";
        return `<div class="trend-tooltip-row"><span class="trend-tooltip-key" style="background:${CHANNEL_COLORS[ch]};"></span>${escapeHtml(CHANNEL_LABELS[ch])}<span class="trend-tooltip-value">${v.toLocaleString("de-DE")}</span></div>`;
      })
      .join("");
    tooltip.innerHTML = `<div class="trend-tooltip-date">${nearest.date.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" })}</div>${rows}`;
    tooltip.style.opacity = 1;

    const wrapRect = wrap.getBoundingClientRect();
    const ttLeft = Math.min(Math.max((px / W) * wrapRect.width - 60, 4), wrapRect.width - 150);
    tooltip.style.left = `${ttLeft}px`;
    tooltip.style.top = "8px";
  }

  wrap.addEventListener("pointermove", (e) => handleMove(e.clientX));
  wrap.addEventListener("pointerleave", () => {
    crosshairEl.style.opacity = 0;
    tooltip.style.opacity = 0;
  });
}

init();
