import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        _meta: { agentVersion: "1.0.25" }
      }
    });
    return;
  }

  if (request.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "grok-capability-session",
        models: {
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6", _meta: {
              reasoningEffort: "high",
              reasoningEfforts: [{ id: "low" }, { id: "high" }]
            } },
            { modelId: "grok-3-mini", name: "Grok 3 Mini", _meta: {} }
          ]
        },
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "grok-4.6",
          options: [
            { value: "grok-4.6", name: "Grok 4.6" },
            { value: "grok-3-mini", name: "Grok 3 Mini" }
          ]
        }]
      }
    });
    return;
  }

  if (request.method === "session/close") {
    send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
  }
});
