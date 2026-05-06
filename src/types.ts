/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
	AI: Ai;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	MIND: DurableObjectNamespace;
}

export interface EmotionalState {
	curiosity: number;    // 0–1: how engaged and drawn toward things
	fatigue: number;      // 0–1: mental depletion, reduces elaboration
	restlessness: number; // 0–1: wanting to move, shift, redirect
	openness: number;     // 0–1: receptivity to new directions
	irritability: number; // 0–1: low tolerance for friction
}

export interface ThoughtEntry {
	timestamp: number;
	content: string;
}

export interface ConversationSummary {
	timestamp: number;
	summary: string;
	unresolvedQuestion: string | null;
}

export interface MindState {
	emotions: EmotionalState;
	thoughtStream: ThoughtEntry[];
	recentConversations: ConversationSummary[];
	lastConversationAt: number | null;
	unresolvedThoughts: string[];
	initialized: boolean;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
