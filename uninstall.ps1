# Rendobar CLI uninstaller for Windows
# Usage: irm https://rendobar.com/uninstall.ps1 | iex
# Env:
#   $env:RENDOBAR_INSTALL_DIR     override binary dir (default: $env:USERPROFILE\.rendobar\bin)
#   $env:RENDOBAR_CONFIG_DIR      override config dir (default: $env:USERPROFILE\.rendobar)
#   $env:RENDOBAR_PURGE = "1"     also remove config dir (auth tokens, cached keys)
#   $env:RENDOBAR_NO_MODIFY_PATH  if "1", skip user PATH cleanup (install never touched it)
$ErrorActionPreference = "Stop"

$InstallDir = if ($env:RENDOBAR_INSTALL_DIR) { $env:RENDOBAR_INSTALL_DIR } else { "$env:USERPROFILE\.rendobar\bin" }
$ConfigDir  = if ($env:RENDOBAR_CONFIG_DIR)  { $env:RENDOBAR_CONFIG_DIR }  else { "$env:USERPROFILE\.rendobar" }
$BinName    = "rb.exe"
$Purge      = $env:RENDOBAR_PURGE -eq "1"
$NoModifyPath = $env:RENDOBAR_NO_MODIFY_PATH -eq "1"

$removedAny = $false

# 1. Remove binary
$BinPath = Join-Path $InstallDir $BinName
if (Test-Path $BinPath) {
  try {
    Remove-Item -Path $BinPath -Force
    Write-Host "Removed $BinPath"
    $removedAny = $true
  } catch {
    Write-Warning "Failed to remove $BinPath -- close any running 'rb' process and retry. Error: $_"
  }
  # Remove bin dir if empty
  if ((Test-Path $InstallDir) -and -not (Get-ChildItem -Path $InstallDir -Force)) {
    Remove-Item -Path $InstallDir -Force
  }
} else {
  Write-Host "No binary at $BinPath (skipping)"
}

# 2. Remove from user PATH (registry + current session)
if ($NoModifyPath) {
  Write-Host "Skipping PATH cleanup (RENDOBAR_NO_MODIFY_PATH=1)."
} else {
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($UserPath -and ($UserPath -split ';') -contains $InstallDir) {
    $NewPath = (($UserPath -split ';') | Where-Object { $_ -ne $InstallDir -and $_ -ne '' }) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "Removed $InstallDir from user PATH."
    $removedAny = $true
  }
  # Also patch current session PATH so uninstall is immediate
  if (($env:Path -split ';') -contains $InstallDir) {
    $env:Path = (($env:Path -split ';') | Where-Object { $_ -ne $InstallDir -and $_ -ne '' }) -join ';'
  }
}

# 3. Config dir (auth tokens) -- opt-in via RENDOBAR_PURGE=1
if ($Purge) {
  if (Test-Path $ConfigDir) {
    Remove-Item -Path $ConfigDir -Recurse -Force
    Write-Host "Removed config dir $ConfigDir"
    $removedAny = $true
  }
} else {
  if (Test-Path $ConfigDir) {
    Write-Host ""
    Write-Host "Config dir kept: $ConfigDir"
    Write-Host "  (contains auth tokens and cached settings)"
    Write-Host "  To also remove it:"
    Write-Host "    `$env:RENDOBAR_PURGE='1'; irm https://rendobar.com/uninstall.ps1 | iex"
  }
}

Write-Host ""
if ($removedAny) {
  Write-Host "Rendobar CLI uninstalled."
  Write-Host "Revoke API keys at https://app.rendobar.com/settings/api-keys if needed."
} else {
  Write-Host "Nothing to uninstall -- no Rendobar CLI found."
}
