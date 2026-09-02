# Optional Python 3.12 sidecar for beat-this / allin1.
# Never invoked by Node unless analysis.engines.python.enabled is true.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Py = Get-Command py -ErrorAction SilentlyContinue
if ($Py) {
  py -3.12 -m venv .venv
} else {
  python -m venv .venv
}

& "$Root\.venv\Scripts\python.exe" -m pip install --upgrade pip
& "$Root\.venv\Scripts\python.exe" -m pip install -r requirements.txt
Write-Host "Sidecar venv ready at $Root\.venv"
