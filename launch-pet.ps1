param(
  [string]$Executable = "",
  [int]$ReadyTimeoutMs = 5000
)

# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI, so non-ASCII comments turn into mojibake and break the parser. Chinese
# text belongs in data files, not here. (See the project tech-pitfall list #11.)

$ErrorActionPreference = "Stop"

function Get-DshHome {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) {
    return [IO.Path]::GetFullPath($env:DSH_HOME)
  }
  return Join-Path $HOME ".dsh"
}

function Read-JsonObject([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $value -or $value -isnot [pscustomobject]) { return $null }
    return $value
  } catch {
    return $null
  }
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temporary = "$Path.tmp-$PID"
  $json = $Value | ConvertTo-Json -Depth 32
  [IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Resolve-PetExecutable([string]$Requested) {
  if ($Requested -and (Test-Path -LiteralPath $Requested -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $Requested).Path
  }
  # launcher.js resolves the entry point and passes it through this variable.
  # An explicit parameter and DSH_PET_EXE still take precedence.
  $fromLauncher = $env:DSH_PET_LAUNCHER
  if ($fromLauncher -and (Test-Path -LiteralPath $fromLauncher -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $fromLauncher).Path
  }
  $configured = $env:DSH_PET_EXE
  if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $configured).Path
  }
  $directory = "D:\DSH\dsh-pet"
  $candidate = Get-ChildItem -LiteralPath $directory -File -Filter "dsh-pet-standalone-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) {
    throw "No dsh-pet standalone executable found in $directory"
  }
  return $candidate.FullName
}

function Test-SourceEntry([string]$Path) {
  return ([IO.Path]::GetExtension($Path) -ieq ".py")
}

function Resolve-PetPython {
  # Source mode interpreter: explicit config first, then the venv next to the source tree.
  #
  # BUT a console-subsystem python.exe leaves a console window titled with the interpreter
  # path on screen for the pet's whole lifetime, so this ALWAYS swaps it for pythonw.exe
  # in the same directory: same interpreter, no console. A mis-set config therefore can
  # no longer bring a console window back.
  $candidates = @()
  $configured = $env:DSH_PET_PYTHON
  if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) {
    $candidates += $configured
  }
  # 安装脚本写下的解释器指针（源码版分发：install.ps1 建好 venv 后记录在这里）。
  # 必须用 Get-DshHome() 而不是写死 %USERPROFILE%\.dsh：用户把家目录迁到别处
  # （例如设了 DSH_HOME=D:\DSH\home）时，写死路径会读不到指针、桌宠起不来。
  # 两处都试：DSH_HOME 指向的家目录 + 传统 ~\.dsh（安装脚本会同时写两边）。
  $pointerPaths = @((Join-Path (Get-DshHome) "dsh-pet-python.txt"),
                    (Join-Path $HOME ".dsh\dsh-pet-python.txt")) | Select-Object -Unique
  foreach ($pythonPointer in $pointerPaths) {
    if (-not (Test-Path -LiteralPath $pythonPointer -PathType Leaf)) { continue }
    $recorded = (Get-Content -LiteralPath $pythonPointer -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($recorded) { $candidates += $recorded.Trim() }
  }
  # 发行包内自带的虚拟环境（布局：installer\ 与 python\ 同级）
  $root = Split-Path -Parent $PSScriptRoot
  foreach ($venvName in @("python", "venv", ".venv")) {
    foreach ($exeName in @("pythonw.exe", "python.exe")) {
      $candidate = Join-Path $root "$venvName\Scripts\$exeName"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates += $candidate }
    }
  }
  # 系统 PATH 里的 Python（用户自己装的那份）。
  # ⚠️ 只认 pythonw.exe：Windows 的 Microsoft Store 会给 python.exe / python3.exe
  # 放一个"假解释器"占位程序（运行只提示去商店安装），它没有同目录的 pythonw.exe，
  # 用它当解释器会直接失败。优先 pythonw 天然避开这个坑。
  foreach ($exeName in @("pythonw.exe", "python.exe")) {
    $found = Get-Command $exeName -ErrorAction SilentlyContinue
    if (-not $found) { continue }
    if (-not (Test-Path -LiteralPath $found.Source -PathType Leaf)) { continue }
    # 校验它真的是 Python（Store 占位程序不带 pythonw.exe，且 --version 会失败）
    $probe = & $found.Source --version 2>&1 | Out-String
    if ($probe -notmatch 'Python\s+3') { continue }
    $candidates += $found.Source
  }

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if ([IO.Path]::GetFileName($resolved) -ieq "python.exe") {
      $windowed = Join-Path (Split-Path -Parent $resolved) "pythonw.exe"
      if (Test-Path -LiteralPath $windowed -PathType Leaf) {
        return (Resolve-Path -LiteralPath $windowed).Path
      }
    }
    return $resolved
  }
  # 面向用户的报错：直接给出可照做的命令，而不是一句"set DSH_PET_PYTHON"
  $hint = @(
    "找不到可用的 Python 解释器（源码版桌宠需要它）。任选一种方式：",
    "  A. 在发行包根目录建虚拟环境并装依赖：",
    "       python -m venv python",
    "       .\python\Scripts\python.exe -m pip install -r pet\requirements.txt",
    "  B. 用系统 Python 安装依赖（需 python 在 PATH 中）：",
    "       python -m pip install -r pet\requirements.txt",
    "  C. 直接指定解释器路径：",
    '       $env:DSH_PET_PYTHON = "C:\path\to\pythonw.exe"'
  ) -join [Environment]::NewLine
  throw $hint
}

