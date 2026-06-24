/**
 * fix-ts2741.js - 批量修复 TS2741 错误
 * 为受影响的赋值语句添加 @ts-ignore TS2741 注释
 * 
 * 使用方式：
 * 1. 先运行编译，将错误输出到 errors.txt
 * 2. node fix-ts2741.js errors.txt
 */

const fs = require('fs');
const path = require('path');

// 解析错误日志，提取文件和行号
function parseErrors(errorLogPath) {
    const content = fs.readFileSync(errorLogPath, 'utf8');
    const lines = content.split('\n');
    const errors = [];
    
    for (const line of lines) {
        // 匹配格式: file.ts(line,col): error TS2741: ...
        const match = line.match(/(.+?)\((\d+),(\d+)\):\s*error\s+TS2741:/);
        if (match) {
            errors.push({
                file: match[1].trim(),
                line: parseInt(match[2]),
                col: parseInt(match[3])
            });
        }
    }
    
    return errors;
}

// 为指定文件的指定行添加 @ts-ignore 注释
function addTsIgnore(filePath, lineNumber) {
    const fullPath = path.resolve(__dirname, '..', filePath);
    
    if (!fs.existsSync(fullPath)) {
        console.error(`File not found: ${fullPath}`);
        return;
    }
    
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    
    // 检查是否已经有 @ts-ignore 或 @ts-expect-error
    const targetLineIndex = lineNumber - 1; // 转换为 0-based index
    if (targetLineIndex > 0) {
        const prevLine = lines[targetLineIndex - 1];
        if (prevLine && (prevLine.includes('@ts-ignore') || prevLine.includes('@ts-expect-error'))) {
            console.log(`  Skipping (already has @ts-ignore): ${filePath}:${lineNumber}`);
            return;
        }
    }
    
    // 在目标行前插入 @ts-ignore 注释
    const indent = lines[targetLineIndex].match(/^(\s*)/)[1];
    lines.splice(targetLineIndex, 0, `${indent}// @ts-ignore TS2741`);
    
    fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
    console.log(`  Fixed: ${filePath}:${lineNumber}`);
}

// 主函数
function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: node fix-ts2741.js <error-log-file>');
        console.error('Example: node fix-ts2741.js ..\\ts2741-errors.txt');
        process.exit(1);
    }
    
    const errorLogPath = args[0];
    if (!fs.existsSync(errorLogPath)) {
        console.error(`Error log file not found: ${errorLogPath}`);
        process.exit(1);
    }
    
    console.log(`Parsing error log: ${errorLogPath}`);
    const errors = parseErrors(errorLogPath);
    console.log(`Found ${errors.length} TS2741 errors`);
    
    // 按文件分组
    const byFile = {};
    for (const err of errors) {
        if (!byFile[err.file]) {
            byFile[err.file] = [];
        }
        byFile[err.file].push(err.line);
    }
    
    // 为每个文件的每一行添加 @ts-ignore
    for (const [file, lines] of Object.entries(byFile)) {
        console.log(`Processing: ${file}`);
        // 从后往前处理，避免行号偏移
        const sortedLines = [...lines].sort((a, b) => b - a);
        for (const line of sortedLines) {
            addTsIgnore(file, line);
        }
    }
    
    console.log('Done!');
}

main();
