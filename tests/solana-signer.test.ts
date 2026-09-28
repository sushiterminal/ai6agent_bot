import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createEncryptedCanaryWallet,
  loadCanarySigner,
  signJupiterTransaction,
} from "../src/server/solana-signer.js";

const tempRoot = join(
  process.env.LOCALAPPDATA ?? process.cwd(),
  "Temp",
  "opencode",
);

test("encrypts a dedicated signer and signs without exposing its secret", async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "canary-signer-"));
  const path = join(directory, "wallet.json");
  const passphrase = "fixture-passphrase-with-24-characters";
  try {
    const publicKey = await createEncryptedCanaryWallet(path, passphrase);
    const signer = await loadCanarySigner(path, passphrase);
    assert.equal(signer.publicKey.toBase58(), publicKey);

    const payer = new PublicKey(publicKey);
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      })],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const result = await signJupiterTransaction({
      transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      credentialsPath: path,
      passphrase,
      expectedPublicKey: publicKey,
    });
    assert.equal(result.publicKey, publicKey);
    assert.equal(result.recentBlockhash, "11111111111111111111111111111111");
    assert.match(result.signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    assert.equal(Buffer.from(result.signatureBase64, "base64").length, 64);
    assert.ok(result.signedTransactionBase64.length > 32);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to sign for a different configured wallet", async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "canary-signer-"));
  const path = join(directory, "wallet.json");
  const passphrase = "fixture-passphrase-with-24-characters";
  try {
    const publicKey = await createEncryptedCanaryWallet(path, passphrase);
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: new PublicKey(publicKey),
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message());
    await assert.rejects(() => signJupiterTransaction({
      transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      credentialsPath: path,
      passphrase,
      expectedPublicKey: Keypair.generate().publicKey.toBase58(),
    }), /does not match canary signer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
