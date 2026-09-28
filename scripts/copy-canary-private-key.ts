import "dotenv/config";
import { spawn } from "node:child_process";
import bs58 from "bs58";
import { loadCanarySigner } from "../src/server/solana-signer.js";

const path = process.env.SOLANA_SIGNER_CREDENTIALS_FILE?.trim();
const passphrase = process.env.SOLANA_SIGNER_PASSPHRASE?.trim();
if (!path || !passphrase) throw new Error("Canary signer is not configured");

const signer = await loadCanarySigner(path, passphrase);
const clipboard = spawn("clip.exe", [], {
  windowsHide: true,
  stdio: ["pipe", "ignore", "inherit"],
});
clipboard.stdin.end(bs58.encode(signer.secretKey));
await new Promise<void>((resolve, reject) => {
  clipboard.once("error", reject);
  clipboard.once("close", (code) => code === 0
    ? resolve()
    : reject(new Error(`clip.exe exited with code ${code}`)));
});
console.log(`Private key for ${signer.publicKey.toBase58()} copied to the Windows clipboard.`);
console.log("Import it into Phantom now, then clear the clipboard.");
