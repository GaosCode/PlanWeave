module.exports = {
  mac: {
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist"
  },
  win: {
    forceCodeSigning: true,
    signtoolOptions: {
      rfc3161TimeStampServer: "http://timestamp.digicert.com",
      signingHashAlgorithms: ["sha256"]
    }
  }
};
