# bump-version.ps1
# PowerShell script to bump the patch version in package.json

$packageFile = "package.json"

if (!(Test-Path $packageFile)) {
    Write-Host "package.json not found!" -ForegroundColor Red
    exit 1
}

# Read and parse package.json
$package = Get-Content $packageFile | Out-String | ConvertFrom-Json

# Split version and bump patch
$versionParts = $package.version -split '\.'
if ($versionParts.Length -ne 3) {
    Write-Host "Version format not recognized: $($package.version)" -ForegroundColor Red
    exit 1
}
$versionParts[2] = [string]([int]$versionParts[2] + 1)
$package.version = $versionParts -join '.'

# Write back to package.json
$package | ConvertTo-Json -Depth 10 | Set-Content $packageFile -Encoding UTF8

Write-Host "Version bumped to $($package.version) in package.json." -ForegroundColor Green
