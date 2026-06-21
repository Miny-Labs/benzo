// circomlibjs ships no type declarations. We use only buildEddsa/buildPoseidon
// (EdDSA + Poseidon over Baby Jubjub) for org member signing; the returned
// objects are dynamically typed by the library, so `any` is the honest type.
declare module "circomlibjs" {
  export function buildEddsa(): Promise<any>;
  export function buildPoseidon(): Promise<any>;
}
