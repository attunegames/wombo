# Put a file on the Windows clipboard so it can be pasted straight into Discord
# (or anywhere else that accepts a pasted file).
#
# The path arrives as a real argument rather than being pasted into a command
# string, so a folder name with a quote in it cannot turn into script.
param([Parameter(Mandatory = $true)][string]$Path)
if (-not (Test-Path -LiteralPath $Path)) { Write-Error "no such file: $Path"; exit 1 }
Set-Clipboard -LiteralPath $Path
Write-Output "copied"
