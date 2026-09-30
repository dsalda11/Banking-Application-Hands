import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { LeaseError, type ControlLease } from './control-lease.js';

export interface OperatorView {
  readonly runId: string;
  readonly interventionId: string;
  readonly reason: string;
  readonly stepId?: string;
  readonly risk: string;
  readonly currentUrl?: string;
  readonly resumeCheckpoint: string;
}

export interface OperatorActions {
  claim(): Promise<ControlLease>;
  heartbeat(generation: number): Promise<ControlLease>;
  resume(generation: number): Promise<{ lease: ControlLease; message?: string }>;
  complete(generation: number): Promise<{ lease: ControlLease; message?: string }>;
  abort(generation: number): Promise<ControlLease>;
  reclaim(): Promise<ControlLease>;
}

export interface OperatorServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface OperatorStatus {
  readonly revision: number;
  readonly owner: string;
  readonly generation: number;
  readonly leaseState: string;
  readonly expiresAt?: string;
  readonly validationState: string;
  readonly validationCommand?: string;
  readonly decisionChannelState: string;
  readonly terminal: boolean;
  readonly lastCommandResult?: string;
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Automation operator console</title><style>body{font:16px system-ui,sans-serif;margin:2rem;max-width:48rem}button{margin:.25rem;padding:.55rem .8rem}button:focus-visible{outline:3px solid #005fcc;outline-offset:2px}dt{font-weight:700}dd{margin:0 0 .5rem}#status{min-height:1.5rem}#controls{margin-top:1rem}</style></head><body><main><h1 id="heading">Automation intervention</h1><dl id="details"><dt>State</dt><dd id="lease-state">Loading</dd><dt>Generation</dt><dd id="generation">—</dd><dt>Validation</dt><dd id="validation">—</dd><dt>Last result</dt><dd id="last-result">—</dd></dl><p id="status" role="status" aria-live="polite">Loading operator status.</p><div id="controls"><button id="claim">Claim Control</button><button id="reclaim">Reclaim Expired Lease</button><button id="resume">Resume Automation</button><button id="complete">Complete Task</button><button id="abort">Abort Run</button></div></main><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let generation=0,commandInFlight=false,pollTimer,heartbeatTimer,terminal=false;
const byId=id=>document.querySelector('#'+id),buttons=['claim','reclaim','resume','complete','abort'].map(byId);
function stopTimers(){if(pollTimer){clearInterval(pollTimer);pollTimer=undefined}if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=undefined}}
function setMessage(message){byId('status').textContent=message}
function controls(status){terminal=Boolean(status.terminal);const human=status.owner==='human'&&status.leaseState==='HUMAN_OWNED'&&!terminal&&status.validationState!=='validating';const claimable=status.leaseState==='PAUSED'&&!terminal;const expired=status.leaseState==='LEASE_EXPIRED'&&!terminal;byId('claim').disabled=!claimable||commandInFlight;byId('reclaim').disabled=!expired||commandInFlight;byId('resume').disabled=!human||commandInFlight;byId('complete').disabled=!human||commandInFlight;byId('abort').disabled=!human||commandInFlight;if(human&&!heartbeatTimer)heartbeatTimer=setInterval(()=>heartbeat(),10000);if(!human&&heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=undefined}if(terminal)stopTimers()}
function render(payload){const status=payload.status||payload;generation=payload.lease?.generation??status.generation??generation;byId('lease-state').textContent=status.leaseState||payload.lease?.state||'Unknown';byId('generation').textContent=String(generation||'—');byId('validation').textContent=status.validationState||'idle';byId('last-result').textContent=status.lastCommandResult||'—';byId('heading').textContent=terminal?'Automation intervention finished':'Automation intervention';controls(status)}
async function refresh(){if(!token||terminal)return;try{const response=await fetch('/api/state',{headers:{authorization:'Bearer '+token}});if(!response.ok)throw new Error('authentication');const payload=await response.json();render(payload)}catch{setMessage('Unable to authenticate or retrieve operator status.');buttons.forEach(button=>button.disabled=true);stopTimers()}}
async function command(path,body=true){if(commandInFlight||terminal||!token)return;commandInFlight=true;buttons.forEach(button=>button.disabled=true);try{const response=await fetch(path,{method:'POST',headers:{authorization:'Bearer '+token,origin:location.origin,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify({generation})}:{})});const payload=await response.json();if(!response.ok){setMessage(payload.message||payload.code||'Operator command rejected');await refresh();return}if(payload.lease)generation=payload.lease.generation;setMessage(payload.message||payload.lease?.state||'Operator command accepted');await refresh()}catch{setMessage('Operator command could not be completed.')}finally{commandInFlight=false;if(!terminal)await refresh()}}
async function heartbeat(){if(commandInFlight||terminal)return;await command('/api/heartbeat')}
byId('claim').onclick=()=>command('/api/claim',false);byId('reclaim').onclick=()=>command('/api/reclaim',false);byId('resume').onclick=()=>command('/api/resume');byId('complete').onclick=()=>command('/api/complete');byId('abort').onclick=()=>command('/api/abort');
if(!token){setMessage('Operator authentication is required.');buttons.forEach(button=>button.disabled=true)}else{refresh();pollTimer=setInterval(refresh,1000)}
</script></body></html>`;
}

export async function startOperatorServer(options: {
  getLease(): ControlLease;
  token: string;
  view: OperatorView;
  actions: OperatorActions;
  getStatus?: () => OperatorStatus;
  onRejectedCommand?: (command: string, code: string) => void;
  ttlMs?: number;
}): Promise<{
  app: FastifyInstance;
  url: string;
  port: number;
  tokenHash: string;
  close(): Promise<void>;
}> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    const command = request.routeOptions.url?.replace('/api/', '') ?? 'request';
    const code = error instanceof LeaseError ? error.code : 'OPERATOR_REQUEST_REJECTED';
    options.onRejectedCommand?.(command, code);
    if (error instanceof LeaseError && error.code === 'VALIDATION_IN_PROGRESS')
      return reply.code(409).send({ code: 'VALIDATION_IN_PROGRESS', message: error.message });
    return reply.code(400).send({
      code,
      message: 'Operator request rejected',
    });
  });
  const authenticate = async (
    request: { headers: Record<string, unknown> },
    reply: { code: (value: number) => { send: (value: unknown) => void } },
  ) => {
    const value = String(request.headers.authorization ?? '');
    if (value !== `Bearer ${options.token}`) return reply.code(401).send({ error: 'unauthorized' });
  };
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(page()));
  const originGuard = async (
    request: { headers: Record<string, unknown> },
    reply: { code: (value: number) => { send: (value: unknown) => void } },
  ) => {
    const origin = request.headers.origin;
    const expectedOrigin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    if (origin !== undefined && origin !== expectedOrigin)
      return reply.code(403).send({ error: 'invalid_origin' });
  };
  const commandGeneration = (body: unknown): number => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LeaseError('INVALID_COMMAND', 'Operator command is invalid');
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'generation'))
      throw new LeaseError('INVALID_COMMAND', 'Operator command is invalid');
    if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1)
      throw new LeaseError('INVALID_GENERATION', 'Operator command generation is invalid');
    return record.generation as number;
  };
  app.get('/api/state', { preHandler: authenticate }, async () => ({
    view: options.view,
    lease: options.getLease(),
    status: options.getStatus?.() ?? {
      revision: 0,
      owner: options.getLease().owner,
      generation: options.getLease().generation,
      leaseState: options.getLease().state,
      validationState: 'idle',
      decisionChannelState: 'idle',
      terminal: false,
    },
  }));
  app.post('/api/claim', { preHandler: [authenticate, originGuard] }, async () => ({
    lease: await options.actions.claim(),
  }));
  app.post('/api/reclaim', { preHandler: [authenticate, originGuard] }, async () => ({
    lease: await options.actions.reclaim(),
  }));
  app.post('/api/heartbeat', { preHandler: [authenticate, originGuard] }, async (request) => {
    const generation = commandGeneration(request.body);
    return { lease: await options.actions.heartbeat(generation) };
  });
  app.post('/api/resume', { preHandler: [authenticate, originGuard] }, async (request) => {
    const generation = commandGeneration(request.body);
    return options.actions.resume(generation);
  });
  app.post('/api/complete', { preHandler: [authenticate, originGuard] }, async (request) => {
    const generation = commandGeneration(request.body);
    return options.actions.complete(generation);
  });
  app.post('/api/abort', { preHandler: [authenticate, originGuard] }, async (request) => {
    const generation = commandGeneration(request.body);
    return { lease: await options.actions.abort(generation) };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Operator server did not bind');
  return {
    app,
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    tokenHash: createHash('sha256').update(options.token).digest('hex'),
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
    },
  };
}
