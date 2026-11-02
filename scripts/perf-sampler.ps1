# GPU 采样 v2：把主进程及其子进程的 GPU 引擎利用率加总（CIM 计数器，比 Get-Counter 快）。
param(
  [int]$Seconds = 20,
  [int]$IntervalSec = 2
)

$main = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*perf-run.cjs*' } |
  Select-Object -First 1
if (-not $main) { Write-Output 'NO-APP'; exit 1 }

$all = Get-CimInstance Win32_Process
$pids = New-Object System.Collections.Generic.HashSet[int]
[void]$pids.Add([int]$main.ProcessId)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($pids.Contains([int]$p.ParentProcessId) -and -not $pids.Contains([int]$p.ProcessId)) {
      [void]$pids.Add([int]$p.ProcessId)
      $changed = $true
    }
  }
}

Write-Output ("APP PID={0} descendants={1}" -f $main.ProcessId, ($pids.Count - 1))

$gpu = @()
$cpu = @()
$prevCpu = (Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue).CPU
$cores = [Environment]::ProcessorCount
$n = [math]::Floor($Seconds / $IntervalSec)

for ($i = 0; $i -lt $n; $i++) {
  Start-Sleep -Seconds $IntervalSec

  $sum = $null
  try {
    $rows = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop
    $hit = @()
    foreach ($r in $rows) {
      if ($r.Name -match 'pid_(\d+)_') {
        $pidVal = [int]$Matches[1]
        if ($pids.Contains($pidVal)) { $hit += [double]$r.UtilizationPercentage }
      }
    }
    if ($hit.Count -gt 0) { $sum = [math]::Round((($hit | Measure-Object -Sum).Sum), 2) } else { $sum = 0 }
  } catch {
    $sum = $null
  }

  $proc = Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
  $cpuPct = $null
  if ($proc -and $null -ne $proc.CPU -and $null -ne $prevCpu) {
    $cpuPct = [math]::Round((($proc.CPU - $prevCpu) / $IntervalSec / $cores) * 100, 2)
    $prevCpu = $proc.CPU
  }

  if ($null -ne $sum) { $gpu += $sum }
  if ($null -ne $cpuPct) { $cpu += $cpuPct }
  Write-Output ("t={0}s gpu={1}% cpu={2}%" -f (($i + 1) * $IntervalSec), $sum, $cpuPct)
}

$gpuAvg = if ($gpu.Count) { [math]::Round((($gpu | Measure-Object -Average).Average), 2) } else { $null }
$gpuMax = if ($gpu.Count) { [math]::Round((($gpu | Measure-Object -Maximum).Maximum), 2) } else { $null }
$cpuAvg = if ($cpu.Count) { [math]::Round((($cpu | Measure-Object -Average).Average), 2) } else { $null }

$result = [ordered]@{
  pid           = $main.ProcessId
  processTree   = $pids.Count
  seconds       = $Seconds
  gpuSamples    = $gpu.Count
  gpuAvgPercent = $gpuAvg
  gpuMaxPercent = $gpuMax
  cpuAvgPercent = $cpuAvg
  gpuAvailable  = ($gpu.Count -gt 0)
  note          = 'GPU 引擎利用率按进程树加总（含 GPU 子进程）'
  at            = (Get-Date).ToString('o')
}
$outDir = Join-Path $PSScriptRoot '..\perf'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$result | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $outDir 'gpu.json') -Encoding UTF8
Write-Output ("RESULT gpuAvg={0}% gpuMax={1}% cpuAvg={2}% samples={3}" -f $gpuAvg, $gpuMax, $cpuAvg, $gpu.Count)
