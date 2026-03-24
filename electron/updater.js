/**
 * updater.js — Auto-update configuration using electron-updater.
 *
 * Checks for updates from GitHub Releases on startup.
 */

export const initUpdater = () => {
  try {
    // electron-updater is a dev dependency — gracefully skip if unavailable
    import("electron-updater").then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("update-available", (info) => {
        console.log(`[browserwire-electron] update available: ${info.version}`);
      });

      autoUpdater.on("update-downloaded", (info) => {
        console.log(`[browserwire-electron] update downloaded: ${info.version} — will install on quit`);
      });

      autoUpdater.on("error", (err) => {
        console.warn(`[browserwire-electron] auto-update error:`, err.message);
      });

      autoUpdater.checkForUpdatesAndNotify().catch(() => {
        // Silently ignore update check failures (offline, no releases, etc.)
      });
    }).catch(() => {
      // electron-updater not available in dev mode
    });
  } catch {
    // Ignore
  }
};
