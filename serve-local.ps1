param(
  [int]$Port = 4000,
  [switch]$BuildOnly
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$previewDir = Join-Path $root ".preview"
$pythonExe = (Get-Command python -ErrorAction Stop).Source

Set-Location $root

if (-not $BuildOnly) {
  $existingPreviewServers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq "python.exe" -and
      $_.CommandLine -match "http\.server" -and
      $_.CommandLine -match "(^|\s)$Port(\s|$)"
    }

  foreach ($server in $existingPreviewServers) {
    Write-Host "Stopping existing preview server on port $Port (PID $($server.ProcessId))"
    Stop-Process -Id $server.ProcessId -Force
  }

  if ($existingPreviewServers) {
    Start-Sleep -Milliseconds 500
  }

  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    Write-Error "Port $Port is already in use by PID $($listener.OwningProcess)."
    exit 1
  }
}

Write-Host "Building preview into $previewDir"
& $pythonExe -B (Join-Path $root "tools\preview_site.py") --source $root --output $previewDir

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($BuildOnly) {
  Write-Host "Preview files generated at $previewDir"
  exit 0
}

Write-Host "Serving $previewDir at http://127.0.0.1:$Port"
& $pythonExe -m http.server $Port --bind 127.0.0.1 --directory $previewDir
