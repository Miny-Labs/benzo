pragma circom 2.2.2;

include "funds_attestation_impl.circom";

component main {public [oracleKeyId, threshold, assetId, currentTime, maxAgeSeconds, holderBinding]} = FundsAttestation();
