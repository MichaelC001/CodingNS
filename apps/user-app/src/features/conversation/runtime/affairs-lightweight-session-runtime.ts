import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getAffairsLightweightSession,
  getAffairsLightweightSessionMessages,
  sendAffairsLightweightSessionMessageStream,
  startAffairsLightweightSessionStream,
  type AffairsLightweightSessionStreamEventDto,
  type AttachmentPayload,
  type HistoryMessageDto,
  type ProviderId,
  type SessionProviderConfigMode,
  type SessionSummaryDto
} from "../api/conversation-api";
import { t } from "../../../shared/i18n";
import {
  createPendingMessage,
  markPendingAsFailed,
  type SessionMessageViewModel
} from "./session-runtime-machine";

export type AffairsLightweightStreamingToolStatus = {
  label: string;
  detail: string | null;
  phase: "running" | "completed" | "failed";
};

export type AffairsLightweightRuntimeSnapshot = {
  session: SessionSummaryDto | null;
  messages: SessionMessageViewModel[];
  historyState: "loading" | "ready";
  sending: boolean;
  streamingToolStatus: AffairsLightweightStreamingToolStatus | null;
};

export type AffairsLightweightRuntimeTurnOptions = {
  clientRequestId?: string;
  model?: string | null;
  reasoningLevel?: string | null;
  providerConfigMode?: SessionProviderConfigMode;
  providerPresetId?: string | null;
  attachments?: AttachmentPayload[];
};

export type AffairsLightweightRuntimeStartOptions = AffairsLightweightRuntimeTurnOptions & {
  provider: ProviderId;
  parentSessionId?: string | null;
  anchorMessageId?: string | null;
};

const EMPTY_MESSAGES: HistoryMessageDto[] = [];

export function createAffairsLightweightRuntimeSnapshot(input?: Partial<AffairsLightweightRuntimeSnapshot>): AffairsLightweightRuntimeSnapshot {
  return {
    session: input?.session ?? null,
    messages: input?.messages ?? [],
    historyState: input?.historyState ?? "loading",
    sending: input?.sending ?? false,
    streamingToolStatus: input?.streamingToolStatus ?? null
  };
}

export function createLightweightStreamingAssistantPlaceholder(sessionId: string, clientRequestId: string): SessionMessageViewModel {
  return {
    id: `lightweight-streaming-assistant-${clientRequestId}`,
    sessionId,
    role: "assistant",
    kind: "text",
    content: "",
    toolCall: null,
    attachments: [],
    attachmentPayloads: null,
    origin: null,
    originRef: null,
    timestamp: new Date().toISOString(),
    sequence: Number.MAX_SAFE_INTEGER,
    rawRef: `pending://assistant/${clientRequestId}`,
    deliveryState: "sending",
    clientRequestId
  };
}

function toLightweightMessage(message: HistoryMessageDto, sessionId: string): SessionMessageViewModel {
  return {
    id: message.messageId,
    sessionId,
    role: message.role,
    kind: message.kind ?? (message.role === "tool" ? "tool_result" : "text"),
    content: message.content,
    toolCall: message.toolCall ?? null,
    attachments: message.attachments ?? [],
    attachmentPayloads: message.attachmentPayloads ?? null,
    origin: message.origin ?? null,
    originRef: message.originRef ?? null,
    timestamp: message.timestamp,
    sequence: message.sequence,
    rawRef: message.rawRef,
    deliveryState: "sent",
    clientRequestId: null
  };
}

export function appendLightweightStreamingAssistantDelta(
  current: SessionMessageViewModel[],
  sessionId: string,
  clientRequestId: string,
  delta: string
): SessionMessageViewModel[] {
  if (!delta) {
    return current;
  }

  const placeholderId = `lightweight-streaming-assistant-${clientRequestId}`;
  const next = current.map((message) => message.id === placeholderId
    ? { ...message, content: `${message.content}${delta}` }
    : message);
  if (next.some((message) => message.id === placeholderId)) {
    return next;
  }

  return [...current, { ...createLightweightStreamingAssistantPlaceholder(sessionId, clientRequestId), content: delta }];
}

export function createAffairsLightweightToolStatus(toolName: string, detail: string | null, status: string): AffairsLightweightStreamingToolStatus {
  return {
    label: toolName === "web_search" ? t("conversation.toolWebSearch") : toolName,
    detail,
    phase: status === "completed" ? "completed" : status === "failed" ? "failed" : "running"
  };
}

