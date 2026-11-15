// Run a shell command in the deployed sandbox:  node deploy/sh.ts "<command>"
import '../agents/src/config.ts'
import { Sandbox } from '../agents/node_modules/@superserve/sdk/dist/index.js'
import { readFileSync } from 'node:fs'
const sb = await Sandbox.connect(readFileSync(new URL('./.sandbox-id', import.meta.url), 'utf8').trim())
const r = await sb.commands.run(process.argv[2], { timeoutMs: 120_000, cwd: '/home/user/app' })
process.stdout.write(r.stdout + r.stderr)
