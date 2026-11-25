#!/usr/bin/env node
// Checks the Isometry deployment on HyperEVM (999):
//   1. every contract has code at its published address
//   2. every immutable link between the contracts points where it should
//   3. the outer limits on chain equal the limits the public API serves
//   4. every bot the API lists exists on chain with the same creator and vault
//   5. with --source <contracts checkout>, the runtime bytecode equals the compiled source
// Exits 1 when any check fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const RPC_URL = flag('--rpc') ?? process.env.RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';
const API_URL = (flag('--api') ?? process.env.API_URL ?? 'https://api.isometry.me').replace(/\/$/, '');
const SOURCE = flag('--source');

const deployment = JSON.parse(readFileSync(join(here, 'deployment-999.json'), 'utf8'));
const c = deployment.contracts;
const x = deployment.external;
const client = createPublicClient({ transport: http(RPC_URL, { batch: false, retryCount: 3 }) });

const abi = {
  botHub: parseAbi([
    'function bounds() view returns (address)',
    'function factory() view returns (address)',
    'function market() view returns (address)',
    'function botCount() view returns (uint256)',
    'function creatorOf(uint256) view returns (address)',
    'function marketInfo(uint256) view returns ((address creator, address masterVault, uint128 copyPrice, bool listed, bool retired, uint64 firstSignalAt, uint256 copyCount))',
  ]),
  copyMarket: parseAbi([
    'function hub() view returns (address)',
    'function factory() view returns (address)',
    'function feeCollector() view returns (address)',
    'function usdc() view returns (address)',
    'function bounds() view returns (address)',
  ]),
  vaultFactory: parseAbi([
    'function hub() view returns (address)',
    'function market() view returns (address)',
    'function implementation() view returns (address)',
    'function isVault(address) view returns (bool)',
  ]),
  hostedOperator: parseAbi(['function hub() view returns (address)', 'function bounds() view returns (address)']),
  feeCollector: parseAbi(['function bounds() view returns (address)', 'function usdc() view returns (address)']),
  protocolBounds: parseAbi([
    'function bounds() view returns ((uint32 maxLeverageBps, uint16 priceBandBps, uint16 maxDrawdownBps, uint16 maxDailyLossBps, uint32 maxHeartbeat))',
  ]),
};

const artifactName = {
  botHub: 'BotHub',
  copyMarket: 'CopyMarket',
  vaultFactory: 'VaultFactory',
  agentVaultImplementation: 'AgentVault',
  protocolBounds: 'ProtocolBounds',
  hostedOperator: 'HostedOperator',
  feeCollector: 'FeeCollector',
  precompileReader: 'PrecompileReader',
};

let failed = 0;
let passed = 0;
const ok = (label, detail = '') => {
  passed++;
  console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
};
const bad = (label, detail = '') => {
  failed++;
  console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
};
const same = (a, b) => getAddress(a) === getAddress(b);
const read = (name, functionName, fnArgs = []) =>
  client.readContract({ address: c[name], abi: abi[name], functionName, args: fnArgs });

async function checkChain() {
  const id = await client.getChainId();
  console.log(`\nChain  ${RPC_URL}`);
  id === deployment.chainId ? ok(`chain id ${id}`) : bad('chain id', `${id}, expected ${deployment.chainId}`);
}

async function checkCode() {
  console.log('\nCode at every address');
  for (const [name, address] of Object.entries(c)) {
    const code = await client.getCode({ address });
    code && code.length > 2 ? ok(`${artifactName[name]}`, `${(code.length - 2) / 2} bytes at ${address}`) : bad(name, `no code at ${address}`);
  }
}

async function checkLinks() {
  console.log('\nLinks between contracts');
  const links = [
    ['botHub', 'bounds', c.protocolBounds],
    ['botHub', 'factory', c.vaultFactory],
    ['botHub', 'market', c.copyMarket],
    ['copyMarket', 'hub', c.botHub],
    ['copyMarket', 'factory', c.vaultFactory],
    ['copyMarket', 'feeCollector', c.feeCollector],
    ['copyMarket', 'usdc', x.usdc],
    ['copyMarket', 'bounds', c.protocolBounds],
    ['vaultFactory', 'hub', c.botHub],
    ['vaultFactory', 'market', c.copyMarket],
    ['vaultFactory', 'implementation', c.agentVaultImplementation],
    ['hostedOperator', 'hub', c.botHub],
    ['hostedOperator', 'bounds', c.protocolBounds],
    ['feeCollector', 'bounds', c.protocolBounds],
    ['feeCollector', 'usdc', x.usdc],
  ];
  for (const [name, fn, expected] of links) {
    const got = await read(name, fn);
    const label = `${artifactName[name]}.${fn}()`;
    same(got, expected) ? ok(label, `-> ${got}`) : bad(label, `${got}, expected ${expected}`);
  }
}

