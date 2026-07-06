import type { Abi } from "viem";

export const encryptedErcAbi = [
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "user", type: "address" },
			{ indexed: false, name: "auditorPCT", type: "uint256[7]" },
			{ indexed: true, name: "auditorAddress", type: "address" },
		],
		name: "PrivateMint",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "user", type: "address" },
			{ indexed: false, name: "auditorPCT", type: "uint256[7]" },
			{ indexed: true, name: "auditorAddress", type: "address" },
		],
		name: "PrivateBurn",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "from", type: "address" },
			{ indexed: true, name: "to", type: "address" },
			{ indexed: false, name: "auditorPCT", type: "uint256[7]" },
			{ indexed: true, name: "auditorAddress", type: "address" },
		],
		name: "PrivateTransfer",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "user", type: "address" },
			{ indexed: false, name: "amount", type: "uint256" },
			{ indexed: false, name: "dust", type: "uint256" },
			{ indexed: false, name: "tokenId", type: "uint256" },
		],
		name: "Deposit",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "user", type: "address" },
			{ indexed: false, name: "amount", type: "uint256" },
			{ indexed: false, name: "tokenId", type: "uint256" },
			{ indexed: false, name: "auditorPCT", type: "uint256[7]" },
			{ indexed: true, name: "auditorAddress", type: "address" },
		],
		name: "Withdraw",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "oldAuditor", type: "address" },
			{ indexed: true, name: "newAuditor", type: "address" },
		],
		name: "AuditorChanged",
		type: "event",
	},
] as const satisfies Abi;

export const registrarAbi = [
	{
		anonymous: false,
		inputs: [
			{ indexed: true, name: "user", type: "address" },
			{
				components: [
					{ name: "x", type: "uint256" },
					{ name: "y", type: "uint256" },
				],
				indexed: false,
				name: "publicKey",
				type: "tuple",
			},
		],
		name: "Register",
		type: "event",
	},
] as const satisfies Abi;
