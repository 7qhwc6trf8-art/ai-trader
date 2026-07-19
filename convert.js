// complete-fix.js
const fs = require('fs');
const path = require('path');

/**
 * Complete Emoji Fixer for bot.js
 * Run: node complete-fix.js
 */

// ============================================================
// COMPLETE EMOJI MAPPINGS - Based on your diagnostic output
// ============================================================

const EMOJI_FIXES = {
    // These are the broken character sequences from your file
    // Mapping broken characters to proper emojis
    
    // Charts & Indicators
    'ðŸ“Š': '📊',  // Chart
    'ðŸ“ˆ': '📈',  // Chart increasing
    'ðŸ“‰': '📉',  // Chart decreasing
    'ðŸ“': '📊',   // Partial chart
    
    // AI & Intelligence
    'ðŸ¤–': '🤖',  // Robot face
    'ðŸ§ ': '🧠',  // Brain
    'ðŸ”': '🔍',   // Magnifying glass
    
    // Money & Finance
    'ðŸ’°': '💰',  // Money bag
    'ðŸ’µ': '💵',  // Dollar bill
    'ðŸ”‘': '🔑',  // Key
    
    // Actions & Status
    'ðŸŸ¢': '🟢',  // Green circle
    'ðŸ”´': '🔴',  // Red circle
    'ðŸŸ¡': '🟡',  // Yellow circle
    'ðŸ”„': '🔄',  // Arrows counterclockwise
    'ðŸ”™': '🔙',  // Back arrow
    
    // Time & Schedule
    'â±ï¸': '⏱️',  // Stopwatch
    'â¹ï¸': '⏹️',  // Stop button
    'â³': '⏰',    // Alarm clock
    'â°': '⏳',    // Hourglass
    
    // Status Indicators
    'âœ…': '✅',    // Checkmark
    'âŒ': '❌',    // Cross mark
    'âš ï¸': '⚠️', // Warning
    'âšª': '⚪',    // White circle
    'â°': '⏳',     // Hourglass
    
    // Navigation & Misc
    'ðŸ‘‡': '👇',   // Backhand index pointing down
    'ðŸ“': '📁',   // File folder
    'ðŸ”—': '🔗',   // Link
    'ðŸ“': '📝',   // Memo
    'ðŸ“‹': '📋',   // Clipboard
    'ðŸ“¡': '📡',   // Satellite antenna
    'ðŸŽ¯': '🎯',   // Target
    'ðŸš€': '🚀',   // Rocket
    'ðŸ¦': '🏦',    // Bank
    'ðŸ”:': '🔔',   // Bell
    'ðŸ“': '📊',    // Chart
    
    // Additional
    'ðŸŸ': '🟡',    // Yellow circle
    'ðŸ”': '🔴',    // Red circle
    'ðŸ’': '💵',    // Money
    'ðŸ§': '🧠',    // Brain
    'ðŸ¤': '🤖',    // Robot
};

// Complete standard emoji map for normalization
const STANDARD_EMOJIS = {
    '📊': '📊', '📈': '📈', '📉': '📉',
    '🤖': '🤖', '🧠': '🧠', '🔍': '🔍',
    '💰': '💰', '💵': '💵', '🔑': '🔑',
    '🟢': '🟢', '🔴': '🔴', '🟡': '🟡',
    '🔄': '🔄', '🔙': '🔙',
    '⏱️': '⏱️', '⏹️': '⏹️', '⏰': '⏰', '⏳': '⏳',
    '✅': '✅', '❌': '❌', '⚠️': '⚠️', '⚪': '⚪',
    '👇': '👇', '📁': '📁', '🔗': '🔗',
    '📝': '📝', '📋': '📋', '📡': '📡',
    '🎯': '🎯', '🚀': '🚀', '🏦': '🏦',
    '🔔': '🔔', '❓': '❓',
    '🛑': '🛑',  // Stop sign
    '¦': '📊',   // Broken chart
};

/**
 * Fix emojis in text
 */
