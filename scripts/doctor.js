'use strict';
const { runStartupDiagnostics } = require('../src/startup_diagnostics');
const result = runStartupDiagnostics({ throwOnError: false });
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;
