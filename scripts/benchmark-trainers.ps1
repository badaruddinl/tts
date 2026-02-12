param(
  [int]$Runs = 5,
  [string]$FeedbackFile = "data/training/splits/ml/train.ndjson",
  [string]$OutDir = "outputs/bench_trainers_seq"
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$PathValue) {
  if (-not (Test-Path $PathValue)) {
    New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
  }
}

function Measure-Mode([scriptblock]$Action, [int]$N) {
  $times = @()
  for ($i = 1; $i -le $N; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $Action $i
    $sw.Stop()
    $times += $sw.Elapsed.TotalMilliseconds
  }
  $avg = ($times | Measure-Object -Average).Average
  $min = ($times | Measure-Object -Minimum).Minimum
  $max = ($times | Measure-Object -Maximum).Maximum
  return @{
    avgMs = [Math]::Round($avg, 3)
    minMs = [Math]::Round($min, 3)
    maxMs = [Math]::Round($max, 3)
  }
}

function Detect-Python {
  try {
    python --version | Out-Null
    return "python"
  } catch {
    try {
      py --version | Out-Null
      return "py"
    } catch {
      return $null
    }
  }
}

function Invoke-Service-Benchmark([string]$Lang, [int]$N, [string]$Feedback, [string]$OutBase, [string]$PythonCmd) {
  if ($Lang -eq "js") {
    $out = & node scripts/bench-service-client.mjs --mode js --runs $N --feedback-file $Feedback --outdir $OutBase
    return $out | ConvertFrom-Json
  }
  if (-not $PythonCmd) { throw "python_not_found" }
  $out2 = & node scripts/bench-service-client.mjs --mode py --runs $N --feedback-file $Feedback --outdir $OutBase --py-cmd $PythonCmd
  return $out2 | ConvertFrom-Json
}

$absOut = Resolve-Path -Path "." | ForEach-Object { Join-Path $_ $OutDir }
Ensure-Dir $absOut

$feedbackAbs = Resolve-Path $FeedbackFile
$feedbackNorm = [IO.Path]::GetFullPath($feedbackAbs)
$pyCmd = Detect-Python

$results = @()

$jsSpawn = Measure-Mode {
  param($i)
  node scripts/train-ml-policy.mjs --feedback-file $feedbackNorm --output-model "$absOut/js_spawn_$i.json" | Out-Null
} $Runs
$results += [pscustomobject]@{ mode = "js_spawn"; ok = $true; avgMs = $jsSpawn.avgMs; minMs = $jsSpawn.minMs; maxMs = $jsSpawn.maxMs; error = $null }

if ($pyCmd) {
  $pySpawn = Measure-Mode {
    param($i)
    & $pyCmd scripts_py/train_ml_policy.py --feedback-file $feedbackNorm --output-model "$absOut/py_spawn_$i.json" | Out-Null
  } $Runs
  $results += [pscustomobject]@{ mode = "py_spawn"; ok = $true; avgMs = $pySpawn.avgMs; minMs = $pySpawn.minMs; maxMs = $pySpawn.maxMs; error = $null }
} else {
  $results += [pscustomobject]@{ mode = "py_spawn"; ok = $false; avgMs = $null; minMs = $null; maxMs = $null; error = "python_not_found" }
}

$jsService = Invoke-Service-Benchmark -Lang "js" -N $Runs -Feedback $feedbackNorm -OutBase $absOut -PythonCmd $pyCmd
$results += [pscustomobject]@{
  mode = "js_service"
  ok = $true
  avgMs = [Math]::Round([double]$jsService.avgMs, 3)
  minMs = [Math]::Round([double]$jsService.minMs, 3)
  maxMs = [Math]::Round([double]$jsService.maxMs, 3)
  error = $null
}

if ($pyCmd) {
  try {
    $pyService = Invoke-Service-Benchmark -Lang "py" -N $Runs -Feedback $feedbackNorm -OutBase $absOut -PythonCmd $pyCmd
    $results += [pscustomobject]@{
      mode = "py_service"
      ok = $true
      avgMs = [Math]::Round([double]$pyService.avgMs, 3)
      minMs = [Math]::Round([double]$pyService.minMs, 3)
      maxMs = [Math]::Round([double]$pyService.maxMs, 3)
      error = $null
    }
  } catch {
    $results += [pscustomobject]@{ mode = "py_service"; ok = $false; avgMs = $null; minMs = $null; maxMs = $null; error = $_.Exception.Message }
  }
} else {
  $results += [pscustomobject]@{ mode = "py_service"; ok = $false; avgMs = $null; minMs = $null; maxMs = $null; error = "python_not_found" }
}

$payload = [pscustomobject]@{
  generatedAt = (Get-Date).ToString("o")
  runs = $Runs
  feedbackFile = $feedbackNorm.Replace((Resolve-Path ".").Path + "\", "").Replace("\", "/")
  results = $results
}

$reportJson = Join-Path $absOut "report.json"
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $reportJson -Encoding UTF8

$md = @()
$md += "# Trainer Benchmark (Sequential)"
$md += ""
$md += "- generatedAt: $($payload.generatedAt)"
$md += "- runs: $Runs"
$md += "- feedbackFile: $($payload.feedbackFile)"
$md += ""
$md += "| mode | avgMs | minMs | maxMs |"
$md += "|---|---:|---:|---:|"
foreach ($r in $results) {
  if ($r.ok) {
    $md += "| $($r.mode) | $($r.avgMs) | $($r.minMs) | $($r.maxMs) |"
  } else {
    $md += "| $($r.mode) | fail | fail | fail |"
    $md += ""
    $md += "Error $($r.mode): $($r.error)"
  }
}
$reportMd = Join-Path $absOut "report.md"
$md -join "`n" | Set-Content -Path $reportMd -Encoding UTF8

Write-Output "benchmark_seq_done report=$reportJson"
foreach ($r in $results) {
  if ($r.ok) {
    Write-Output "mode=$($r.mode) avgMs=$($r.avgMs) minMs=$($r.minMs) maxMs=$($r.maxMs)"
  } else {
    Write-Output "mode=$($r.mode) failed error=$($r.error)"
  }
}