function Get-PetConfigDirectoryName([string]$Executable) {
  # Packaged build: config dir name = exe name (dsh-pet-standalone-webm-chat).
  # Source build: the name comes from build_variant.VARIANT, which is webm-chat too.
  # Both therefore share one config.json, so switching builds never forks
  # settings or saved sessions.
  if (Test-SourceEntry $Executable) {
    return "dsh-pet-standalone-webm-chat"
  }
  return [IO.Path]::GetFileNameWithoutExtension($Executable)
}

function Force-PetConfigFlags([string]$Executable) {
  # Requirement: the pet must never appear in the tray/overflow area. The packaged
  # launcher.js forces show_dock_icon=false; do the same for both modes, rewritten
  # before every launch (idempotent).
  try {
    $configPath = Join-Path $env:APPDATA "$(Get-PetConfigDirectoryName $Executable)\config.json"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return }
    $config = Read-JsonObject $configPath
    if ($null -eq $config) { return }
    $current = $null
    if ($null -ne $config.PSObject.Properties["show_dock_icon"]) {
      $current = $config.show_dock_icon
    }
    if ($current -eq $false) { return }
    $config | Add-Member -NotePropertyName show_dock_icon -NotePropertyValue $false -Force
    Write-JsonAtomic $configPath $config
  } catch {}
}

