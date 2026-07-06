export type OnboardingStartInput = {
	address: string;
	inviteId: string;
	userId: string;
};

export type OnboardingOrchestrator = {
	startForInviteClaim: (input: OnboardingStartInput) => Promise<void>;
};

export function createNoopOnboardingOrchestrator(): OnboardingOrchestrator {
	return {
		async startForInviteClaim() {
			return undefined;
		},
	};
}
