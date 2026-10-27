#!/usr/bin/env node
let input='';
for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify({args:process.argv.slice(2),input}));
process.exitCode=7;