function fixEmojis(text) {
    let fixed = text;
    let changes = 0;
    
    console.log('\n🔧 Applying fixes...');
    
    // Apply each fix
    for (const [broken, fixedEmoji] of Object.entries(EMOJI_FIXES)) {
        if (broken && fixedEmoji) {
            // Escape special regex characters
            const escaped = broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escaped, 'g');
            const count = (fixed.match(regex) || []).length;
            
            if (count > 0) {
                fixed = fixed.replace(regex, fixedEmoji);
                changes += count;
                console.log(`   ✅ '${broken}' → '${fixedEmoji}' (${count} times)`);
            }
        }
    }
    
    // Try to fix any remaining broken characters by pattern matching
    // Look for common mojibake patterns
    const patterns = [
        // Fix common sequences
        { from: /ðŸ/g, to: '📊' },
        { from: /â/g, to: '⏳' },
        { from: /ï/g, to: '⚠️' },
        { from: /¸/g, to: '️' },  // Variation selector
        { from: /¹/g, to: '⏹️' },
        { from: /¢/g, to: '🟢' },
        { from: /´/g, to: '🔴' },
        { from: /³/g, to: '⏰' },
        { from: /µ/g, to: '💵' },
        { from: /¯/g, to: '🎯' },
        { from: /ª/g, to: '⚪' },
        { from: /¦/g, to: '📊' },
    ];
    
    for (const pattern of patterns) {
        const count = (fixed.match(pattern.from) || []).length;
        if (count > 0) {
            fixed = fixed.replace(pattern.from, pattern.to);
            changes += count;
            console.log(`   ✅ Pattern '${pattern.from.source}' → '${pattern.to}' (${count} times)`);
        }
    }
    
    console.log(`\n📊 Total changes: ${changes}`);
    return fixed;
}

/**
 * Process a single file
 */
function processFile(filePath) {
    console.log(`\n📁 Processing: ${filePath}`);
    
    try {
        // Read file
        const content = fs.readFileSync(filePath, 'utf8');
        const originalSize = content.length;
        
        // Show sample of broken content
        console.log('\n📝 Sample of broken content:');
        const lines = content.split('\n');
        let sampleCount = 0;
        for (const line of lines) {
            if (line.match(/[^\x00-\x7F]/)) {
                console.log(`   ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
                sampleCount++;
                if (sampleCount >= 3) break;
            }
        }
        
        // Fix the content
        const fixed = fixEmojis(content);
        
        // Check if changes were made
        if (content !== fixed) {
            // Create backup
            const backupPath = filePath + '.backup';
            fs.writeFileSync(backupPath, content, 'utf8');
            console.log(`\n💾 Backup created: ${backupPath}`);
            
            // Write fixed content
            fs.writeFileSync(filePath, fixed, 'utf8');
            const newSize = fixed.length;
            
            console.log(`\n✅ SUCCESS! File fixed!`);
            console.log(`   Size: ${originalSize} → ${newSize} bytes`);
            console.log(`   Changes: ${originalSize - newSize} bytes difference`);
            
            // Show fixed sample
            console.log('\n📝 Sample of fixed content:');
            const fixedLines = fixed.split('\n');
            let fixedSampleCount = 0;
            for (const line of fixedLines) {
                if (line.match(/[\u{1F000}-\u{1FFFF}]/u)) {
                    console.log(`   ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
                    fixedSampleCount++;
                    if (fixedSampleCount >= 3) break;
                }
            }
            
            return true;
        } else {
            console.log('\n⚠️  No changes were made.');
            console.log('💡 The file might already be fixed, or the mappings need updating.');
            return false;
        }
    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        return false;
    }
}

/**
 * Main execution
 */
function main() {
    console.log('🔧 Complete Emoji Fixer\n');
    console.log('=' .repeat(50));
    
    const target = process.argv[2] || 'src/bot.js';
    
    // Check if target exists
    if (!fs.existsSync(target)) {
        console.error(`❌ Error: ${target} does not exist`);
        console.log('\n💡 Usage: node complete-fix.js [file-path]');
        console.log('   Example: node complete-fix.js src/bot.js');
        process.exit(1);
    }
    
    const stat = fs.statSync(target);
    
    if (stat.isDirectory()) {
        console.log(`📁 Processing all files in: ${target}`);
        const files = fs.readdirSync(target)
            .filter(f => f.endsWith('.js') || f.endsWith('.json') || f.endsWith('.md'))
            .map(f => path.join(target, f));
        
        let fixed = 0;
        for (const file of files) {
            if (processFile(file)) fixed++;
            console.log('\n' + '-'.repeat(50));
        }
        console.log(`\n📊 Summary: Fixed ${fixed} of ${files.length} files`);
    } else {
        processFile(target);
    }
    
    console.log('\n💡 Tip: If emojis still don\'t show correctly:');
    console.log('   1. Check your terminal/editor supports UTF-8');
    console.log('   2. In VS Code: Click bottom-right encoding → "Reopen with Encoding" → "UTF-8"');
    console.log('   3. Restart your terminal/editor');
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = { fixEmojis, processFile };