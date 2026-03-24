/**
 * screenshot.js — Screenshot capture and annotation for Electron.
 *
 * Uses webContents.capturePage() instead of chrome.tabs.captureVisibleTab().
 * Annotation uses a hidden BrowserWindow with OffscreenCanvas equivalent.
 */

import { BrowserWindow } from "electron";

/**
 * Capture a screenshot from the given webContents.
 *
 * @param {Electron.WebContents} webContents
 * @returns {Promise<string>} Base64-encoded JPEG
 */
export const captureScreenshot = async (webContents) => {
  const image = await webContents.capturePage();
  const jpegBuffer = image.toJPEG(50);
  return jpegBuffer.toString("base64");
};

/**
 * Annotate a screenshot with orange boxes around interactable skeleton elements.
 *
 * Uses a hidden BrowserWindow with a canvas to draw annotations,
 * matching the extension's annotateScreenshot() behavior.
 *
 * @param {string} screenshotBase64 - Base64-encoded JPEG
 * @param {Array} skeleton - Skeleton entries with { interactable, rect, scanId }
 * @param {number} devicePixelRatio
 * @returns {Promise<string|null>} Base64-encoded annotated JPEG, or null on failure
 */
export const annotateScreenshot = async (screenshotBase64, skeleton, devicePixelRatio) => {
  if (!skeleton || skeleton.length === 0) return screenshotBase64;

  let hiddenWindow = null;
  try {
    hiddenWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await hiddenWindow.loadURL("about:blank");

    const annotated = await hiddenWindow.webContents.executeJavaScript(`
      (async () => {
        const b64 = ${JSON.stringify(screenshotBase64)};
        const skeleton = ${JSON.stringify(skeleton)};
        const dpr = ${devicePixelRatio || 1};

        const byteStr = atob(b64);
        const arr = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
        const blob = new Blob([arr], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);

        ctx.font = "bold " + Math.round(10 * dpr) + "px sans-serif";

        for (const entry of skeleton) {
          if (!entry.interactable || !entry.rect) continue;
          const { x, y, width, height } = entry.rect;
          const px = x * dpr;
          const py = y * dpr;
          const pw = width * dpr;
          const ph = height * dpr;

          ctx.fillStyle = "rgba(255, 165, 0, 0.3)";
          ctx.fillRect(px, py, pw, ph);

          ctx.strokeStyle = "rgba(255, 140, 0, 0.8)";
          ctx.lineWidth = 1;
          ctx.strokeRect(px, py, pw, ph);

          ctx.fillStyle = "rgba(255, 165, 0, 0.9)";
          ctx.fillText("s" + entry.scanId, px + 2, py + Math.round(11 * dpr));
        }

        const annotatedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
        const arrayBuffer = await annotatedBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      })()
    `);

    return annotated;
  } catch (error) {
    console.error("[browserwire-electron] annotateScreenshot failed:", error);
    return screenshotBase64; // Return unannotated on failure
  } finally {
    if (hiddenWindow) {
      hiddenWindow.destroy();
    }
  }
};
