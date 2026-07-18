const { build } = require("./package.json");

module.exports = {
  ...build,
  artifactName: "${productName}-${version}-development-unsigned-${os}-${arch}.${ext}",
  dmg: {
    ...build.dmg,
    artifactName: "${productName}-${version}-development-unsigned-${arch}.${ext}"
  },
  mac: {
    ...build.mac,
    identity: null,
    forceCodeSigning: false,
    hardenedRuntime: false
  },
  win: {
    ...build.win,
    forceCodeSigning: false,
    signExecutable: false
  }
};
