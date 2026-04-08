/**
 * forge.config.js — Electron Forge build configuration for BrowserWire
 */

export default {
  packagerConfig: {
    name: "BrowserWire",
    executableName: "browserwire",
    appBundleId: "com.browserwire.app",
    icon: "./electron/icons/icon",
    asar: true,
    ignore: [/electron\/ui\/src/, /electron\/ui\/build\.js/, /electron\/ui\/tsconfig/],
    ...(process.env.APPLE_SIGNING_IDENTITY
      ? {
          osxSign: {
            identity: process.env.APPLE_SIGNING_IDENTITY,
          },
          osxNotarize: {
            tool: "notarytool",
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "gearsec",
          name: "browserwire",
        },
        prerelease: false,
      },
    },
  ],
};
