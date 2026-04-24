# Rendobar CLI installer for Windows
# Usage: irm https://rendobar.com/install.ps1 | iex
# Env:
#   $env:RENDOBAR_INSTALL_DIR     override binary dir (default: $env:USERPROFILE\.rendobar\bin)
#   $env:RENDOBAR_VERSION         pin a specific tag (e.g. "v1.0.0"); default = latest stable
#   $env:RENDOBAR_GITHUB_TOKEN    optional GH token to lift the 60/hr unauth rate limit
#                                 (falls back to $env:GITHUB_TOKEN for CI environments)
#   $env:RENDOBAR_NO_MODIFY_PATH  if "1", install binary but do not touch user PATH
$ErrorActionPreference = "Stop"

# Pin TLS 1.2 — Windows PowerShell 5.1 on Server 2019 / older Win10 images
# defaults to TLS 1.0/1.1 which GitHub no longer accepts. Without this, the
# API and release downloads 500 out with an obscure "underlying connection closed" error.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # PS 7+ handles TLS automatically; the assignment may fail harmlessly there.
}

$Repo = "rendobar/cli"
$InstallDir = if ($env:RENDOBAR_INSTALL_DIR) { $env:RENDOBAR_INSTALL_DIR } else { "$env:USERPROFILE\.rendobar\bin" }
$BinName = "rb.exe"
$PinnedVersion = $env:RENDOBAR_VERSION
$GhToken = if ($env:RENDOBAR_GITHUB_TOKEN) { $env:RENDOBAR_GITHUB_TOKEN } else { $env:GITHUB_TOKEN }
$NoModifyPath = $env:RENDOBAR_NO_MODIFY_PATH -eq "1"

# Detect arch
if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Error "Rendobar requires 64-bit Windows"
  exit 1
}
$Arch = "x64"

$Asset = "rb-windows-$Arch"
$Archive = "$Asset.zip"

# Resolve release tag
if ($PinnedVersion) {
  $LatestTag = if ($PinnedVersion -like 'v*') { $PinnedVersion } else { "v$PinnedVersion" }
  Write-Host "Using pinned version: $LatestTag"
} else {
  Write-Host "Fetching latest CLI release tag..."
  $Headers = @{ "Accept" = "application/vnd.github+json" }
  if ($GhToken) { $Headers["Authorization"] = "Bearer $GhToken" }
  try {
    $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers $Headers
  } catch {
    Write-Error "Failed to fetch releases from GitHub: $_"
    exit 1
  }

  $CliRelease = $Releases | Where-Object { $_.tag_name -like 'v*' -and -not $_.prerelease -and -not $_.draft } | Select-Object -First 1
  if (-not $CliRelease) {
    Write-Error "No stable CLI release found (looking for v*). If no releases exist yet, install.ps1 cannot proceed."
    exit 1
  }
  $LatestTag = $CliRelease.tag_name
  Write-Host "Latest: $LatestTag"
}

$Version = $LatestTag -replace '^v', ''

$Tmp = New-Item -ItemType Directory -Path "$env:TEMP\rendobar-install-$(Get-Random)"
try {
  $ArchiveUrl = "https://github.com/$Repo/releases/download/$LatestTag/$Archive"
  $ChecksumsUrl = "https://github.com/$Repo/releases/download/$LatestTag/checksums.txt"

  Write-Host "Downloading $Archive..."
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile "$Tmp\$Archive" -UseBasicParsing

  Write-Host "Downloading checksums.txt..."
  Invoke-WebRequest -Uri $ChecksumsUrl -OutFile "$Tmp\checksums.txt" -UseBasicParsing

  Write-Host "Verifying checksum..."
  $ChecksumsContent = Get-Content "$Tmp\checksums.txt"
  $ExpectedLine = $ChecksumsContent | Where-Object { $_ -match [regex]::Escape($Archive) }
  if (-not $ExpectedLine) {
    Write-Error "No checksum found for $Archive"
    exit 1
  }
  $Expected = ($ExpectedLine -split "\s+")[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 "$Tmp\$Archive").Hash.ToLower()
  if ($Expected -ne $Actual) {
    Write-Error "Checksum mismatch: expected $Expected, got $Actual"
    exit 1
  }
  Write-Host "Checksum verified."

  Write-Host "Extracting..."
  Expand-Archive -Path "$Tmp\$Archive" -DestinationPath $Tmp -Force

  if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }

  # Move binary into place. If an earlier 'rb.exe' is currently running,
  # Move-Item fails with "Access to the path is denied" / "The process
  # cannot access the file because it is being used by another process".
  # Catch any failure here and emit a single actionable line instead of
  # a multi-screen .NET stack trace. Typed catch lists (`catch [T1], [T2]`)
  # tickle a parser bug in Windows PowerShell 5.1 when the catch body
  # contains a here-string, so we use a bare catch.
  try {
    Move-Item -Path "$Tmp\$BinName" -Destination "$InstallDir\$BinName" -Force
  } catch {
    Write-Host ""
    Write-Host "ERROR: Could not write $InstallDir\$BinName." -ForegroundColor Red
    Write-Host "This usually means an 'rb' process is still running."
    Write-Host "Close any terminal or process using rb, then re-run the installer:"
    Write-Host "    irm https://rendobar.com/install.ps1 | iex"
    Write-Host ""
    Write-Host "(Underlying error: $($_.Exception.Message))"
    exit 1
  }

  Write-Host ""
  Write-Host "Installed rb $Version to $InstallDir\$BinName"
  Write-Host ""

  if ($NoModifyPath) {
    Write-Host "Skipping PATH modification (RENDOBAR_NO_MODIFY_PATH=1)."
    Write-Host "Add this directory to PATH manually: $InstallDir"
  } else {
    # Add to user PATH (persisted) if not already.
    # Split on ';' and compare exact segments — substring match (-like "*$x*")
    # would false-positive on directories that contain InstallDir as a prefix.
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $UserPathEntries = if ([string]::IsNullOrEmpty($UserPath)) { @() } else { $UserPath -split ';' | Where-Object { $_ -ne '' } }
    if ($UserPathEntries -notcontains $InstallDir) {
      $NewUserPath = (@($UserPathEntries) + $InstallDir) -join ';'
      [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
      Write-Host "Added $InstallDir to user PATH."
    } else {
      Write-Host "PATH already contains $InstallDir."
    }

    # Update current session PATH so 'rb' works without reopening terminal.
    # SetEnvironmentVariable only updates the registry; $env:Path in the live
    # process is a separate snapshot that must be patched explicitly.
    if (($env:Path -split ';') -notcontains $InstallDir) {
      $env:Path = "$env:Path;$InstallDir"
    }
    Write-Host "Ready to use — try 'rb --version' in this terminal."
  }

  Write-Host ""
  Write-Host "Note: Windows SmartScreen may prompt the first time you run rb.exe."
  Write-Host "Click 'More info' then 'Run anyway' to allow. The binary is verified"
  Write-Host "via SHA256 (above) so integrity is guaranteed even without code signing."
  Write-Host ""
  Write-Host "Next: run 'rb login' to authenticate, then 'rb --help' to see commands."

} finally {
  Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
