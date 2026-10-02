# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    组装 DSH 桌宠发行包（distribution）。

.DESCRIPTION
    产出 dsh-pet-dist\ 目录 + dsh-pet-portable.zip，用户解压后运行
    install\install.ps1 即可装进自己的 DSH。

    组成：
      plugin\dsh-pet-host\   DSH 宿主插件（Node 侧：桥接 / 进程托管）  ~0.3 MB
      pet\                   桌宠程序本体（Python / PySide6）          ~80 MB
      installer\             启动器脚本
      install\               安装脚本
      README.md

    桌宠本体有两种形态，用 -Mode 选择：
      source  直接分发 Python 源码（需目标机有可用的 Python + 依赖）
      frozen  分发 PyInstaller 打包产物（自包含，用户无需装 Python）【推荐分发】

.PARAMETER Mode
    source | frozen。默认 frozen（对用户最省事）。

.PARAMETER Variant
    桌宠变体，默认 webm-chat。

.PARAMETER SkipZip
    只组装目录，不压 zip。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-dist.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-dist.ps1 -Mode source -SkipZip
#>
param(
    [ValidateSet("source", "frozen")]
    [string]$Mode = "frozen",
    [string]$Variant = "webm-chat",
    [switch]$SkipZip
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

# 路径按**本脚本所在位置**解析，因此开发机与克隆下来的仓库里都能直接跑。
# 早先版本写死 D:\DSH\work1\...，别人克隆后必然失败。
# $PSScriptRoot 在极少数宿主下为空，用 $MyInvocation 兜底，保证不会拿到 null。
$tpl = $PSScriptRoot
if (-not $tpl) { $tpl = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $tpl) { Fail "无法确定脚本所在目录（PSScriptRoot 与 MyInvocation 都为空）" }
$repoRoot = Split-Path -Parent $tpl

# 桌宠源码目录探测（两种布局都要能跑）：
#   仓库布局： <root>\pet\dsh_pet_launcher.py
#   开发布局： <work>\pet-src\src\dsh_pet_launcher.py（与 dist-template 同级）
$src = Join-Path $repoRoot "pet"
if (-not (Test-Path (Join-Path $src "dsh_pet_launcher.py"))) {
    $src = Join-Path $repoRoot "pet-src\src"
}
if (-not (Test-Path (Join-Path $src "dsh_pet_launcher.py"))) {
    Fail "找不到桌宠源码（试过 $repoRoot\pet 与 $repoRoot\pet-src\src）"
}

# 宿主插件目录：两种布局下都与 dist-template 同级
$pluginDir = Join-Path $repoRoot "dsh-pet-host"
if (-not (Test-Path $pluginDir)) { Fail "找不到宿主插件目录: $pluginDir" }

$outRoot = $repoRoot
$dist = Join-Path $outRoot "dsh-pet-dist"

Write-Host "`n=== 组装 DSH 桌宠发行包 ===" -ForegroundColor Cyan
Info "模式   : $Mode"
Info "变体   : $Variant"
Info "产出   : $dist"

foreach ($p in @($src, $pluginDir, $tpl)) { if (-not (Test-Path $p)) { Fail "缺少目录: $p" } }

# --- 1. 清空并按结构建目录 ---
if (Test-Path $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
foreach ($d in @("plugin\dsh-pet-host", "pet", "installer", "install")) {
    New-Item -ItemType Directory -Path (Join-Path $dist $d) -Force | Out-Null
}
Ok "目录结构已建立"

# --- 2. 宿主插件（Node 侧，体积很小） ---
Copy-Item -Path (Join-Path $pluginDir "*") -Destination (Join-Path $dist "plugin\dsh-pet-host") -Recurse -Force
# 开发期的诊断日志不必分发
Remove-Item -LiteralPath (Join-Path $dist "plugin\dsh-pet-host\pet-host.log") -Force -ErrorAction SilentlyContinue
Ok "宿主插件已复制"

# --- 3. 启动器 ---
$launcher = Join-Path $repoRoot "launch-pet.ps1"
if (-not (Test-Path $launcher)) { Fail "缺少启动器: $launcher" }
Copy-Item -LiteralPath $launcher -Destination (Join-Path $dist "installer\launch-pet.ps1") -Force
Ok "启动器已复制"

# --- 4. 安装脚本 + 说明（从模板目录取） ---
Copy-Item -LiteralPath (Join-Path $tpl "install\install.ps1") -Destination (Join-Path $dist "install\install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $tpl "README.md") -Destination (Join-Path $dist "README.md") -Force
Copy-Item -LiteralPath (Join-Path $tpl "build-dist.ps1") -Destination (Join-Path $dist "build-dist.ps1") -Force
Ok "安装脚本与说明已复制"

# --- 5. 桌宠本体 ---
$petDst = Join-Path $dist "pet"
if ($Mode -eq "source") {
    Info "复制源码版桌宠（约 80 MB，含素材）..."
    Copy-Item -Path (Join-Path $src "*") -Destination $petDst -Recurse -Force
    # 运行期产物不带（一次调用删完，避免嵌套管道带来的解析歧义）
    $junkNames = @("__pycache__", ".pytest_cache", "dist-onedir", "build")
    $junkDirs = Get-ChildItem -LiteralPath $petDst -Recurse -Directory -ErrorAction SilentlyContinue |
        Where-Object { $junkNames -contains $_.Name }
    foreach ($jd in $junkDirs) {
        Remove-Item -LiteralPath $jd.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Ok "源码版已复制（目标机需自备 Python + requirements.txt 依赖）"
}
else {
    $petName = "dsh-pet-standalone-$Variant"
    $builtDir = Join-Path $src "dist-onedir"
    $built = Join-Path $builtDir $petName
    if (-not (Test-Path $built)) {
        Warn "找不到已构建的 PyInstaller 产物: $built"
        Warn "请先完成打包，再重跑本脚本（命令见下）："
        Write-Host ""
        Write-Host "    cd $src" -ForegroundColor White
        Write-Host "    pip install pyinstaller" -ForegroundColor White
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\build_onedir.ps1 -Variant $Variant" -ForegroundColor White
        Write-Host ""
        Fail "缺少 frozen 产物"
    }
    Info "复制 PyInstaller 产物..."
    Copy-Item -Path (Join-Path $built "*") -Destination $petDst -Recurse -Force
    Ok "frozen 版已复制（用户无需安装 Python）"
}

# --- 6. 版本信息 ---
$manifest = [ordered]@{
    schemaVersion = 1
    builtAt       = (Get-Date).ToUniversalTime().ToString("o")
    mode          = $Mode
    variant       = $Variant
    plugin        = "@local/dsh-pet-host"
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $dist "dist-info.json"), ($manifest | ConvertTo-Json -Depth 5), $utf8)

# --- 7. 体积统计 ---
$size = (Get-ChildItem $dist -Recurse -File | Measure-Object -Property Length -Sum).Sum
Ok ("发行目录大小: {0:N1} MB" -f ($size / 1MB))

# --- 8. 压 zip ---
if (-not $SkipZip) {
    $zip = Join-Path $outRoot "dsh-pet-portable.zip"
    if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
    Info "压缩中..."
    Compress-Archive -Path (Join-Path $dist "*") -DestinationPath $zip -CompressionLevel Optimal
    Ok ("已生成: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Info "用户操作：解压 -> 运行 install\install.ps1 -> 重启 DSH"
Write-Host ""
