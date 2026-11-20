import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import {
  getAgentSummaryRpc,
  listWorkspaceSummariesRpc,
  refreshAgentSummaryRpc,
  testConnectionRpc,
  togglePausedRpc,
  watchWorkspaceSummariesSub,
} from "./shared/contracts";
import { liveZhSettings } from "./shared/settings";
import { testLlmConnection } from "./server/llm";
import { LiveZhService } from "./server/service";

export default function contribute(server: PluginServerContext) {
  const service = new LiveZhService();
  const settings = server.registerSettings(liveZhSettings);

  const applySettings = (state: PluginSettingsState<typeof liveZhSettings.schema>) => {
    if (state.status === "ready") {
      service.setSettings(state.values);
    }
  };

  void settings.read().then(applySettings).catch((error: unknown) => {
    console.error("[paseo-live-zh] failed to read settings:", error);
  });
  const stopSettings = settings.subscribe(applySettings);

  const stopTurnBefore = server.addHook("agent.turn.before", async (payload, context) => {
    service.onTurnBefore(payload.agent, context.paseo);
  });

  const stopTurnAfter = server.addHook("agent.turn.after", async (payload, context) => {
    service.onTurnAfter(payload.agent, payload.outcome.kind, context.paseo);
  });

  const stopPermBefore = server.addHook("agent.permission.before", async (payload, context) => {
    service.onPermissionBefore(payload.agent, payload.request, context.paseo);
  });

  const stopPermAfter = server.addHook("agent.permission.after", async (payload) => {
    service.onPermissionAfter(payload.agent.id);
  });

  const stopArchive = server.addHook("agent.archive.after", async (payload) => {
    service.cleanupAgent(payload.agent.id);
  });

  const stopClose = server.addHook("agent.close.after", async (payload) => {
    service.cleanupAgent(payload.agent.id);
  });

  server.handle(listWorkspaceSummariesRpc, async ({ workspaceId }, { paseo }) => {
    return service.getWorkspacePayload(workspaceId, paseo);
  });

  server.handle(getAgentSummaryRpc, async ({ agentId }, { paseo }) => {
    service.attachPaseo(paseo);
    return service.getAgentSummary(agentId);
  });

  server.handle(refreshAgentSummaryRpc, async ({ agentId, force }, { paseo }) => {
    return service.refreshAgent(agentId, force ?? true, paseo);
  });

  server.handle(togglePausedRpc, async ({ paused }) => {
    return { paused: service.togglePaused(paused) };
  });

  server.handle(testConnectionRpc, async (input) => {
    return testLlmConnection(input);
  });

  server.handle(watchWorkspaceSummariesSub, ({ workspaceId }, context) => {
    service.attachPaseo(context.paseo);
    service.addWorkspaceSubscriber({
      workspaceId,
      push: context.push,
      signal: context.signal,
    });
    void service
      .getWorkspacePayload(workspaceId, context.paseo)
      .then((payload) => {
        if (!context.signal.aborted) {
          return context.push(payload);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        console.error("[paseo-live-zh] initial workspace push failed:", error);
      });
  });

  return () => {
    stopSettings();
    stopTurnBefore();
    stopTurnAfter();
    stopPermBefore();
    stopPermAfter();
    stopArchive();
    stopClose();
    service.stop();
  };
}
