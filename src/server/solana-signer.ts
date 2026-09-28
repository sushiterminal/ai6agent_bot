import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

interface EncryptedSignerFile {
  version: 1;
  publicKey: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptionKey(passphrase: string, salt: Buffer) {
  if (passphrase.length < 24) throw new Error("SOLANA_SIGNER_PASSPHRASE must be at least 24 characters");
  return scryptSync(passphrase, salt, 32);
}

export async function createEncryptedCanaryWallet(path: string, passphrase: string) {
  const keypair = Keypair.generate();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(keypair.secretKey), cipher.final()]);
  const payload: EncryptedSignerFile = {
    version: 1,
    publicKey: keypair.publicKey.toBase58(),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return payload.publicKey;
}

export async function loadCanarySigner(path: string, passphrase: string) {
  const payload = JSON.parse(await readFile(path, "utf8")) as EncryptedSignerFile;
  if (payload.version !== 1 || typeof payload.publicKey !== "string") {
    throw new Error("Invalid Solana signer credentials file");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(passphrase, Buffer.from(payload.salt, "base64")),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  const signer = Keypair.fromSecretKey(secret);
  if (signer.publicKey.toBase58() !== payload.publicKey) {
    throw new Error("Solana signer public key does not match encrypted credentials");
  }
  return signer;
}

export async function signJupiterTransaction(input: {
  transactionBase64: string;
  credentialsPath: string;
  passphrase: string;
  expectedPublicKey: string;
}) {
  const signer = await loadCanarySigner(input.credentialsPath, input.passphrase);
  if (signer.publicKey.toBase58() !== input.expectedPublicKey) {
    throw new Error("Configured Solana wallet does not match canary signer");
  }
  const transaction = VersionedTransaction.deserialize(Buffer.from(input.transactionBase64, "base64"));
  const feePayer = transaction.message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== input.expectedPublicKey) {
    throw new Error("Refusing to sign a transaction with an unexpected fee payer");
  }
  transaction.sign([signer]);
  const signerIndex = transaction.message.staticAccountKeys
    .findIndex((key) => key.equals(signer.publicKey));
  if (signerIndex < 0 || signerIndex >= transaction.message.header.numRequiredSignatures) {
    throw new Error("Canary signer is not a required transaction signer");
  }
  return {
    publicKey: signer.publicKey.toBase58(),
    signature: bs58.encode(transaction.signatures[signerIndex]!),
    signatureBase64: Buffer.from(transaction.signatures[signerIndex]!).toString("base64"),
    recentBlockhash: transaction.message.recentBlockhash,
    signedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
  };
}
