module.exports = {
  artifactName: "${productName}-${version}-development-unsigned-${os}-${arch}.${ext}",
  dmg: {
    artifactName: "${productName}-${version}-development-unsigned-${arch}.${ext}"
  },
  mac: {
    identity: null,
    forceCodeSigning: false,
    hardenedRuntime: false
  },
  win: {
    forceCodeSigning: false,
    signExecutable: false
  }
};
