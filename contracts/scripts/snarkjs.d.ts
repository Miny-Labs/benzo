// snarkjs ships no type declarations. It is only pulled in via dynamic
// `import("snarkjs")` from the ceremony driver and the dev-verifier generator,
// both of which cast the surface they use. This ambient module keeps those
// scripts type-checkable under ts-node without an untyped-import (TS7016) error.
declare module "snarkjs";
