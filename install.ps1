param(
  [string]$TargetDrive = "",
  [switch]$DirectCopy
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeminiPlugins = Join-Path $env:USERPROFILE ".gemini\config\plugins"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Antigravity 插件创意工坊 (Plugin Workshop)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $RepoRoot "plugin.json"))) {
  throw "未找到 plugin.json，请在仓库根目录运行此脚本。"
}

New-Item -ItemType Directory -Path (Split-Path -Parent $GeminiPlugins) -Force | Out-Null

if ($DirectCopy) {
  $DestDir = Join-Path $GeminiPlugins "workshop"
  New-Item -ItemType Directory -Path $GeminiPlugins -Force | Out-Null
} else {
  $DriveBase = if ($TargetDrive) {
    $TargetDrive.TrimEnd('\')
  } elseif (Test-Path "E:\") {
    "E:\AntigravityPlugins"
  } elseif (Test-Path "D:\") {
    "D:\AntigravityPlugins"
  } else {
    $GeminiPlugins
  }

  $UseJunction = ($DriveBase -ne $GeminiPlugins)
  if ($UseJunction) {
    $RealPluginsDir = $DriveBase
    New-Item -ItemType Directory -Path $RealPluginsDir -Force | Out-Null
    $DestDir = Join-Path $RealPluginsDir "workshop"

    if (Test-Path $GeminiPlugins) {
      $item = Get-Item $GeminiPlugins -Force
      if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        # 迁移原有插件到目标盘后再建立目录联接，避免 C 盘膨胀
        Get-ChildItem -Path $GeminiPlugins -Force | ForEach-Object {
          $targetItem = Join-Path $RealPluginsDir $_.Name
          if (-not (Test-Path $targetItem)) {
            Move-Item -Path $_.FullName -Destination $targetItem -Force
          }
        }
        Remove-Item -Path $GeminiPlugins -Recurse -Force
        cmd /c "mklink /J `"$GeminiPlugins`" `"$RealPluginsDir`"" | Out-Null
        Write-Host "[OK] 已将插件总目录通过目录联接映射至: $RealPluginsDir" -ForegroundColor Green
      }
    } else {
      cmd /c "mklink /J `"$GeminiPlugins`" `"$RealPluginsDir`"" | Out-Null
      Write-Host "[OK] 已创建插件目录联接: $GeminiPlugins -> $RealPluginsDir" -ForegroundColor Green
    }
  } else {
    New-Item -ItemType Directory -Path $GeminiPlugins -Force | Out-Null
    $DestDir = Join-Path $GeminiPlugins "workshop"
  }
}

Write-Host "正在复制创意工坊文件到: $DestDir"
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "plugin.json") -Destination (Join-Path $DestDir "plugin.json") -Force
Copy-Item -Path (Join-Path $RepoRoot "sidecars") -Destination $DestDir -Recurse -Force

Write-Host ""
Write-Host "[成功] 创意工坊安装完成！" -ForegroundColor Green
Write-Host "1. 若 Antigravity 正在运行，请完全重启一次 Antigravity（之后可用工坊内「冷启动」按钮刷新新插件）。"
Write-Host "2. 打开 Antigravity -> 右侧边栏「插件」面板 -> 点击「创意工坊」即可使用。"
