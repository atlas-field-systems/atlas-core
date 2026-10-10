import { base64url, type ProcessSigner, type RecoveryAuthority } from "../../Atlas SDK/src/index.js";

// RetainedKey is an Ed25519 key pair in its owner's storage. The SDK never
// receives it; it receives signing callbacks.
export interface RetainedKey {
  readonly privateKey: JsonWebKey;
  readonly publicKey: string;
}

const algorithm = { name: "Ed25519" } as const;

export async function generateKey(): Promise<RetainedKey> {
  const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey), publicKey };
}

async function signWith(key: RetainedKey, message: Uint8Array) {
  const imported = await crypto.subtle.importKey("jwk", key.privateKey, algorithm, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign(algorithm, imported, new Uint8Array(message))));
}

// processSigner is the trusted runtime's callback for the current reporting
// process.
export function processSigner(key: RetainedKey): ProcessSigner {
  return { publicKey: key.publicKey, sign: (message) => signWith(key, message) };
}

// recoveryAuthority is the Asset OS/deployment callback that authorizes a
// replacement process.
export function recoveryAuthority(key: RetainedKey): RecoveryAuthority {
  return { authorize: (message) => signWith(key, message) };
}
