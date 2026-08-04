param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$ApiKey = "",
  [string]$AllowedOrigin = "",
  [string]$BlockedOrigin = "https://blocked.example.com",
  [string]$WebhookSecret = "",
  [string]$InternalSecret = "",
  [int]$Attempts = 25
)

$ErrorActionPreference = "Stop"

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    $Body = $null
  )

  $requestParams = @{
    Method      = $Method
    Uri         = $Url
    Headers     = $Headers
    UseBasicParsing = $true
  }

  if ($null -ne $Body) {
    $requestParams["ContentType"] = "application/json"
    $requestParams["Body"] = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }

  try {
    $response = Invoke-WebRequest @requestParams
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Headers    = $response.Headers
      Body       = $response.Content
    }
  } catch {
    if (-not $_.Exception.Response) {
      throw
    }

    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $content = $reader.ReadToEnd()

    return [pscustomobject]@{
      StatusCode = [int]$_.Exception.Response.StatusCode
      Headers    = $_.Exception.Response.Headers
      Body       = $content
    }
  }
}

function Assert-RateLimited {
  param(
    [string]$Name,
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    $Body = $null
  )

  $lastStatus = 0
  for ($i = 1; $i -le $Attempts; $i++) {
    $response = Invoke-JsonRequest -Method $Method -Url $Url -Headers $Headers -Body $Body
    $lastStatus = $response.StatusCode
    if ($response.StatusCode -eq 429) {
      Write-Host "[PASS] $Name hit 429 on attempt $i"
      return
    }
  }

  throw "[FAIL] $Name did not hit 429 after $Attempts attempts. Last status: $lastStatus"
}

function Assert-CorsBehavior {
  param(
    [string]$Name,
    [string]$Url,
    [string]$Origin,
    [bool]$ShouldAllow,
    [hashtable]$Headers = @{}
  )

  $headers = @{}
  foreach ($entry in $Headers.GetEnumerator()) {
    $headers[$entry.Key] = $entry.Value
  }
  $headers["Origin"] = $Origin

  $response = Invoke-JsonRequest -Method "GET" -Url $Url -Headers $headers
  $allowOrigin = $response.Headers["Access-Control-Allow-Origin"]

  if ($ShouldAllow) {
    if ($response.StatusCode -ge 400 -or $allowOrigin -ne $Origin) {
      throw "[FAIL] $Name expected allowed CORS origin '$Origin' but got status $($response.StatusCode) and ACAO '$allowOrigin'"
    }
    Write-Host "[PASS] $Name allows origin $Origin"
    return
  }

  if ($response.StatusCode -eq 403 -or $allowOrigin -ne $Origin) {
    Write-Host "[PASS] $Name blocks origin $Origin"
    return
  }

  throw "[FAIL] $Name expected blocked CORS origin '$Origin' but got status $($response.StatusCode) and ACAO '$allowOrigin'"
}

function Assert-ReadyEndpoint {
  param(
    [string]$Url
  )

  $response = Invoke-JsonRequest -Method "GET" -Url $Url
  if ($response.StatusCode -ne 200) {
    throw "[FAIL] readiness endpoint expected HTTP 200 but got $($response.StatusCode)"
  }

  $body = $response.Body | ConvertFrom-Json
  if ($body.data.status -ne "ready") {
    throw "[FAIL] readiness endpoint expected data.status=ready but got '$($body.data.status)'"
  }

  Write-Host "[PASS] readiness endpoint returned ready"
}

$sharedApiHeaders = @{}
if ($ApiKey) {
  $sharedApiHeaders["X-API-KEY"] = $ApiKey
}

Assert-RateLimited `
  -Name "User login" `
  -Method "POST" `
  -Url "$BaseUrl/api/auth/login" `
  -Body @{ email = "nobody@example.com"; password = "wrong-password" }

Assert-RateLimited `
  -Name "Admin login" `
  -Method "POST" `
  -Url "$BaseUrl/api/admin/auth/login" `
  -Body @{ email = "admin@example.com"; password = "wrong-password" }

if ($ApiKey) {
  Assert-RateLimited `
    -Name "Markets read" `
    -Method "GET" `
    -Url "$BaseUrl/api/markets" `
    -Headers $sharedApiHeaders

  Assert-RateLimited `
    -Name "Wallet balance read" `
    -Method "GET" `
    -Url "$BaseUrl/api/wallet/balance/0x0000000000000000000000000000000000000000" `
    -Headers $sharedApiHeaders
}

if ($WebhookSecret) {
  Assert-RateLimited `
    -Name "Custody webhook" `
    -Method "POST" `
    -Url "$BaseUrl/api/webhooks/custody-ledger-topup" `
    -Headers @{ "X-Custody-Payment-Secret" = $WebhookSecret } `
    -Body @{
      userId = 1
      amountUsd = 1
      idempotencyKey = "verify-security-hardening"
    }
}

if ($InternalSecret) {
  Assert-RateLimited `
    -Name "Internal leader signal" `
    -Method "POST" `
    -Url "$BaseUrl/api/internal/copy-trade/leader-signal" `
    -Headers @{ "X-Internal-Secret" = $InternalSecret } `
    -Body @{
      leaderAddress = "0x0000000000000000000000000000000000000000"
      txHash = "0x1111111111111111111111111111111111111111111111111111111111111111"
      logIndex = 1
      side = "BUY"
      tokenId = "test-token"
      price = "0.5"
      amount = "1"
    }
}

if ($ApiKey -and $AllowedOrigin) {
  Assert-CorsBehavior `
    -Name "Allowed origin" `
    -Url "$BaseUrl/api/markets" `
    -Origin $AllowedOrigin `
    -ShouldAllow $true `
    -Headers $sharedApiHeaders
}

if ($ApiKey -and $BlockedOrigin) {
  Assert-CorsBehavior `
    -Name "Blocked origin" `
    -Url "$BaseUrl/api/markets" `
    -Origin $BlockedOrigin `
    -ShouldAllow $false `
    -Headers $sharedApiHeaders
}

Assert-ReadyEndpoint -Url "$BaseUrl/api/health/ready"

Write-Host "Security hardening verification finished."