function Apply-DesiredSettings([string]$Executable) {
  $dshHome = Get-DshHome
  $desiredPath = Join-Path $dshHome "pet-desired-settings.json"
  $readyPath = Join-Path $dshHome "pet-settings-ready.json"
  $startedAt = [DateTime]::UtcNow.AddSeconds(-1)
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $ReadyTimeoutMs))
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $readyPath -PathType Leaf) {
      try {
        if ((Get-Item -LiteralPath $readyPath).LastWriteTimeUtc -ge $startedAt) { break }
      } catch {}
    }
    Start-Sleep -Milliseconds 100
  }

  $desired = Read-JsonObject $desiredPath
  $overrides = if ($desired -and $desired.overrides) { $desired.overrides } else { $null }
  if ($null -eq $overrides) { return }

  $appDirectoryName = Get-PetConfigDirectoryName $Executable
  $configPath = Join-Path $env:APPDATA "$appDirectoryName\config.json"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return }
  $config = Read-JsonObject $configPath
  if ($null -eq $config) { return }

  if ($null -ne $overrides.PSObject.Properties["scale"]) { $config.scale = [double]$overrides.scale }
  if ($null -ne $overrides.PSObject.Properties["opacity"]) { $config.pet_opacity = [int]$overrides.opacity }
  if ($null -ne $overrides.PSObject.Properties["soundEnabled"]) {
    $config.click_sound_enabled = [bool]$overrides.soundEnabled
  }
  if ($null -ne $overrides.PSObject.Properties["notificationsEnabled"]) {
    $config.system_notifications_enabled = [bool]$overrides.notificationsEnabled
  }
  if ($null -ne $overrides.PSObject.Properties["selfTalkEnabled"]) {
    $config.self_talk_enabled = [bool]$overrides.selfTalkEnabled
  }

  if (
    $null -ne $overrides.PSObject.Properties["soundEnabled"] -or
    $null -ne $overrides.PSObject.Properties["notificationsEnabled"]
  ) {
    if ($null -eq $config.agent_link -or $config.agent_link -isnot [pscustomobject]) {
      $config | Add-Member -NotePropertyName agent_link -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($null -ne $overrides.PSObject.Properties["notificationsEnabled"]) {
      $enabled = [bool]$overrides.notificationsEnabled
      $config.agent_link | Add-Member -NotePropertyName notify_state -NotePropertyValue $enabled -Force
      $config.agent_link | Add-Member -NotePropertyName notify_done -NotePropertyValue $enabled -Force
      $config.agent_link | Add-Member -NotePropertyName notify_activity -NotePropertyValue $enabled -Force
      $config.agent_link | Add-Member -NotePropertyName notify_exec_failed -NotePropertyValue $enabled -Force
    }
    if ($null -ne $overrides.PSObject.Properties["soundEnabled"]) {
      $config.agent_link | Add-Member -NotePropertyName sound_enabled -NotePropertyValue ([bool]$overrides.soundEnabled) -Force
    }
  }
  Write-JsonAtomic $configPath $config
}

function Warm-MenuResources([string]$Executable) {
  $paths = @()
  if (Test-SourceEntry $Executable) {
    # Source mode: warm the source-tree menu templates (packaged: _internal/pet/menu_templates).
    $templateDirectory = Join-Path (Split-Path -Parent $Executable) "pet\menu_templates"
  } else {
    $root = Join-Path (Split-Path -Parent $Executable) "_internal"
    $templateDirectory = Join-Path $root "pet\menu_templates"
    $paths = @(
      (Join-Path $root "base_library.zip"),
      (Join-Path $root "python312.dll")
    )
  }
  if (Test-Path -LiteralPath $templateDirectory -PathType Container) {
    $paths += Get-ChildItem -LiteralPath $templateDirectory -File -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  }
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try {
      $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $stream.Close()
    } catch {}
  }
}

