# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    安装 DSH 桌宠到本机 DSH。

.DESCRIPTION
    做三件事：
      1. 把发行目录复制到稳定的安装位置（默认 %LOCALAPPDATA%\dsh-pet）
      2. 把宿主插件目录链接进 DSH 的 desktop profile 的 node_modules
      3. 把插件加入 profile package.json 的 dsh.profile.bundles

    写 package.json 时**只做定点字符串插入**（不整体重排、UTF-8 无 BOM），
    并在写入前备份。原因：DSH 对 JSON 解析失败很敏感，BOM 或格式重排都会
    导致启动异常；此前手工用 Set-Content -Encoding UTF8 写出的 BOM 就踩过。

.PARAMETER Target
    安装目录。默认 %LOCALAPPDATA%\dsh-pet

.PARAMETER Profile
    DSH profile 名。默认 desktop

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Target D:\Apps\dsh-pet
#>
param(
    [string]$Target = "",
    [string]$Profile = "desktop"
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "  $msg" }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X] $msg" -ForegroundColor Red; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $env:LOCALAPPDATA "dsh-pet" }

Write-Host "`n=== DSH 桌宠安装 ===" -ForegroundColor Cyan
Info "发行目录 : $root"
Info "安装位置 : $Target"
Info "DSH profile : $Profile"

# --- 1. 前置检查 ---
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $profileDir)) {
    Fail "找不到 DSH profile: $profileDir`n      请先安装并至少运行一次 DSH。"
}
$profilePkg = Join-Path $profileDir "package.json"
if (-not (Test-Path $profilePkg)) { Fail "找不到 profile 的 package.json: $profilePkg" }

$pluginSrc = Join-Path $root "plugin\dsh-pet-host"
if (-not (Test-Path $pluginSrc)) { Fail "发行目录里缺少 plugin\dsh-pet-host" }
if (-not (Test-Path (Join-Path $root "pet"))) { Fail "发行目录里缺少 pet\" }
if (-not (Test-Path (Join-Path $root "installer\launch-pet.ps1"))) { Fail "发行目录里缺少 installer\launch-pet.ps1" }

# --- 2. 复制到安装位置 ---
if ($root -ne $Target) {
    Info "复制文件（首次可能较慢，桌宠素材较大）..."
    if (Test-Path $Target) {
        Warn "安装位置已存在，先移除旧版本: $Target"
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Copy-Item -Path (Join-Path $root "*") -Destination $Target -Recurse -Force
    Ok "已复制到 $Target"
} else {
    Ok "已在安装位置，跳过复制"
}

# 解除网络文件的"阻止"标记，否则 PowerShell 脚本可能被策略拒绝执行
Get-ChildItem -LiteralPath $Target -Recurse -File -Include *.ps1,*.js,*.mjs,*.exe,*.dll -ErrorAction SilentlyContinue |
    ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue }

# --- 3. 准备 Python 运行环境（源码版桌宠需要） ---
#
# 为什么必须做这步：源码版桌宠是 Python 程序，用户机器上常常没有可用的 Python
# （Windows 的 Microsoft Store 会给 python.exe 放一个"假解释器"占位程序，运行
# 只提示去商店安装——它有 python.exe 却没有 pythonw.exe，是个典型陷阱）。
# 这里在发行包根目录建一个自带 venv、装好 requirements，并把解释器路径写进
# ~/.dsh/dsh-pet-python.txt 供启动器读取，用户就不必自己折腾 Python。
$pythonExe = $null
$requirements = Join-Path $Target "pet\requirements.txt"
$venvDir = Join-Path $Target "python"

if (Test-Path $requirements) {
    # 找一个真 Python：优先 pythonw.exe（Store 占位程序没有它），并校验 --version
    $basePython = $null
    foreach ($name in @("pythonw.exe", "py.exe", "python.exe")) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        $probe = & $found.Source --version 2>&1 | Out-String
        if ($probe -match 'Python\s+3') { $basePython = $found.Source; break }
    }

    if (-not $basePython) {
        Warn "本机没有可用的 Python 3，跳过依赖安装。"
        Warn "桌宠启动时会提示如何安装；也可手动执行："
        Write-Host "      python -m venv `"$venvDir`"" -ForegroundColor White
        Write-Host "      `"$venvDir\Scripts\python.exe`" -m pip install -r `"$requirements`"" -ForegroundColor White
    } elseif (Test-Path (Join-Path $venvDir "Scripts\pythonw.exe")) {
        Ok "已存在 Python 环境: $venvDir"
        $pythonExe = Join-Path $venvDir "Scripts\pythonw.exe"
    } else {
        Info "创建 Python 虚拟环境（$basePython）..."
        & $basePython -m venv $venvDir 2>&1 | Out-Null
        $venvPython = Join-Path $venvDir "Scripts\python.exe"
        if (Test-Path $venvPython) {
            Info "安装依赖（首次约需 1-3 分钟，PySide6 较大）..."
            & $venvPython -m pip install --disable-pip-version-check --quiet --upgrade pip 2>&1 | Out-Null
            & $venvPython -m pip install --disable-pip-version-check --quiet -r $requirements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { "      $_" }
            $pythonw = Join-Path $venvDir "Scripts\pythonw.exe"
            if (Test-Path $pythonw) {
                $pythonExe = $pythonw
                Ok "Python 环境已就绪"
            } else {
                Warn "虚拟环境创建后找不到 pythonw.exe，依赖可能未装全"
            }
        } else {
            Warn "创建虚拟环境失败，请手动执行上面两条命令"
        }
    }

    if ($pythonExe) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $pythonPointer = Join-Path $env:USERPROFILE ".dsh\dsh-pet-python.txt"
        [System.IO.File]::WriteAllText($pythonPointer, $pythonExe, $utf8NoBom)
        Ok "已记录解释器路径: $pythonPointer"
    }
} else {
    Info "未找到 pet\requirements.txt（可能是 frozen 版），跳过 Python 环境准备"
}

