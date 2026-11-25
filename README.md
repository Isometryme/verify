# Isometry verify

One command that checks the Isometry deployment on HyperEVM (chain 999) against its source and against the numbers the site publishes.

```bash
git clone https://github.com/Isometryme/verify && cd verify
npm install
node verify.mjs
```

## What it checks

| Step | Check |
| --- | --- |
| Chain | The RPC answers with chain id 999 |
| Code | Each of the eight contracts has code at its published address |
| Links | Every immutable address one contract holds for another points to the right contract, fifteen links in all |
| Limits | The outer ranges stored in ProtocolBounds equal the ranges `api.isometry.me/v1/config` serves, and the API's contract addresses equal this deployment |
| Bots | Every bot the API lists exists in BotHub with the same creator and vault, and that vault was cloned by the VaultFactory |
| Bytecode | With `--source`, the runtime code at each address equals the compiled source, metadata hash included |

The script exits with status 1 when any check fails.

## Reproducing the bytecode

```bash
git clone https://github.com/Isometryme/contracts ../contracts
(cd ../contracts && forge build)
node verify.mjs --source ../contracts
```

Values written into the code at deployment (immutables) are read from the compiled artifact's `immutableReferences` and masked before the comparison. Everything else, including the CBOR metadata hash that commits to every source file and compiler setting, must match exactly.

## Output

```
Runtime bytecode against ../contracts
  ✓ BotHub  identical, metadata hash included
  ✓ CopyMarket  identical, metadata hash included
  ✓ VaultFactory  identical, metadata hash included
  ✓ AgentVault  identical, metadata hash included
  ✓ ProtocolBounds  identical, metadata hash included
  ✓ HostedOperator  identical, metadata hash included
  ✓ FeeCollector  identical, metadata hash included
  ✓ PrecompileReader  identical, metadata hash included
```

## Options

| Flag | Environment | Default |
| --- | --- | --- |
| `--rpc <url>` | `RPC_URL` | `https://rpc.hyperliquid.xyz/evm` |
| `--api <url>` | `API_URL` | `https://api.isometry.me` |
| `--source <path>` | | off |

Addresses come from `deployment-999.json`, the same file published in [Isometryme/interfaces](https://github.com/Isometryme/interfaces).

## License

[MIT](LICENSE)