async function getJson(path) {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

async function checkLimits() {
  console.log(`\nOuter limits, chain against ${API_URL}/v1/config`);
  const config = await getJson('/v1/config');
  const chain = await read('protocolBounds', 'bounds');
  const pairs = [
    ['maxLeverageBps', 'maxLeverageBps'],
    ['priceBandBps', 'maxPriceBandBps'],
    ['maxDrawdownBps', 'maxDrawdownBps'],
    ['maxDailyLossBps', 'maxDailyLossBps'],
    ['maxHeartbeat', 'maxHeartbeat'],
  ];
  for (const [onChain, inApi] of pairs) {
    const a = Number(chain[onChain]);
    const b = Number(config.bounds?.[inApi]);
    a === b ? ok(onChain, `${a}`) : bad(onChain, `chain ${a}, API ${b}`);
  }
  for (const [name, address] of Object.entries(config.contracts ?? {})) {
    const key = name === 'usdc' ? null : name;
    const expected = key ? c[key] : x.usdc;
    if (!expected) continue;
    same(address, expected) ? ok(`API address ${name}`) : bad(`API address ${name}`, `${address}, expected ${expected}`);
  }
}

async function checkBots() {
  console.log(`\nBots, chain against ${API_URL}/v1/bots`);
  const count = Number(await read('botHub', 'botCount'));
  ok('BotHub.botCount()', `${count}`);
  const items = [];
  let cursor;
  do {
    const page = await getJson(`/v1/bots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  for (const item of items) {
    const id = BigInt(item.botId);
    const detail = await getJson(`/v1/bots/${item.botId}`);
    const info = await read('botHub', 'marketInfo', [id]);
    const isVault = await read('vaultFactory', 'isVault', [info.masterVault]);
    const label = `bot ${item.botId} ${item.name}`;
    if (!same(info.creator, item.creator)) bad(label, `creator ${info.creator} on chain, ${item.creator} in API`);
    else if (!same(info.masterVault, detail.masterVault)) bad(label, `vault ${info.masterVault} on chain, ${detail.masterVault} in API`);
    else if (!isVault) bad(label, `${info.masterVault} is not a factory vault`);
    else ok(label, `vault ${info.masterVault}, ${info.copyCount} ${info.copyCount === 1n ? 'copy' : 'copies'}`);
  }
}

function strip(hex) {
  const n = parseInt(hex.slice(-4), 16);
  return hex.slice(0, hex.length - (n * 2 + 4));
}

async function checkBytecode() {
  console.log(`\nRuntime bytecode against ${SOURCE}`);
  for (const [name, address] of Object.entries(c)) {
    const file = artifactName[name];
    const path = join(SOURCE, 'out', `${file}.sol`, `${file}.json`);
    if (!existsSync(path)) {
      bad(file, `no artifact at ${path}; run forge build in the contracts checkout first`);
      continue;
    }
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    const compiled = artifact.deployedBytecode.object.replace(/^0x/, '');
    const live = (await client.getCode({ address })).replace(/^0x/, '');
    if (live.length !== compiled.length) {
      bad(file, `length ${live.length / 2} on chain, ${compiled.length / 2} compiled`);
      continue;
    }
    // Immutables are written into the code at deployment; take them from the compiled side.
    const masked = live.split('');
    for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
      for (const { start, length } of refs) {
        for (let i = start * 2; i < (start + length) * 2; i++) masked[i] = compiled[i];
      }
    }
    const liveMasked = masked.join('');
    if (liveMasked === compiled) ok(file, 'identical, metadata hash included');
    else if (strip(liveMasked) === strip(compiled)) ok(file, 'identical code, metadata hash differs');
    else bad(file, 'code differs');
  }
}

try {
  console.log('Isometry deployment check');
  await checkChain();
  await checkCode();
  await checkLinks();
  await checkLimits();
  await checkBots();
  if (SOURCE) await checkBytecode();
} catch (err) {
  bad('run stopped', err instanceof Error ? err.message : String(err));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
