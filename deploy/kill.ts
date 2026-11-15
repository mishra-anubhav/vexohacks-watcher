import '../agents/src/config.ts'
import { Sandbox } from '../agents/node_modules/@superserve/sdk/dist/index.js'
for (const id of process.argv.slice(2)) { await Sandbox.killById(id); console.log('killed', id) }
