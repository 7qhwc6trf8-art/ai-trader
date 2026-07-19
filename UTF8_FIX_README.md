# UTF-8 Encoding Repair

This release repairs mojibake such as `ðŸ¤–`, `â€¢`, and `â†’` into proper UTF-8 characters such as `🤖`, `•`, and `→`.

All source files are stored as UTF-8 without BOM. Configure your editor and terminal to use UTF-8.

## Linux

```bash
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
node src/bot.js
```

## Windows PowerShell

```powershell
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
node src/bot.js
```

The utility `tools/repair-utf8.js` is included for older project copies. Always keep a backup before running bulk text repair.
