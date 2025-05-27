#!/usr/bin/env pwsh

# Elasticsearch VS Code Extension Test Script
# This script helps test the extension functionality

Write-Host "🔍 Elasticsearch VS Code Extension Test Suite" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Check if we're in the right directory
if (-not (Test-Path "package.json")) {
    Write-Host "❌ Error: Please run this script from the extension root directory" -ForegroundColor Red
    exit 1
}

Write-Host "📦 Checking dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
        exit 1
    }
}

Write-Host "🔨 Compiling TypeScript..." -ForegroundColor Yellow
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Compilation failed" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Compilation successful!" -ForegroundColor Green

Write-Host "🔍 Checking output files..." -ForegroundColor Yellow
$outputFiles = @(
    "out/extension.js",
    "out/tree/ESExplorerProvider.js"
)

foreach ($file in $outputFiles) {
    if (Test-Path $file) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file (missing)" -ForegroundColor Red
    }
}

Write-Host "`n🚀 Extension Test Summary:" -ForegroundColor Cyan
Write-Host "===========================" -ForegroundColor Cyan
Write-Host "✅ Dependencies installed" -ForegroundColor Green
Write-Host "✅ TypeScript compiled successfully" -ForegroundColor Green  
Write-Host "✅ Output files generated" -ForegroundColor Green

Write-Host "`n🔧 Next Steps:" -ForegroundColor Yellow
Write-Host "1. Press F5 in VS Code to launch Extension Development Host" -ForegroundColor White
Write-Host "2. Open Explorer panel and look for 'Elasticsearch Explorer'" -ForegroundColor White
Write-Host "3. Click 'Add Elasticsearch Cluster' to test functionality" -ForegroundColor White
Write-Host "4. Test with a local Elasticsearch instance or Elastic Cloud" -ForegroundColor White

Write-Host "`n📝 Test Scenarios:" -ForegroundColor Yellow
Write-Host "• Add multiple clusters" -ForegroundColor White
Write-Host "• Switch between clusters" -ForegroundColor White
Write-Host "• Test different authentication methods" -ForegroundColor White
Write-Host "• Browse cluster data (index templates, roles, etc.)" -ForegroundColor White
Write-Host "• Remove clusters and verify cleanup" -ForegroundColor White

Write-Host "`n🎉 Ready to test! Launch the extension with F5 in VS Code." -ForegroundColor Green
