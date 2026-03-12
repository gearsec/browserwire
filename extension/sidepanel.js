const backendStatusNode = document.querySelector("#backendStatus");
const sessionStatusNode = document.querySelector("#sessionStatus");
const sessionStatsNode = document.querySelector("#sessionStats");
const wsUrlInput = document.querySelector("#wsUrl");
const logNode = document.querySelector("#log");

const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const startExploringButton = document.querySelector("#startExploring");
const stopExploringButton = document.querySelector("#stopExploring");
const checkpointButton = document.querySelector("#checkpoint");
const checkpointRow = document.querySelector("#checkpointRow");
const checkpointNoteInput = document.querySelector("#checkpointNote");
const checkpointOverlay = document.querySelector("#checkpointOverlay");
const apiStatusNode = document.querySelector("#apiStatus");

const siteOriginNode = document.querySelector("#siteOrigin");
const statSnapshots = document.querySelector("#statSnapshots");
const statEntities = document.querySelector("#statEntities");
const statActions = document.querySelector("#statActions");
const statViews = document.querySelector("#statViews");
const statBuffered = document.querySelector("#statBuffered");

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
    statEntities.textContent = session.entityCount || 0;
    statActions.textContent = session.actionCount || 0;
    statViews.textContent = session.viewCount || 0;
    sessionStatsNode.classList.add("visible");

    // Show checkpoint controls during active session
    checkpointRow.style.display = "";
    checkpointNoteInput.classList.add("visible");
  } else {
    setLineStatus(sessionStatusNode, "Session: Idle", "warn");
    siteOriginNode.style.display = "none";
    sessionStatsNode.classList.remove("visible");

    // Hide checkpoint controls when idle
    checkpointRow.style.display = "none";
    checkpointNoteInput.classList.remove("visible");
  }
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
  try {
    await sendBackgroundCommand("stop_exploring");
    log("Exploration stopped");
  } catch (error) {
    log(`Stop exploring failed: ${error.message}`);
  }
});

checkpointButton.addEventListener("click", async () => {
  const note = checkpointNoteInput.value.trim();
  try {
    await sendBackgroundCommand("checkpoint", { note });
    log(`Checkpoint triggered${note ? `: "${note}"` : ""}`);
  } catch (error) {
    log(`Checkpoint failed: ${error.message}`);
  }
});

const showApiStatus = () => {
  apiStatusNode.style.display = "block";
  apiStatusNode.innerHTML = 'API ready at <a href="http://127.0.0.1:8787/api/docs" target="_blank">http://127.0.0.1:8787/api/docs</a>';
};

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
    showApiStatus();
  }

  if (message.event === "checkpoint_started") {
    checkpointOverlay.classList.add("visible");
  }

  if (message.event === "checkpoint_complete") {
    checkpointOverlay.classList.remove("visible");
    checkpointNoteInput.value = "";
    showApiStatus();
    log(`Checkpoint complete${message.checkpointIndex !== undefined ? ` (${message.checkpointIndex})` : ""}`);
  }

  if (message.event === "buffered") {
    if (statBuffered) statBuffered.textContent = message.count || 0;
  }
});

sendBackgroundCommand("get_state").catch((error) => {
  log(`Unable to fetch initial state: ${error.message}`);
});