export function upsertAffairsLightweightToolMessage(
  current: SessionMessageViewModel[],
  input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    status: "running" | "completed" | "failed";
    detail: string | null;
    toolInput: string | null;
    toolOutput: string | null;
  }
): SessionMessageViewModel[] {
  const messageId = `lightweight-tool-${input.toolCallId}`;
  const assistantIndex = current.findIndex((message) => message.id.startsWith("lightweight-streaming-assistant-"));
  const insertIndex = assistantIndex >= 0 ? assistantIndex : current.length;
  const nextMessage: SessionMessageViewModel = {
    id: messageId,
    sessionId: input.sessionId,
    role: "tool",
    kind: input.status === "running" ? "tool_call" : "tool_result",
    content: input.detail?.trim() || input.toolOutput?.trim() || input.toolInput?.trim() || input.toolName,
    toolCall: {
      callId: input.toolCallId,
      name: input.toolName,
      input: input.toolInput ?? "",
      output: input.toolOutput,
      error: input.status === "failed" ? (input.detail ?? input.toolOutput ?? null) : null,
      status: input.status
    },
    attachments: [],
    attachmentPayloads: null,
    origin: null,
    originRef: null,
    timestamp: new Date().toISOString(),
    sequence: insertIndex,
    rawRef: `lightweight-tool://${input.toolCallId}`,
    deliveryState: "sent",
    clientRequestId: null
  };
  const existingIndex = current.findIndex((message) => message.toolCall?.callId === input.toolCallId || message.id === messageId);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = {
      ...next[existingIndex],
      ...nextMessage,
      timestamp: next[existingIndex].timestamp,
      sequence: next[existingIndex].sequence,
      rawRef: next[existingIndex].rawRef
    };
    return next;
  }
  return [...current.slice(0, insertIndex), nextMessage, ...current.slice(insertIndex)];
}

