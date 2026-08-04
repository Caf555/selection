<#
.SYNOPSIS
    本機歷史同步（SPEC.md §10.4）

.DESCRIPTION
    自線上取得抽籤紀錄，驗證雜湊鏈完整性後輸出 CSV、JSONL 與可列印的 HTML。
    驗證不通過時不輸出任何檔案。

    實際工作由 tools/sync-local.mjs 完成，本檔僅為 Windows 使用者與
    「工作排程器」提供便利的進入點。雜湊鏈驗證刻意重用 engine/ 底下
    與抽籤引擎相同的程式碼，而非在 PowerShell 中另寫一份——兩份實作
    只要有一點不一致，驗證就失去意義。

.PARAMETER Out
    輸出資料夾，預設為專案下的「本機歷史」。

.PARAMETER Local
    改讀本機 data/ 目錄，不連線。

.EXAMPLE
    .\tools\sync-local.ps1

.EXAMPLE
    .\tools\sync-local.ps1 -Out D:\分案備份

.NOTES
    設定每日自動執行：
      1. 開啟「工作排程器」→ 建立基本工作
      2. 觸發程序：每天
      3. 動作：啟動程式
         程式：powershell.exe
         引數：-NoProfile -ExecutionPolicy Bypass -File "<專案路徑>\tools\sync-local.ps1"
         起始位置：<專案路徑>
#>

[CmdletBinding()]
param(
    [string]$Out = '本機歷史',
    [switch]$Local
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '  找不到 Node.js。請先安裝 Node.js 20 以上版本：https://nodejs.org/' -ForegroundColor Red
    Write-Host ''
    exit 1
}

$nodeArgs = @('tools/sync-local.mjs', '--out', $Out)
if ($Local) { $nodeArgs += @('--source', 'local') }

Push-Location $projectRoot
try {
    & node @nodeArgs
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Host ''
    Write-Host '  同步失敗，未輸出任何檔案。' -ForegroundColor Red
    Write-Host '  若為雜湊鏈驗證失敗，代表線上資料可能遭竄改，請立即停止以本系統分案並查明原因。' -ForegroundColor Red
    Write-Host ''
    exit $code
}
