# Test script for Elasticsearch Extension functionality
Write-Host "Testing Elasticsearch Extension..." -ForegroundColor Green

# Check if TypeScript compilation was successful
if (Test-Path "out/extension.js") {
    Write-Host "✓ Extension compiled successfully" -ForegroundColor Green
} else {
    Write-Host "✗ Extension compilation failed" -ForegroundColor Red
    exit 1
}

# Check if all necessary files exist
$requiredFiles = @(
    "out/extension.js",
    "out/tree/ESExplorerProvider.js",
    "package.json",
    "resources/es_icon.png",
    "resources/es_icon.svg"
)

foreach ($file in $requiredFiles) {
    if (Test-Path $file) {
        Write-Host "✓ $file exists" -ForegroundColor Green
    } else {
        Write-Host "✗ $file missing" -ForegroundColor Red
    }
}

Write-Host "`nExtension structure check complete!" -ForegroundColor Cyan

# Launch extension development host
Write-Host "`nLaunching extension development host..." -ForegroundColor Yellow
code --extensionDevelopmentHost=. --disable-extensions
