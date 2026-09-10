import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let sessionId = "grok-test-session";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 900 && request.error) {
    send({ jsonrpc: "2.0", method: "server_request_rejected", params: request.error });
    return;
  }
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        capabilities: ["session/new", "session/load", "session/prompt"]
      }
    });
    return;
  }
  if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { action: "read" } });
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/load") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/prompt") {
    const mode = process.argv[2];
    if (mode === "slow" || mode === "terminal-only" || mode === "terminal-error") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { update: { type: "agent_message_chunk", text: "完整回复" } } });
        if (mode === "slow") {
          send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
        } else {
          send({ jsonrpc: "2.0", method: "session/update", params: { update: { type: mode === "terminal-error" ? "error" : "turn_completed", text: mode === "terminal-error" ? "真实错误" : "" } } });
        }
      }, 300);
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "agent_message_chunk", text: "fake reply" } }
    });
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { ok: true }
    });
    return;
  }
  if (request.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
  }
});
