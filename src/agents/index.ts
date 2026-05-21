/**
 * Agents barrel — re-exports all public agent types and factories
 * so consumers can import from "@agent-swarm/agents" or "./agents/index.js".
 */
export { createDynamicReviewer, reviewOutput } from './dynamic.js';
export type { ReviewInput, ReviewResult } from './dynamic.js';

export { createRouterAgents, subagentDefinitions, EDIT_ACCESS_SUBAGENT_IDS } from './router.js';
