[CmdletBinding(SupportsShouldProcess = $true)]
param([Parameter(Mandatory = $true)][ValidateSet('ffmpeg', 'webview2')][string]$Component)

$ErrorActionPreference = 'Stop'
$arguments = switch ($Component) {
    'ffmpeg' { @('install', '-e', '--id', 'Gyan.FFmpeg') }
    'webview2' { @('install', '-e', '--id', 'Microsoft.EdgeWebView2Runtime', '--silent', '--accept-package-agreements', '--accept-source-agreements') }
}
if (-not $PSCmdlet.ShouldProcess($Component, ('winget ' + ($arguments -join ' ')))) { return }

# This file is the only installation entry point. No arbitrary commands,
# package identifiers or execution-policy changes are accepted from the UI.
$winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $winget) {
    Write-Host 'WinGet was not found. Install Microsoft App Installer, then retry.'
    Read-Host 'Press Enter to close'
    exit 127
}
try {
    & $winget.Source @arguments
    $installExitCode = $LASTEXITCODE
    if ($installExitCode -ne 0) { Read-Host 'Installation did not finish. Review the message above, then press Enter to close' }
    exit $installExitCode
} catch {
    Write-Host 'Installation could not start. Check WinGet and retry.'
    Read-Host 'Press Enter to close'
    exit 1
}
