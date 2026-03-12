# BrowserWire Privacy Policy

**Last updated:** March 2026

## Overview

BrowserWire is a browser extension that auto-discovers typed browser APIs from live websites for AI agent integration. This privacy policy explains how the extension handles your data.

## Local Processing Only

BrowserWire communicates **exclusively with a localhost WebSocket server** running on your own machine. All data processing — including page snapshots, API discovery, and contract generation — happens locally on your device.

## No External Data Transmission

BrowserWire does **not** transmit any data to external servers, cloud services, or third parties. There is:

- No analytics or telemetry collection
- No usage tracking
- No advertising
- No data sharing with third parties

## Host Permission Justification

BrowserWire requests the `<all_urls>` host permission because it needs to inject content scripts on any website the user chooses to discover APIs from during an interactive discovery session. The extension only activates on pages when the user explicitly initiates a discovery session through the side panel.

## Data Storage

- **`chrome.storage.local`** is used solely to persist connection preferences (WebSocket host/port).
- **Session data** (discovered APIs, snapshots, manifests) is stored on the local filesystem by the CLI server, not by the extension.

## Third-Party Libraries

BrowserWire bundles **rrweb-record** (MIT license) for capturing DOM snapshots. This library runs entirely client-side within the extension's content script — it does not communicate with any external service.

## Changes to This Policy

Any changes to this privacy policy will be posted alongside new extension releases.

## Contact

For questions about this privacy policy, please open an issue at [github.com/gearsec/browserwire](https://github.com/gearsec/browserwire).
