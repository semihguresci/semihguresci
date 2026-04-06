param(
  [int]$Port = 4000
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Serving $root at http://127.0.0.1:$Port"
python -m http.server $Port --bind 127.0.0.1
