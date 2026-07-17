# PlanWeave Desktop Release Runbook

This runbook covers the protected GitHub Actions `Desktop Release` workflow. Local `dist:*` and `pack:*` commands are development-only and deliberately unsigned.

## Responsibilities

- The release operator confirms the version, starts the workflow, reviews every platform verification result, and enables publication only after all build jobs pass.
- The credential owner provisions and rotates the macOS Developer ID/App Store Connect credentials and the Windows OV PFX, without placing private material in the repository or workflow artifacts.
- The repository administrator protects the `desktop-release` GitHub Environment with allowed branches/tags and required reviewers, and limits who can edit the workflow or environment secrets.

GitHub Environment protection rules run before a job can access environment secrets. Keep signing credentials as environment secrets and expose them only to the preflight and signing steps. Do not print, upload, or retain a keychain, PFX, API key, password, or an unredacted signing log.

## Release procedure

1. Update the desktop package version and run the repository tests and desktop build.
2. Start `Desktop Release` with the exact package version and leave `publish` disabled for the first run.
3. Approve the protected `desktop-release` environment after checking the commit and version.
4. Confirm the workflow generates `release` build metadata before packaging. macOS and Windows metadata must record `signedDistribution: true`; Linux records `false`. The file contains only channel, version, and signed-distribution facts.
5. Confirm macOS passes `codesign`, Gatekeeper assessment, stapler validation, DMG assessment, and startup from an isolated installed copy.
6. Confirm Windows passes SignTool verification for both the installer and installed executable, silent installation, startup, and cleanup.
7. Confirm `verify-assets` accepts the complete artifact set. Rerun with `publish` enabled only when the same commit and version pass all gates.

electron-builder places `extraResources` in the packaged resources directory, which the Electron main process reads through `process.resourcesPath`. The metadata is validated with a strict Zod schema. Missing, malformed, extended, development-channel, or unsigned metadata never enables macOS in-app installation. There is no environment-variable fallback after installation.

## Independent artifact checks

For macOS, mount the DMG and verify the installed application:

```bash
codesign --verify --deep --strict --verbose=2 /path/to/PlanWeave.app
codesign -dv --verbose=4 /path/to/PlanWeave.app
spctl --assess --type execute --verbose=4 /path/to/PlanWeave.app
xcrun stapler validate /path/to/PlanWeave.app
```

For Windows, use the Windows SDK SignTool against both files:

```powershell
signtool verify /pa /all /v /tw PlanWeave-<version>-win-x64.exe
signtool verify /pa /all /v /tw "<install-dir>\PlanWeave.exe"
```

An OV signature establishes a verifiable publisher and protects file integrity. It does not guarantee immediate SmartScreen reputation. Microsoft documents that signed files can still be reported as unrecognized until the file or publisher accumulates reputation.

## Credential rotation

1. The credential owner creates or renews the replacement credential with the same intended distribution scope.
2. Replace the relevant `desktop-release` Environment secrets. Never overlap by committing certificate material or temporarily adding a second signing provider.
3. Run the workflow with publication disabled and verify the displayed signing identity, timestamp, notarization result, stapled ticket, installed binaries, and startup smoke.
4. Publish only after verification succeeds, then revoke or securely archive the superseded credential according to the issuer's policy.
5. If a certificate or key is suspected to be exposed, stop releases, revoke it with the issuer, rotate all related secrets, and rebuild every affected artifact. Do not republish an artifact signed with the compromised identity.

## Failure diagnosis

- Metadata generation failure: confirm the workflow version equals `packages/desktop/package.json`, the channel is `release`, and `signedDistribution` is an explicit boolean. Do not hand-edit the generated JSON.
- Missing metadata after installation: inspect the packaged resources directory and the electron-builder `extraResources` input. The application must remain on manual GitHub Releases delivery for macOS until a valid artifact is rebuilt.
- macOS signing or notarization failure: confirm the Developer ID certificate scope, App Store Connect API key permissions, Hardened Runtime and entitlements. Use the notary log to diagnose rejection; never bypass `codesign`, `spctl`, or stapler verification.
- Windows signing failure: confirm the PFX/password pair, certificate validity and chain, SHA-256 signing, and RFC 3161 timestamp connectivity. A successful build log is not a substitute for SignTool verification of the final installer and installed executable.
- Startup smoke failure: keep publication blocked and inspect the platform verification report. Do not upload an artifact that passes signature checks but fails installation or launch.
- SmartScreen warning on a correctly signed artifact: verify the publisher and signature first, then treat the prompt as a reputation issue. Do not claim that changing from OV to EV will automatically remove the warning.

## Official references

- [Electron `process.resourcesPath`](https://www.electronjs.org/docs/latest/api/process#processresourcespath-readonly)
- [electron-builder application contents and `extraResources`](https://www.electron.build/docs/contents/)
- [electron-builder auto update](https://www.electron.build/docs/features/auto-update/)
- [Apple Developer ID](https://developer.apple.com/support/developer-id/)
- [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Microsoft SmartScreen reputation for app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
