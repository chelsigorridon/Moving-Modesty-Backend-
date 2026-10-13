$ErrorActionPreference = 'Stop'
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskPrevious = Join-Path $taskWorkspace '.tmp/checkout-autofill-release-20261012'
$taskArchive = Join-Path $taskWorkspace '.tmp/discounts-baseline-20261009.zip'
$taskBundle = Join-Path $taskWorkspace '.tmp/free-delivery-1200-release-20261012'
if (Test-Path -LiteralPath $taskBundle) { throw 'Release already exists. Inspect it; do not overwrite.' }
if (-not (Test-Path -LiteralPath $taskArchive -PathType Leaf)) { throw 'Verified production baseline is unavailable.' }
$taskManifestSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prepare-discounts-release.ps1') -Raw
$taskManifest = [regex]::Match($taskManifestSource, '(?s)\$taskOverlay = @\((.*?)\r?\n\)')
if (-not $taskManifest.Success) { throw 'Closed production manifest unavailable.' }
$taskPaths = [regex]::Matches($taskManifest.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }
$taskUpdated = @('lib/shipping/policy.ts', 'lib/discounts.ts', 'components/discount-manager.tsx', 'app/(admin)/delivery/page.tsx')
foreach ($taskDirectory in @('app', 'components', 'lib')) {
    foreach ($taskFile in Get-ChildItem -LiteralPath (Join-Path $taskPrevious $taskDirectory) -Recurse -File) {
        $taskRelative = [IO.Path]::GetRelativePath($taskPrevious, $taskFile.FullName).Replace('\', '/')
        if ($taskRelative -in $taskUpdated) { continue }
        $taskCurrentFile = Join-Path $taskWorkspace $taskRelative
        if (-not (Test-Path -LiteralPath $taskCurrentFile -PathType Leaf)) { throw "Missing production source: $taskRelative" }
        if ([IO.File]::ReadAllText($taskCurrentFile).Replace("`r`n", "`n") -ne [IO.File]::ReadAllText($taskFile.FullName).Replace("`r`n", "`n")) {
            throw "Unrelated production source changed: $taskRelative"
        }
    }
}
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBundle
foreach ($taskRelative in $taskPaths) {
    if ([IO.Path]::IsPathRooted($taskRelative) -or $taskRelative.Contains('..') -or $taskRelative -like '*.env*') { throw 'Invalid manifest path.' }
    $taskTarget = Join-Path $taskBundle $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskPrevious $taskRelative) -Destination $taskTarget
}
foreach ($taskRelative in $taskUpdated) {
    Copy-Item -LiteralPath (Join-Path $taskWorkspace $taskRelative) -Destination (Join-Path $taskBundle $taskRelative)
}
# Verification sources only. No environment files or customer data are copied.
foreach ($taskRelative in @('tests/shipping-policy.test.ts', 'tests/checkout-delivery-selection.test.ts', 'tests/discount-database.test.ts',
    'tests/checkout-input.test.ts', 'tests/checkout-database.test.ts', 'tests/framer-checkout-payment-action.test.ts', 'tests/framer-delivery-notice.test.ts',
    'framer/CheckoutSlider.tsx', 'framer/CheckoutOrderSummary.tsx', 'framer/DeliveryWelcome.tsx', 'framer/AdminPortal.tsx')) {
    $taskTarget = Join-Path $taskBundle $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskWorkspace $taskRelative) -Destination $taskTarget
}
New-Item -ItemType Directory -Path (Join-Path $taskBundle '.vercel') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskPrevious '.vercel/project.json') -Destination (Join-Path $taskBundle '.vercel/project.json')
Write-Output "Scoped delivery release prepared: $taskBundle"
Write-Output "Changed production backend files: $($taskUpdated -join ', ')"
