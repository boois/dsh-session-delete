# 审计取证：npm tarball 内容 vs git 提交内容 的字节级一致性核对（只读）
#
# 结论当时记入 docs/AUDIT-0.2.2.md 前言：0.2.2 的 7 个发布文件与其 git 提交，
# 在**只做行尾归一化**的前提下 7/7 完全一致 —— 即「npm 上那份 = 仓库那份」，
# 审计读到的源码就是发布物本身，没有被发布期改写。
#
# 为什么必须归一化行尾：Windows 上 git 的 autocrlf 会把工作副本写成 CRLF，
# npm tarball 里是 LF；不归一化会把纯行尾差异误报成内容差异。
# 为什么必须防空哈希：本次审计第一次跑这份脚本时，PowerShell 里函数名 `H`
# 与内置别名 h(=Get-History) 冲突，哈希全为空 → 空串 == 空串 → 输出「全部一致」的假阳性。
# 所以：空哈希必须显式报错，并且必须带一个负控制（已知不同的两个文件要判 DIFFER）。
#
# 用法（把两条路径换成你自己的）：
#   pwsh -File tools/audit/compare-lf-hash.ps1 -NpmDir <npm包解出目录> -GitDir <git工作副本目录>

param(
  [Parameter(Mandatory = $true)][string]$NpmDir,
  [Parameter(Mandatory = $true)][string]$GitDir,
  [string[]]$Files = @('package.json', 'README.md', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'LICENSE', 'screenshots.json')
)

function Get-LfHash {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 'MISSING' }
  $text = [System.IO.File]::ReadAllText($Path)
  $text = $text -replace "`r`n", "`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  if ($bytes.Length -eq 0) { return 'ERROR (empty hash)' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
}

$bad = 0
foreach ($f in $Files) {
  $rel = $f -replace '/', '\'
  $a = Get-LfHash (Join-Path $NpmDir $rel)
  $b = Get-LfHash (Join-Path $GitDir $rel)
  if ($a -eq 'ERROR (empty hash)' -or $b -eq 'ERROR (empty hash)') {
    "{0,-24} HASH-ERROR  {1} / {2}" -f $f, $a, $b
    $bad++
  }
  elseif ($a -eq $b) {
    "{0,-24} IDENTICAL" -f $f
  }
  else {
    "{0,-24} DIFFER  npm={1} git={2}" -f $f, $a.Substring(0, 12), $b.Substring(0, 12)
    $bad++
  }
}

'--- 负控制（必须判 DIFFER，否则说明哈希函数没在跑）---'
$neg1 = Join-Path $env:TEMP 'lfhash-neg-a.txt'
$neg2 = Join-Path $env:TEMP 'lfhash-neg-b.txt'
Set-Content -LiteralPath $neg1 -Value 'audit-negative-control-A' -NoNewline
Set-Content -LiteralPath $neg2 -Value 'audit-negative-control-B' -NoNewline
$na = Get-LfHash $neg1
$nb = Get-LfHash $neg2
if ($na -eq $nb) { '负控制 IDENTICAL —— 异常，哈希链不可信，本次结果作废'; $bad++ } else { '负控制 DIFFER —— 正常' }
Remove-Item -LiteralPath $neg1, $neg2 -Force

"{0}" -f $(if ($bad -eq 0) { '全部一致，且负控制有效' } else { "有 $bad 项异常/差异，见上" })
exit $(if ($bad -eq 0) { 0 } else { 1 })
