module.exports = {
  mac: {
    forceCodeSigning: true
  },
  win: {
    forceCodeSigning: true,
    signtoolOptions: {
      rfc3161TimeStampServer: "http://timestamp.digicert.com",
      signingHashAlgorithms: ["sha256"]
    }
  }
};
