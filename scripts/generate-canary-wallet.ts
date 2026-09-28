import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createEncryptedCanaryWallet } from "../src/server/solana-signer.js";

const path = process.env.SOLANA_SIGNER_CREDENTIALS_FILE?.trim();
const passphrase = process.env.SOLANA_SIGNER_PASSPHRASE?.trim();
if (!path || !passphrase) {
  throw new Error("Set SOLANA_SIGNER_CREDENTIALS_FILE and SOLANA_SIGNER_PASSPHRASE");
}
await mkdir(dirname(path), { recursive: true });
const publicKey = await createEncryptedCanaryWallet(path, passphrase);
console.log(`Canary wallet public key: ${publicKey}`);