function Start-PetProcess([string]$Executable, [string]$Python) {
  # The pet's own output is discarded by Start-Process by default, which means
  # "the pet did not start" leaves no first-hand evidence at all. Redirect both
  # streams to files under the pet's config directory.
  # Diagnostics must land somewhere BOTH the launcher and the diagnostic reader can
  # write/read. %APPDATA%\dsh-pet-standalone-webm-chat is fine for DSH but blocked
  # for a confined reader, and a failed redirect here aborts the whole script
  # silently -- which is exactly how "the pet did not start" became unreadable.
  $logDir = Join-Path $env:TEMP "dsh-pet-diag"
  try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch {}
  if (-not (Test-Path -LiteralPath $logDir)) { $logDir = $env:TEMP }
  $stdout = Join-Path $logDir "pet-stdout.log"
  $stderr = Join-Path $logDir "pet-stderr.log"
  $trace = Join-Path $logDir "pet-launch-trace.log"

  # A launch trace: the exact interpreter, entry, working directory and PATH that
  # the pet is handed. Without this, "it exited before writing any log" is
  # indistinguishable from a dozen different causes.
  try {
    $lines = @(
      "--- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ---",
      "entry      = $Executable",
      "isSource   = $(Test-SourceEntry $Executable)",
      "python     = $Python",
      "pythonExists = $(if ($Python) { Test-Path -LiteralPath $Python } else { 'n/a' })",
      "workingDir = $(Split-Path -Parent $Executable)",
      "APPDATA    = $env:APPDATA",
      "DSH_PET_LAUNCHER = $env:DSH_PET_LAUNCHER",
      "DSH_PET_PYTHON   = $env:DSH_PET_PYTHON",
      "DSH_PET_SOURCE   = $env:DSH_PET_SOURCE",
      "DSH_PET_EXE      = $env:DSH_PET_EXE",
      "nodeCwd    = $(Get-Location)"
    )
    $lines | Out-File -FilePath $trace -Append -Encoding utf8
  } catch {}

  if (Test-SourceEntry $Executable) {
    # Source mode: the entry point is a .py wrapper (dsh_pet_launcher.py) run by the
    # interpreter. The returned process is the interpreter itself, so the wait and
    # process-tree handling below stay identical to packaged mode.
    $env:DSH_PET_SOURCE = "1"
    $env:DSH_PET_EXE = $Executable
    return Start-Process -FilePath $Python -ArgumentList @("`"$Executable`"") `
      -WorkingDirectory (Split-Path -Parent $Executable) -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  }
  return Start-Process -FilePath $Executable `
    -WorkingDirectory (Split-Path -Parent $Executable) -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

$petExecutable = Resolve-PetExecutable $Executable
Apply-DesiredSettings $petExecutable
Force-PetConfigFlags $petExecutable
Warm-MenuResources $petExecutable

# Optional capability probe: when DSH_PET_NODE_PROBE points at a .mjs file, run it
# with the same interpreter and context the launcher would use for a native (Node)
# pet, then exit. This exists so "can the runtime spawn ffmpeg / use Media
# Foundation" is MEASURED in the real place instead of assumed.
if ($env:DSH_PET_NODE_PROBE -and (Test-Path -LiteralPath $env:DSH_PET_NODE_PROBE -PathType Leaf)) {
  $probeOut = $env:DSH_PET_NODE_PROBE_OUT
  if (-not $probeOut) { $probeOut = Join-Path $env:TEMP "dsh-pet-probe.txt" }
  "--- probe via launcher ---" | Out-File -FilePath $probeOut -Append -Encoding utf8
  try {
    $probeOutput = & "D:\DSH\DeepSeek Harness.exe" $env:DSH_PET_NODE_PROBE 2>&1 | Out-String
    $probeOutput | Out-File -FilePath $probeOut -Append -Encoding utf8
    "probe exit=$LASTEXITCODE" | Out-File -FilePath $probeOut -Append -Encoding utf8
  } catch {
    "probe EXCEPTION: $($_.Exception.Message)" | Out-File -FilePath $probeOut -Append -Encoding utf8
  }
  exit 0
}

$petPython = $null
if (Test-SourceEntry $petExecutable) {
  $petPython = Resolve-PetPython
}
$pet = Start-PetProcess $petExecutable $petPython
try {
  $pet.PriorityClass = [Diagnostics.ProcessPriorityClass]::High
} catch {}

Start-Sleep -Seconds 20
try {
  if (-not $pet.HasExited) {
    $pet.PriorityClass = [Diagnostics.ProcessPriorityClass]::AboveNormal
  }
} catch {}

# Wait for the pet to finish. The pet may already be gone by now (it exits on its
# own when a slot lock is held or when its watchdog sees the old DSH host), and
# Wait-Process throws "Cannot find a process" in that case -- which used to make
# this script report exit code 1 even when nothing was actually wrong. Tolerate it
# and still report the pet's real exit code when we can.
if (-not $pet.HasExited) {
  try { Wait-Process -Id $pet.Id -ErrorAction Stop } catch {}
}
try { $pet.Refresh() } catch {}
$exitCode = 0
try { $exitCode = $pet.ExitCode } catch { $exitCode = 1 }
exit $exitCode
