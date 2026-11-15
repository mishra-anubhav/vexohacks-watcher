// Deploy Watcher to a Superserve sandbox: board server + Mastra agents, one public URL.
//
//   node deploy/superserve.ts            create (or update) the sandbox and start everything
//   node deploy/superserve.ts --status   show the URL and whether the services answer
//   node deploy/superserve.ts --kill     delete the sandbox
//
// The laptop keeps only the band bridge (Bluetooth is local): bridge/run.sh posts to BOARD_URL.
// Keys come from ../.env and are passed to the sandbox's processes as environment variables.
// BOARD_TOKEN (generated here, saved to .env) is the operator key: viewers without it can only watch.
import '../agents/src/config.ts'
import { Sandbox } from '../agents/node_modules/@superserve/sdk/dist/index.js'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ID_FILE = join(ROOT, 'deploy', '.sandbox-id')
const APP = '/home/user/app'
const NODE = 'v22.18.0'
const KEYS = ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MINIMAX_API_KEY', 'ELEVENLABS_API_KEY']
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

function setEnvLine(name: string, value: string) {
  const f = join(ROOT, '.env')
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith(name + '='))
  writeFileSync(f, [...lines, `${name}=${value}`].join('\n') + '\n')
}

async function run(sb: any, cmd: string, timeoutMs = 600_000) {
  const r = await sb.commands.run(cmd, { timeoutMs, cwd: APP })
  if (r.exitCode !== 0) throw new Error(`"${cmd.slice(0, 80)}" exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`)
  return r.stdout.trim()
}

async function waitFor(sb: any, url: string, what: string, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    const r = await sb.commands.run(`curl -s -o /dev/null -w '%{http_code}' ${url} || true`, { timeoutMs: 10_000 })
    if (r.stdout.trim() === '200') return
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new Error(`${what} did not come up (${url})`)
}

const arg = process.argv[2]
const savedId = existsSync(ID_FILE) ? readFileSync(ID_FILE, 'utf8').trim() : ''

if (arg === '--kill') {
  if (savedId) { await Sandbox.killById(savedId); writeFileSync(ID_FILE, ''); log('deleted sandbox', savedId) } else log('no sandbox')
  process.exit(0)
}
if (arg === '--status') {
  if (!savedId) { log('no sandbox deployed'); process.exit(0) }
  const sb = await Sandbox.connect(savedId)
  const r = await sb.commands.run(`curl -s localhost:8090/status; echo; curl -s localhost:4111/health | head -c 300`, { timeoutMs: 20_000 })
  log('sandbox', savedId, '\n', r.stdout, '\n  board:', sb.getPreviewUrl(8090))
  process.exit(0)
}

// ---- 1. bundle the app ---------------------------------------------------------------------
const token = process.env.BOARD_TOKEN || randomBytes(18).toString('base64url')
if (!process.env.BOARD_TOKEN) setEnvLine('BOARD_TOKEN', token)
const files = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT }).toString().split('\n').filter(Boolean)
const bundle = '/tmp/watcher-bundle.tgz'
execSync(`tar czf ${bundle} --exclude=node_modules --exclude=.git ${files.map((f) => `'${f}'`).join(' ')} vexo-open-kit media/helmetcam.mp4`, { cwd: ROOT })
log('bundle', (readFileSync(bundle).length / 1e6).toFixed(1), 'MB')

// ---- 2. sandbox ----------------------------------------------------------------------------
const envVars: Record<string, string> = { BOARD_TOKEN: token, BROWSER_AUDIO: '1', SPEAK_LOCALLY: '0', PATH: '/usr/local/bin:/usr/bin:/bin' }
for (const k of KEYS) if (process.env[k]) envVars[k] = process.env[k]!
let sb: any
if (savedId) {
  try { sb = await Sandbox.connect(savedId); log('updating sandbox', savedId) } catch { sb = null }
}
if (!sb) {
  sb = await Sandbox.create({ name: 'watcher', timeoutSeconds: 12 * 3600, envVars } as any)
  writeFileSync(ID_FILE, sb.id)
  log('created sandbox', sb.id)
}
await sb.commands.run(`mkdir -p ${APP}`, { timeoutMs: 10_000 })
await sb.files.write('/home/user/bundle.tgz', new Uint8Array(readFileSync(bundle)))
await run(sb, `tar xzf /home/user/bundle.tgz -C ${APP} && rm /home/user/bundle.tgz`)
log('uploaded')

// ---- 3. install (only what is missing) -----------------------------------------------------
await run(sb, `node --version 2>/dev/null | grep -q ${NODE} || (cd /tmp && curl -fsSL https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz -o n.tar.xz && tar -xJf n.tar.xz -C /usr/local --strip-components=1)`)
await run(sb, `python3 -c "import cv2" 2>/dev/null || python3 -m pip install -q --break-system-packages opencv-python-headless`)
await run(sb, `cd agents && npm ci --no-audit --no-fund --loglevel=error`, 900_000)
log('installed node', await run(sb, 'node --version'))

// ---- 4. (re)start the services -------------------------------------------------------------
const env = Object.entries(envVars).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ')
// the sandbox has no pkill: find the old processes with ps and stop them (else they keep the ports)
await sb.commands.run(`for p in $(ps -eo pid,args | grep -E 'server/server.py|src/service.ts|bridge/bridge.py|sim/responders.py' | grep -v grep | awk '{print $1}'); do kill $p; done; sleep 2; true`, { timeoutMs: 30_000 })
await run(sb, `mkdir -p logs && env ${env} nohup node agents/src/service.ts > logs/agents.log 2>&1 &`)
await run(sb, `env ${env} nohup python3 server/server.py --host 0.0.0.0 --port 8090 > logs/server.log 2>&1 &`)
await waitFor(sb, 'localhost:4111/health', 'agents service')
await waitFor(sb, 'localhost:8090/status', 'board server')
await sb.publishPreviewPort(8090, { access: 'public' } as any)
const url = sb.getPreviewUrl(8090).replace(/\/$/, '')
setEnvLine('BOARD_URL', url)
log('live')
console.log(`\n  Board (anyone can watch):  ${url}/app\n  Operator link (can control): saved in .env as BOARD_TOKEN; open ${url}/app?key=<BOARD_TOKEN>\n  Sandbox: ${sb.id}\n`)
