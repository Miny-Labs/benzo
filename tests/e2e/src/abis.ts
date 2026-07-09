// Minimal ABI fragments the funded suites call. Deliberately tiny — addresses
// are always resolved from @benzo/config, never embedded here.

export const ERC20_ABI = [
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "decimals",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint8" }],
	},
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
] as const;

export const REGISTRAR_ABI = [
	{
		type: "function",
		name: "isUserRegistered",
		stateMutability: "view",
		inputs: [{ name: "user", type: "address" }],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "getUserPublicKey",
		stateMutability: "view",
		inputs: [{ name: "user", type: "address" }],
		outputs: [{ name: "", type: "uint256[2]" }],
	},
] as const;

export const EERC_BALANCE_ABI = [
	{
		type: "function",
		name: "getBalanceFromTokenAddress",
		stateMutability: "view",
		inputs: [
			{ name: "user", type: "address" },
			{ name: "tokenAddress", type: "address" },
		],
		outputs: [
			{
				name: "",
				type: "tuple",
				components: [
					{ name: "eGCT", type: "uint256[2][2]" },
					{
						name: "amountPCTs",
						type: "tuple[]",
						components: [
							{ name: "pct", type: "uint256[7]" },
							{ name: "index", type: "uint256" },
						],
					},
					{ name: "balancePCT", type: "uint256[7]" },
					{ name: "transactionIndex", type: "uint256" },
					{ name: "nonce", type: "uint256" },
				],
			},
		],
	},
] as const;

export const AUDITOR_ABI = [
	{
		type: "function",
		name: "auditorPublicKey",
		stateMutability: "view",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "tuple",
				components: [
					{ name: "x", type: "uint256" },
					{ name: "y", type: "uint256" },
				],
			},
		],
	},
] as const;
