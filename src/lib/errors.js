// Anything a model could correct (bad input, an unknown id) surfaces as a tool result
// with isError: true and actionable text, not as a JSON-RPC protocol error.

export class ToolError extends Error {
  constructor(message, suggestion) {
    super(message);
    this.name = 'ToolError';
    this.suggestion = suggestion;
  }
}

export function formatErrorText(err) {
  if (err instanceof ToolError) {
    return err.suggestion ? `${err.message} — ${err.suggestion}` : err.message;
  }
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}
