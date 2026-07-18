param(
  [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\release")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$reportPath = Join-Path $ReleaseDir "verification-windows.txt"
if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
  Remove-Item -LiteralPath $reportPath -Force
}

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJson = Get-Content (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json
$installer = Join-Path $ReleaseDir "PlanWeave-$($packageJson.version)-win-x64.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Missing Windows release installer: $installer"
}

$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object FullName |
  Select-Object -Last 1
if ($null -eq $signTool) {
  throw "SignTool was not found in the Windows SDK."
}

$tempRoot = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($tempRoot)) {
  throw "RUNNER_TEMP is required for isolated Windows release installation."
}
$installDir = Join-Path $tempRoot "planweave-release-$([Guid]::NewGuid().ToString('N'))"
if ($installDir -match '\s') {
  throw "The isolated install path must not contain whitespace because NSIS /D cannot be quoted."
}
$installedExe = Join-Path $installDir "PlanWeave.exe"
$uninstaller = Join-Path $installDir "Uninstall PlanWeave.exe"
$report = [System.Collections.Generic.List[string]]::new()

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $output = & $FilePath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $report.Add("$ $FilePath $($Arguments -join ' ')")
  $report.Add(($output | Out-String).Trim())
  if ($exitCode -ne 0) {
    throw "$FilePath failed with exit code $exitCode."
  }
}

function Assert-ValidAuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)][string]$ArtifactPath
  )

  Invoke-CheckedNative -FilePath $signTool.FullName -Arguments @(
    "verify", "/pa", "/all", "/v", "/tw", $ArtifactPath
  )
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
  $report.Add("$Description exited with code $($process.ExitCode).")
  if ($process.ExitCode -ne 0) {
    throw "$Description failed with exit code $($process.ExitCode)."
  }
}

$verificationFailure = $null
$cleanupErrors = [System.Collections.Generic.List[object]]::new()
$uninstallerVerified = $false
try {
  Assert-ValidAuthenticodeSignature -ArtifactPath $installer
  Invoke-CheckedProcess -FilePath $installer -Arguments @("/S", "/D=$installDir") `
    -Description "NSIS silent install"
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    throw "Installed application executable was not found: $installedExe"
  }
  Assert-ValidAuthenticodeSignature -ArtifactPath $installedExe
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Missing Windows release uninstaller: $uninstaller"
  }
  Assert-ValidAuthenticodeSignature -ArtifactPath $uninstaller
  $uninstallerVerified = $true

  $previousPlatform = $env:PLANWEAVE_PACKAGED_PLATFORM
  $previousAppPath = $env:PLANWEAVE_PACKAGED_APP_PATH
  try {
    $env:PLANWEAVE_PACKAGED_PLATFORM = "win32"
    $env:PLANWEAVE_PACKAGED_APP_PATH = $installDir
    Invoke-CheckedNative -FilePath "node" -Arguments @(
      (Join-Path $PSScriptRoot "verify-packaged-app.mjs")
    )
  } finally {
    $env:PLANWEAVE_PACKAGED_PLATFORM = $previousPlatform
    $env:PLANWEAVE_PACKAGED_APP_PATH = $previousAppPath
  }
} catch {
  $verificationFailure = $_
} finally {
  if ($uninstallerVerified -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try {
      Invoke-CheckedProcess -FilePath $uninstaller -Arguments @("/S", "_?=$installDir") `
        -Description "NSIS silent uninstall"
    } catch {
      $cleanupErrors.Add($_)
    }
  }
  if (Test-Path -LiteralPath $installDir) {
    try {
      Remove-Item -LiteralPath $installDir -Recurse -Force
    } catch {
      $cleanupErrors.Add($_)
    }
  }
}

if ($null -ne $verificationFailure) {
  if ($cleanupErrors.Count -gt 0) {
    throw "Windows release verification failed: $($verificationFailure.Exception.Message) Cleanup also failed: $($cleanupErrors[0])"
  }
  throw $verificationFailure
}
if ($cleanupErrors.Count -gt 0) {
  throw "Windows release verification cleanup failed: $($cleanupErrors[0])"
}

$report.Add("Windows release verification passed.")
$report | Set-Content $reportPath -Encoding utf8
