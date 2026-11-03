
/**
 * Create a function suitable for `fetch(url, { agent: fn })`.
 *
 * The returned function receives a parsed URL and returns the appropriate
 * SOCKS5 agent instance (Socks5HttpAgent / Socks5HttpsAgent).  Both agents
 * share the same proxy config and the same keep-alive / pool settings.
 */
export function createSocks5Agent(proxyUrl: string|URL, agentOptions?: import("http").AgentOptions): (URL) => import("http").Agent;