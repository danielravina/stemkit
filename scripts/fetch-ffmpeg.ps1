$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "extras\ffmpeg-win"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$existing = Join-Path $out "ffmpeg.exe"
if (Test-Path $existing) {
    $buildconf = (& $existing -hide_banner -buildconf 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0 -and $buildconf -match '--enable-libsoxr') {
        Write-Host "ffmpeg with libsoxr already present: $existing"
        & $existing -version | Select-Object -First 1
        exit 0
    }

    Write-Host "existing ffmpeg lacks libsoxr support; replacing it..."
    Remove-Item -Force $existing
}

$zip = Join-Path $env:TEMP "ffmpeg-btbn.zip"
$tmpExtract = Join-Path $env:TEMP "ffmpeg-extract"

Write-Host "downloading static ffmpeg with libsoxr for Windows x64..."
Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip" -OutFile $zip

if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
Expand-Archive -Path $zip -DestinationPath $tmpExtract -Force

$exe = Get-ChildItem $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $exe) { throw "ffmpeg.exe not found inside archive" }

Copy-Item $exe.FullName $existing -Force
Remove-Item -Recurse -Force $tmpExtract
Remove-Item -Force $zip

$buildconf = (& $existing -hide_banner -buildconf 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $buildconf -notmatch '--enable-libsoxr') {
    Remove-Item -Force $existing
    throw "downloaded ffmpeg does not include libsoxr support"
}

& $existing -version | Select-Object -First 1
Write-Host "saved to $existing"
