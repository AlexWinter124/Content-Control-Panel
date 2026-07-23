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

    els.generateStatus.textContent = "Workflow laeuft (dauert i.d.R. 30-90s)...";
    activeRunId = await findRunId(triggerTime);

    if (cancelRequested) return;
    const issue = await pollForNewIssue(triggerTime);

    if (cancelRequested) return;
    if (!issue) {
      els.generateStatus.textContent =
        "Kein Ergebnis nach 3 Minuten gefunden. Schau im Actions-Tab bzw. bei den Issues nach.";
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

async function pollForNewIssue(sinceDate, maxWaitMs = 180000, intervalMs = 5000) {
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

const els2 = {
  chkPreview: document.getElementById("chkPreview"),
};
els2.chkPreview.checked = localStorage.getItem(PREVIEW_KEY) === "1";
els2.chkPreview.addEventListener("change", () => {
  localStorage.setItem(PREVIEW_KEY, els2.chkPreview.checked ? "1" : "0");
});

document.querySelectorAll(".dropzone").forEach((zone) => {
  const channel = zone.dataset.channel;
  const input = zone.querySelector(".dz-input");
  const status = zone.querySelector(".dz-status");
  const previewBox = zone.querySelector(".dz-preview");
  const previewVideo = zone.querySelector(".dz-preview-video");
  const discardBtn = zone.querySelector(".dz-discard-btn");
  const confirmBtn = zone.querySelector(".dz-confirm-btn");
  let pendingFile = null;
  let objectUrl = null;

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
      handleUpload(channel, file, status);
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
    await handleUpload(channel, file, status);
  });
});

async function handleUpload(channel, file, statusEl) {
  statusEl.className = "dz-status";
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

    statusEl.className = "dz-status success";
    statusEl.textContent = `✓ Hochgeladen: ${file.name}`;
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

init();
