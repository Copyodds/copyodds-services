param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,
  [string]$AdminOrigin = "",
  [switch]$ExpectAdminBlocked,
  [string]$AdminLoginEmail = "nobody@example.com",
  [string]$AdminLoginPassword = "wrong-password"
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")

function Invoke-AdminRequest {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Headers = @{}
  )

  $uri = "$BaseUrl$Path"
  $params = @{
    Method          = $Method
    Uri             = $uri
    Headers         = $Headers
    UseBasicParsing = $true
  }

  try {
    $response = Invoke-WebRequest @params
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Body       = $response.Content
    }
  } catch {
    if (-not $_.Exception.Response) { throw }
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $content = $reader.ReadToEnd()
    return [pscustomobject]@{
      StatusCode = [int]$_.Exception.Response.StatusCode
      Body       = $content
    }
  }
}

function Assert-Status {
  param(
    [string]$Name,
    [int]$Actual,
    [int[]]$Expected
  )
  if ($Actual -notin $Expected) {
    throw "[FAIL] $Name expected [$($Expected -join ', ')] got $Actual"
  }
  Write-Host "[PASS] $Name => $Actual"
}

Write-Host "Admin IP whitelist verification"
Write-Host "  BaseUrl: $BaseUrl"
Write-Host "  ExpectAdminBlocked: $ExpectAdminBlocked"
Write-Host ""

$loginHeaders = @{ "Content-Type" = "application/json" }
if ($AdminOrigin) {
  $loginHeaders["Origin"] = $AdminOrigin
}

$loginBody = @{
  email    = $AdminLoginEmail
  password = $AdminLoginPassword
} | ConvertTo-Json -Compress

$loginUri = "$BaseUrl/api/admin/auth/login"
try {
  $loginResponse = Invoke-WebRequest -Method POST -Uri $loginUri -Headers $loginHeaders -Body $loginBody -UseBasicParsing
  $loginStatus = [int]$loginResponse.StatusCode
} catch {
  if (-not $_.Exception.Response) { throw }
  $loginStatus = [int]$_.Exception.Response.StatusCode
}

if ($ExpectAdminBlocked) {
  Assert-Status -Name "Admin login blocked by Nginx" -Actual $loginStatus -Expected @(403)
} else {
  # Wrong credentials: 401 from app means request passed Nginx whitelist
  Assert-Status -Name "Admin login reaches app (wrong creds => 401)" -Actual $loginStatus -Expected @(401)
}

$health = Invoke-AdminRequest -Method GET -Path "/api/health"
Assert-Status -Name "Public user API /api/health" -Actual $health.StatusCode -Expected @(200)

if (-not $ExpectAdminBlocked) {
  $me = Invoke-AdminRequest -Method GET -Path "/api/admin/auth/me"
  Assert-Status -Name "Admin /auth/me without session" -Actual $me.StatusCode -Expected @(401)
}

Write-Host ""
Write-Host "Admin IP whitelist verification finished."
