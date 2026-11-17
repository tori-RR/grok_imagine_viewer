$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend-go"
$binDir = Join-Path $backendDir "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Push-Location $backendDir
try {
    go test -count=1 ./...
    if ($LASTEXITCODE -ne 0) { throw "Go tests failed; no sidecar was built." }
    go vet ./...
    if ($LASTEXITCODE -ne 0) { throw "Go vet failed; no sidecar was built." }
    go build -trimpath -ldflags="-s -w" -o (Join-Path $binDir "giv-backend.exe") .
    if ($LASTEXITCODE -ne 0) { throw "Go sidecar build failed." }
} finally {
    Pop-Location
}
Write-Host "Built Go sidecar: $(Join-Path $binDir 'giv-backend.exe')"