function createClientRequestId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useAffairsLightweightSessionRuntime(input: {
  workspaceId: string;
  sessionId: string | null;
  externalSession?: SessionSummaryDto | null;
  targetHostId?: string | null;
  enabled?: boolean;
  onSessionUpdated?: (session: SessionSummaryDto) => void;
}) {
  const enabled = input.enabled ?? true;
  const [snapshot, setSnapshot] = useState<AffairsLightweightRuntimeSnapshot>(() => createAffairsLightweightRuntimeSnapshot({
    session: input.externalSession ?? null,
    historyState: input.sessionId ? "loading" : "ready"
  }));
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const activeSessionId = input.sessionId?.trim() || null;
  const externalSessionId = input.externalSession?.sessionId ?? null;

  useEffect(() => {
    if (!enabled || !activeSessionId) {
      setSnapshot(createAffairsLightweightRuntimeSnapshot({ session: input.externalSession ?? null, historyState: "ready" }));
      return;
    }

    const controller = new AbortController();
    setSnapshot((current) => current.session?.sessionId === activeSessionId
      ? { ...current, session: input.externalSession ?? current.session, historyState: "loading" }
      : createAffairsLightweightRuntimeSnapshot({ session: input.externalSession ?? null, historyState: "loading" }));
    const sessionRequest = input.externalSession
      ? Promise.resolve(input.externalSession)
      : getAffairsLightweightSession(input.workspaceId, activeSessionId, {
          targetHostId: input.targetHostId,
          signal: controller.signal
        });
    void Promise.all([
      sessionRequest,
      getAffairsLightweightSessionMessages(input.workspaceId, activeSessionId, {
        targetHostId: input.targetHostId,
        signal: controller.signal
      })
    ]).then(([session, history]) => {
      if (controller.signal.aborted) return;
      setSnapshot((current) => ({
        ...current,
        session,
        messages: history.messages.length > 0
          ? history.messages.map((message) => toLightweightMessage(message, activeSessionId))
          : current.messages,
        historyState: "ready"
      }));
    }).catch(() => {
      if (!controller.signal.aborted) {
        setSnapshot((current) => ({ ...current, historyState: "ready" }));
      }
    });

    return () => controller.abort();
  }, [activeSessionId, enabled, externalSessionId, input.targetHostId, input.workspaceId]);

  useEffect(() => () => {
    activeStreamControllerRef.current?.abort();
    activeStreamControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      activeStreamControllerRef.current?.abort();
      activeStreamControllerRef.current = null;
    }
  }, [enabled]);

  const applyEvent = useCallback((event: AffairsLightweightSessionStreamEventDto, clientRequestId: string, fallbackSessionId: string) => {
    if (event.type === "started") {
      setSnapshot((current) => ({
        ...current,
        session: event.session,
        historyState: "ready",
        sending: true
      }));
      input.onSessionUpdated?.(event.session);
      return;
    }
    if (event.type === "delta") {
      setSnapshot((current) => ({
        ...current,
        messages: appendLightweightStreamingAssistantDelta(current.messages, current.session?.sessionId ?? fallbackSessionId, clientRequestId, event.delta)
      }));
      return;
    }
    if (event.type === "tool") {
      setSnapshot((current) => ({
        ...current,
        messages: upsertAffairsLightweightToolMessage(current.messages, {
          sessionId: current.session?.sessionId ?? fallbackSessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.status,
          detail: event.detail,
          toolInput: event.input,
          toolOutput: event.output
        }),
        streamingToolStatus: createAffairsLightweightToolStatus(event.toolName, event.detail, event.status)
      }));
    }
  }, [input.onSessionUpdated]);

  const start = useCallback(async (content: string, options: AffairsLightweightRuntimeStartOptions) => {
    const clientRequestId = options.clientRequestId ?? createClientRequestId("lightweight");
    const controller = new AbortController();
    activeStreamControllerRef.current = controller;
    const fallbackSessionId = `pending-${clientRequestId}`;
    setSnapshot((current) => ({
      ...current,
      historyState: "ready",
      sending: true,
      streamingToolStatus: null,
      messages: [
        ...current.messages,
        createPendingMessage(fallbackSessionId, content, clientRequestId, [], options.attachments ?? []),
        createLightweightStreamingAssistantPlaceholder(fallbackSessionId, clientRequestId)
      ]
    }));
    try {
      const result = await startAffairsLightweightSessionStream(input.workspaceId, {
        sourceWorkspaceId: input.workspaceId,
        parentSessionId: options.parentSessionId ?? null,
        anchorMessageId: options.anchorMessageId ?? null,
        provider: options.provider,
        content,
        clientRequestId,
        model: options.model ?? null,
        reasoningLevel: options.reasoningLevel ?? null,
        attachments: options.attachments ?? [],
        providerConfigMode: options.providerConfigMode,
        providerPresetId: options.providerPresetId ?? null
      }, (event) => {
        if (!controller.signal.aborted) applyEvent(event, clientRequestId, fallbackSessionId);
      }, {
        targetHostId: input.targetHostId,
        signal: controller.signal
      });
      setSnapshot((current) => ({
        session: result.session,
        messages: result.messages.length > 0
          ? result.messages.map((message) => toLightweightMessage(message, result.session.sessionId))
          : current.messages.map((message) => message.sessionId === fallbackSessionId
            ? { ...message, sessionId: result.session.sessionId }
            : message),
        historyState: "ready",
        sending: false,
        streamingToolStatus: null
      }));
      input.onSessionUpdated?.(result.session);
      return result;
    } catch (error) {
      if (!controller.signal.aborted) {
        setSnapshot((current) => ({
          ...current,
          messages: markPendingAsFailed(current.messages, clientRequestId),
          sending: false,
          streamingToolStatus: current.streamingToolStatus
            ? { ...current.streamingToolStatus, phase: "failed" }
            : null
        }));
      }
      throw error;
    } finally {
      if (activeStreamControllerRef.current === controller) {
        activeStreamControllerRef.current = null;
      }
    }
  }, [applyEvent, input.onSessionUpdated, input.targetHostId, input.workspaceId]);

  const send = useCallback(async (content: string, options: AffairsLightweightRuntimeTurnOptions = {}) => {
    if (!activeSessionId) {
      throw new Error("Lightweight session is not selected");
    }
    const clientRequestId = options.clientRequestId ?? createClientRequestId("lightweight-follow-up");
    const controller = new AbortController();
    activeStreamControllerRef.current = controller;
    setSnapshot((current) => ({
      ...current,
      sending: true,
      streamingToolStatus: null,
      messages: [
        ...current.messages,
        createPendingMessage(activeSessionId, content, clientRequestId, [], options.attachments ?? []),
        createLightweightStreamingAssistantPlaceholder(activeSessionId, clientRequestId)
      ]
    }));
    try {
      const result = await sendAffairsLightweightSessionMessageStream(input.workspaceId, activeSessionId, {
        sourceWorkspaceId: input.workspaceId,
        content,
        clientRequestId,
        model: options.model ?? null,
        reasoningLevel: options.reasoningLevel ?? null,
        attachments: options.attachments ?? [],
        providerConfigMode: options.providerConfigMode,
        providerPresetId: options.providerPresetId ?? null
      }, (event) => {
        if (!controller.signal.aborted) applyEvent(event, clientRequestId, activeSessionId);
      }, {
        targetHostId: input.targetHostId,
        signal: controller.signal
      });
      setSnapshot((current) => ({
        session: result.session,
        messages: result.messages.length > 0
          ? result.messages.map((message) => toLightweightMessage(message, activeSessionId))
          : current.messages,
        historyState: "ready",
        sending: false,
        streamingToolStatus: null
      }));
      input.onSessionUpdated?.(result.session);
      return result;
    } catch (error) {
      if (!controller.signal.aborted) {
        setSnapshot((current) => ({
          ...current,
          messages: markPendingAsFailed(current.messages, clientRequestId),
          sending: false,
          streamingToolStatus: current.streamingToolStatus
            ? { ...current.streamingToolStatus, phase: "failed" }
            : null
        }));
      }
      throw error;
    } finally {
      if (activeStreamControllerRef.current === controller) {
        activeStreamControllerRef.current = null;
      }
    }
  }, [activeSessionId, applyEvent, input.onSessionUpdated, input.targetHostId, input.workspaceId]);

  return useMemo(() => ({
    ...snapshot,
    start,
    send,
    abort: () => activeStreamControllerRef.current?.abort()
  }), [send, snapshot, start]);
}
