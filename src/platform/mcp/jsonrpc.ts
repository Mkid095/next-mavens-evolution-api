/**
 * JSON-RPC 2.0 error codes and the MCP-specific codes this server uses.
 *
 * Deliberately a dependency-free leaf module: the codes are protocol
 * level, and keeping them here means the tool registry, the executor
 * and the tests can all import them without pulling in the service
 * graph.
 */

// ── Standard JSON-RPC 2.0 ──────────────────────────────────────────────────
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

// ── MCP / platform specific ────────────────────────────────────────────────
/** The tool or category is not known to this server. */
export const MCP_UNKNOWN_CATEGORY = -32001;
/** A resource with that name already exists (e.g. duplicate instance name). */
export const MCP_ALREADY_EXISTS = -32002;
/** The referenced resource does not exist. */
export const MCP_NOT_FOUND = -32004;
/** The instance exists but its internal row is missing. */
export const MCP_INSTANCE_MISSING = -32005;
/** The send itself failed. */
export const MCP_SEND_FAILED = -32006;
/** The caller's key does not carry the scope this tool requires. */
export const MCP_INSUFFICIENT_SCOPE = -32007;
/** The instance is not connected to WhatsApp, so it cannot send. */
export const MCP_INSTANCE_NOT_CONNECTED = -32009;
