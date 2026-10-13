$ErrorActionPreference = 'Stop'
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskPrevious = Join-Path $taskWorkspace '.tmp/cms-consolidation-release-20261012'
$taskArchive = Join-Path $taskWorkspace '.tmp/discounts-baseline-20261009.zip'
$taskBundle = Join-Path $taskWorkspace '.tmp/checkout-autofill-release-20261012'
if (Test-Path -LiteralPath $taskBundle) { throw 'Release already exists. Inspect it; do not overwrite.' }
if (-not (Test-Path -LiteralPath $taskArchive -PathType Leaf)) { throw 'Verified production baseline is unavailable.' }

# Closed production manifest: never deploy the unrelated dirty workspace.
$taskManifestSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prepare-discounts-release.ps1') -Raw
$taskManifest = [regex]::Match($taskManifestSource, '(?s)\$taskOverlay = @\((.*?)\r?\n\)')
if (-not $taskManifest.Success) { throw 'Could not read the closed production manifest.' }
$taskPaths = [regex]::Matches($taskManifest.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }
$taskUpdated = @('lib/checkout-input.ts')
foreach ($taskDirectory in @('app', 'components', 'lib')) {
    foreach ($taskFile in Get-ChildItem -LiteralPath (Join-Path $taskPrevious $taskDirectory) -Recurse -File) {
        $taskRelative = [IO.Path]::GetRelativePath($taskPrevious, $taskFile.FullName).Replace('\', '/')
        if ($taskRelative -in $taskUpdated) { continue }
        $taskPreviousFile = Join-Path $taskPrevious $taskRelative
        $taskCurrentFile = Join-Path $taskWorkspace $taskRelative
        if (-not (Test-Path -LiteralPath $taskCurrentFile -PathType Leaf)) { throw "Production source is missing: $taskRelative" }
        $taskCurrentText = [IO.File]::ReadAllText($taskCurrentFile).Replace("`r`n", "`n")
        $taskPreviousText = [IO.File]::ReadAllText($taskPreviousFile).Replace("`r`n", "`n")
        if ($taskCurrentText -ne $taskPreviousText) { throw "Unrelated source changed: $taskRelative" }
    }
}
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBundle
foreach ($taskRelative in $taskPaths) {
    if ([IO.Path]::IsPathRooted($taskRelative) -or $taskRelative.Contains('..') -or $taskRelative -like '*.env*') { throw 'Invalid manifest path.' }
    $taskSource = Join-Path $taskPrevious $taskRelative
    if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) { throw "Missing production source: $taskRelative" }
    $taskTarget = Join-Path $taskBundle $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath $taskSource -Destination $taskTarget
}
foreach ($taskRelative in $taskUpdated) {
    Copy-Item -LiteralPath (Join-Path $taskWorkspace $taskRelative) -Destination (Join-Path $taskBundle $taskRelative)
}
# Verification fixtures only; no live credentials, .env files or customer data.
foreach ($taskRelative in @('tests/checkout-input.test.ts', 'tests/checkout-database.test.ts', 'tests/checkout-delivery-selection.test.ts', 'tests/framer-checkout-payment-action.test.ts', 'framer/CheckoutSlider.tsx')) {
    $taskTarget = Join-Path $taskBundle $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskWorkspace $taskRelative) -Destination $taskTarget
}
New-Item -ItemType Directory -Path (Join-Path $taskBundle '.vercel') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskPrevious '.vercel/project.json') -Destination (Join-Path $taskBundle '.vercel/project.json')
Write-Output "Scoped checkout release prepared: $taskBundle"
Write-Output "Only changed production backend file: $($taskUpdated -join ', ')"
