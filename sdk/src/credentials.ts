/** Secret entropy in every Atlas credential, matching Core. */
const secretBytes = 32;

/** Creates a new Asset credential. The caller must retain it before enrolling. */
export function newAssetCredential(): string {
  return `atlas_asset_${base64Url(crypto.getRandomValues(new Uint8Array(secretBytes)))}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
