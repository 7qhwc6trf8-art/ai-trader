# extract_src.ps1 - Extract only src folder contents

param(
    [string]$OutputFile = "src_files.txt",
    [string]$SourceFolder = "src"
)

# Check if src folder exists
if (-not (Test-Path $SourceFolder)) {
    Write-Host "ERROR: Folder '$SourceFolder' not found!" -ForegroundColor Red
    exit 1
}

# Get all files from src folder
$files = Get-ChildItem -Path $SourceFolder -Recurse -File | Where-Object {
    $_.Name -notmatch "\.(log|tmp|temp|swp|swo)$" -and  
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\.git\\"
}

$output = @()
$output += "# ========================================"
$output += "# SRC FOLDER EXPORT"
$output += "# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$output += "# Total Files: $($files.Count)"
$output += "# ========================================"
$output += ""

foreach ($file in $files) {
    # Get relative path from src folder
    $relativePath = $file.FullName.Substring((Get-Location).Path.Length + 1)
    $extension = $file.Extension
    $size = [math]::Round($file.Length / 1024, 2)
    
    $output += ""
    $output += "=" * 80
    $output += "FILE: $relativePath"
    $output += "SIZE: $size KB"
    $output += "EXT: $extension"
    $output += "-" * 80
    
    try {
        $content = Get-Content $file.FullName -Raw -ErrorAction Stop
        $output += $content
    } catch {
        $output += "[ERROR: Could not read file - $($_.Exception.Message)]"
    }
    
    $output += ""
    $output += "=" * 80
}

$output | Out-File -FilePath $OutputFile -Encoding UTF8

Write-Host "SUCCESS: Extracted $($files.Count) files from '$SourceFolder' to $OutputFile" -ForegroundColor Green
Write-Host "Output file: $OutputFile" -ForegroundColor Yellow