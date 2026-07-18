"use strict";

const { build } = require("./package.json");

module.exports = {
  ...build,
  mac: {
    ...build.mac,
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist"
  },
  win: {
    ...build.win,
    forceCodeSigning: true,
    signtoolOptions: {
      rfc3161TimeStampServer: "http://timestamp.digicert.com",
      signingHashAlgorithms: ["sha256"]
    }
  }
};
