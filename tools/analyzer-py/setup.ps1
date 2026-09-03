# Optional Python 3.12 sidecar for beat-this / allin1.
# Torch wheels need 3.12 (py -0 often shows 3.14, which is unsupported).
# Never invoked by Node unless analysis.engines.python.enabled is true.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Py = Get-Command py -ErrorAction SilentlyContinue
if (-not $Py) {
  Write-Error "Python launcher 'py' is required. Install Python 3.12 and retry."
}
$PyList = py -0p 2>&1 | Out-String
if ($PyList -notmatch "3\.12") {
  Write-Error "Python 3.12 is required for CPU torch / beat-this. Installed interpreters:`n$PyList"
}

py -3.12 -m venv .venv
& "$Root\.venv\Scripts\python.exe" -m pip install --upgrade pip
& "$Root\.venv\Scripts\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
& "$Root\.venv\Scripts\python.exe" -m pip install -r requirements.txt
Write-Host "Sidecar venv ready at $Root\.venv (Python 3.12 + CPU torch)"
