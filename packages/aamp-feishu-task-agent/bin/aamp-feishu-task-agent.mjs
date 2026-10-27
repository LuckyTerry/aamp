#!/usr/bin/env node
process.env.AAMP_TASK_ENTRY='long';
await import('./feishu-task-agent.mjs');
