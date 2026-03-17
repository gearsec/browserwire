const backendStatusNode = document.querySelector("#backendStatus");
const sessionStatusNode = document.querySelector("#sessionStatus");
const sessionStatsNode = document.querySelector("#sessionStats");
const wsUrlInput = document.querySelector("#wsUrl");
const logNode = document.querySelector("#log");

const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const startExploringButton = document.querySelector("#startExploring");
const stopExploringButton = document.querySelector("#stopExploring");
const sessionNoteInput = document.querySelector("#sessionNote");
const processingStatusNode = document.querySelector("#processingStatus");
const processingListNode = document.querySelector("#processingList");

const siteOriginNode = document.querySelector("#siteOrigin");
const statSnapshots = document.querySelector("#statSnapshots");

const setLineStatus = (node, text, level) => {
  node.textContent = text;
  node.className = level;
};

const log = (message) => {
  const now = new Date().toLocaleTimeString();
  logNode.textContent = `[${now}] ${message}\n${logNode.textContent}`;
};

const mapLevel = (state) => {
  if (state === "connected") {
    return "ok";
  }

  if (state === "disconnected") {
    return "warn";
  }

  return "warn";
};

const renderProcessingStatus = (batches) => {
  if (!batches || batches.length === 0) {
    processingStatusNode.classList.remove("visible");
    return;
  }

  processingStatusNode.classList.add("visible");
  processingListNode.innerHTML = batches.map((b) => {
    let indicator;
    if (b.status === "pending") {
      indicator = "⏸";
    } else if (b.status === "processing" || b.status === "sent") {
      indicator = "⏳";
    } else if (b.status === "complete") {
      indicator = "✓";
    } else {
      indicator = "✗";
    }
    const label = b.batchId ? b.batchId.slice(0, 8) + "…" : "batch";
    const detail = b.error ? ` (${b.error})` : "";
    return `<div class="stat-row"><span class="stat-label">${indicator} ${label}</span><span class="stat-value">${b.status}${detail}</span></div>`;
  }).join("");
};

const renderState = (state) => {
  if (!state) {
    return;
  }

  if (typeof state.wsUrl === "string" && state.wsUrl.length > 0) {
    wsUrlInput.value = state.wsUrl;
  }

  const backendState = state.backendState || "disconnected";
  setLineStatus(
    backendStatusNode,
    `Backend: ${backendState}`,
    mapLevel(backendState)
  );

  // Smart button visibility
  if (backendState === "connected") {
    connectButton.style.display = "none";
    disconnectButton.style.display = "";
    wsUrlInput.disabled = true;
  } else if (backendState === "disconnected" && state.autoConnectGaveUp) {
    connectButton.style.display = "";
    disconnectButton.style.display = "none";
    wsUrlInput.disabled = false;
  } else {
    // connecting / reconnecting — hide both, status text is enough
    connectButton.style.display = "none";
    disconnectButton.style.display = "none";
    wsUrlInput.disabled = true;
  }

  if (state.session && state.session.sessionId) {
    const session = state.session;
    setLineStatus(
      sessionStatusNode,
      `Session: exploring (${session.snapshotCount || 0} snapshots)`,
      "ok"
    );

    // Show site origin
    try {
      const origin = new URL(session.url).origin;
      siteOriginNode.textContent = `Site: ${origin}`;
      siteOriginNode.style.display = "";
    } catch {
      siteOriginNode.style.display = "none";
    }

    statSnapshots.textContent = session.snapshotCount || 0;
    sessionStatsNode.classList.add("visible");

    // Show session note textarea during active session
    sessionNoteInput.classList.add("visible");
  } else {
    setLineStatus(sessionStatusNode, "Session: Idle", "warn");
    siteOriginNode.style.display = "none";
    sessionStatsNode.classList.remove("visible");

    // Hide session note when idle
    sessionNoteInput.classList.remove("visible");
  }

  renderProcessingStatus(state.processingBatches);
};

const sendBackgroundCommand = async (command, payload = {}) => {
  const response = await chrome.runtime.sendMessage({
    source: "sidepanel",
    command,
    ...payload
  });

  if (!response) {
    throw new Error("No response from background service worker");
  }

  if (response.state) {
    renderState(response.state);
  }

  if (response.ok !== true) {
    throw new Error(response.error || "Command failed");
  }

  return response;
};

connectButton.addEventListener("click", async () => {
  try {
    await sendBackgroundCommand("connect_backend", {
      url: wsUrlInput.value.trim()
    });
    log("Requested backend connect");
  } catch (error) {
    log(`Connect failed: ${error.message}`);
  }
});

disconnectButton.addEventListener("click", async () => {
  try {
    await sendBackgroundCommand("disconnect_backend");
    log("Requested backend disconnect");
  } catch (error) {
    log(`Disconnect failed: ${error.message}`);
  }
});

startExploringButton.addEventListener("click", async () => {
  try {
    const response = await sendBackgroundCommand("start_exploring");
    log(`Exploration started: ${response.sessionId}`);
  } catch (error) {
    log(`Start exploring failed: ${error.message}`);
  }
});

stopExploringButton.addEventListener("click", async () => {
  const note = sessionNoteInput.value.trim();
  try {
    await sendBackgroundCommand("stop_exploring", { note: note || undefined });
    sessionNoteInput.value = "";
    log("Exploration stopped");
  } catch (error) {
    log(`Stop exploring failed: ${error.message}`);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "background") {
    return;
  }

  if (message.event === "state") {
    renderState(message.state);
    return;
  }

  if (message.event === "log" && message.line) {
    log(message.line);
    return;
  }

  if (message.event === "manifest_ready") {
    log("Manifest ready");
  }

  if (message.event === "batch_status") {
    renderProcessingStatus(null);
    // Re-fetch full state to get current processingBatches
    sendBackgroundCommand("get_state").catch(() => {});
    if (message.status === "complete") {
      log(`Batch ${message.batchId?.slice(0, 8) || ""}… processing complete`);
    } else if (message.status === "error") {
      log(`Batch ${message.batchId?.slice(0, 8) || ""}… error: ${message.error || "unknown"}`);
    }
  }

  if (message.event === "buffered") {
    // Buffered count updates handled via snapshot count in state
  }
});

sendBackgroundCommand("sidepanel_opened").catch((error) => {
  log(`Unable to fetch initial state: ${error.message}`);
});