# --- 4. 链接插件进 profile ---
$profileNodeModules = Join-Path $profileDir "node_modules\@local"
New-Item -ItemType Directory -Path $profileNodeModules -Force | Out-Null
$linkPath = Join-Path $profileNodeModules "dsh-pet-host"
$linkSource = Join-Path $Target "plugin\dsh-pet-host"

if (Test-Path $linkPath) { Remove-Item -LiteralPath $linkPath -Recurse -Force -ErrorAction SilentlyContinue }
try {
    New-Item -ItemType Junction -Path $linkPath -Target $linkSource -ErrorAction Stop | Out-Null
    Ok "已链接插件: $linkPath -> $linkSource"
} catch {
    Warn "创建 junction 失败（$($_.Exception.Message)），改为复制"
    Copy-Item -LiteralPath $linkSource -Destination $linkPath -Recurse -Force
    Ok "已复制插件到 $linkPath"
}

# --- 5. 把插件加入 profile 的 bundles ---
$bundleName = "@local/dsh-pet-host"
$raw = [System.IO.File]::ReadAllBytes($profilePkg)
if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
    Warn "profile package.json 带 UTF-8 BOM（DSH 解析会失败），将顺带去掉"
    $text = [System.Text.Encoding]::UTF8.GetString($raw, 3, $raw.Length - 3)
} else {
    $text = [System.Text.Encoding]::UTF8.GetString($raw)
}

$data = $text | ConvertFrom-Json
$bundles = @($data.dsh.profile.bundles)
if ($bundles -contains $bundleName) {
    Ok "插件已在 bundles 中，无需修改"
} else {
    # 备份
    $backup = "$profilePkg.bak-dsh-pet-install"
    if (-not (Test-Path $backup)) {
        Copy-Item -LiteralPath $profilePkg -Destination $backup -Force
        Info "已备份: $backup"
    }

    # 定点插入：只替换 bundles 数组那一段，其余字节原样保留
    $key = '"bundles"'
    $keyPos = $text.IndexOf($key)
    if ($keyPos -lt 0) { Fail "profile package.json 里找不到 `"bundles`" 数组" }
    $openBracket = $text.IndexOf('[', $keyPos)
    $depth = 0
    $closeBracket = -1
    for ($i = $openBracket; $i -lt $text.Length; $i++) {
        $ch = $text[$i]
        if ($ch -eq '[') { $depth++ }
        elseif ($ch -eq ']') { $depth--; if ($depth -eq 0) { $closeBracket = $i; break } }
    }
    if ($closeBracket -lt 0) { Fail "profile package.json 的 bundles 数组未闭合" }

    # 沿用数组内首个元素的实际缩进
    $lineStart = $text.LastIndexOf("`n", $openBracket)
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }
    $indent = $text.Substring($lineStart, $openBracket - $lineStart)
    $itemIndent = $indent + "  "
    $inner = $text.Substring($openBracket + 1, $closeBracket - $openBracket - 1)
    foreach ($line in ($inner -split "`n")) {
        if ($line.Trim().Length -gt 0) { $itemIndent = $line.Substring(0, $line.Length - $line.TrimStart().Length); break }
    }
    $closeIndent = if ($itemIndent.Length -ge 2) { $itemIndent.Substring(0, $itemIndent.Length - 2) } else { $itemIndent }

    $newItems = @($bundles + $bundleName) | Select-Object -Unique
    $body = ($newItems | ForEach-Object { "$itemIndent`"$_`"" }) -join ",`n"
    $newText = $text.Substring(0, $openBracket) + "[`n" + $body + "`n" + $closeIndent + "]" + $text.Substring($closeBracket + 1)

    # 写入前校验：必须是合法 JSON，且 bundles 结果符合预期
    try {
        $check = $newText | ConvertFrom-Json
    } catch {
        Fail "拒绝写入：替换结果不是合法 JSON（$($_.Exception.Message)）"
    }
    if (@($check.dsh.profile.bundles) -notcontains $bundleName) { Fail "拒绝写入：bundles 结果与预期不符" }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($profilePkg, $newText, $utf8NoBom)
    Ok "已把 $bundleName 加入 bundles（UTF-8 无 BOM）"
}

# --- 6. 记录安装位置，供插件解析桌宠路径 ---
$pointer = Join-Path $env:USERPROFILE ".dsh\dsh-pet-install.json"
$docs = [ordered]@{
    schemaVersion = 1
    installedAt   = (Get-Date).ToUniversalTime().ToString("o")
    root          = $Target
    launcher      = (Join-Path $Target "installer\launch-pet.ps1")
    petSource     = (Join-Path $Target "pet")
    pythonExe     = $(if ($pythonExe) { $pythonExe } else { "" })
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($pointer, ($docs | ConvertTo-Json -Depth 6), $utf8NoBom)
Ok "已写入安装信息: $pointer"

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Info "请**重启 DSH** 使插件生效。"
Info "桌宠启动诊断日志（如有问题）: $env:TEMP\dsh-pet-diag\"
Write-Host ""
