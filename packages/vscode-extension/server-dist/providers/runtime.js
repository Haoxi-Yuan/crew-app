/**
 * Runtime Provider abstraction layer.
 *
 * Defines a common interface for agent runtime providers (Claude, Codex,
 * and future providers). Each provider manages agent lifecycle, state,
 * terminal output, and control operations through a unified API.
 *
 * The provider registry maps agent names to their provider implementation
 * via the database `agents.provider` column.
 */
import { getProvider } from "../agent-runtime.js";
// Provider registry
const providers = new Map();
export function registerProvider(provider) {
    providers.set(provider.name, provider);
}
/**
 * Get the RuntimeProvider implementation for a given agent.
 * Looks up the agent's provider type in the database and returns
 * the registered implementation.
 */
export function getProviderFor(agentName) {
    const providerType = getProvider(agentName);
    const provider = providers.get(providerType);
    if (!provider) {
        throw new Error(`No runtime provider registered for type "${providerType}"`);
    }
    return provider;
}
/**
 * Get a provider implementation by type name directly.
 */
export function getProviderByType(type) {
    return providers.get(type);
}
//# sourceMappingURL=runtime.js.map