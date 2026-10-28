import {
  reconcileAssistantHistory,
  reduceAssistantStream,
} from "../shared/assistant-stream.mjs";

// Stop paging without dropping either end of the rendered conversation.
// Live events still append; every update must keep pagination consistent.
export const MAX_HISTORY_EVENTS = 1600;

export function setHistoryEvents(state, events, hasMore = state.hasMore) {
  const live = state.liveAssistant?.[state.selectedId];
  const reconciled = reconcileAssistantHistory(events, live);
  state.events = reconciled.events;
  if (live !== reconciled.live)
    state.liveAssistant[state.selectedId] = reconciled.live;
  state.eventsRevision++;
  state.hasMore = !!hasMore && events.length < MAX_HISTORY_EVENTS;
}
export function setAssistantStream(state, id, frame) {
  const live = reduceAssistantStream(state.liveAssistant[id], frame);
  if (id !== state.selectedId) {
    state.liveAssistant[id] = live;
    return;
  }
  // A history read can finish before even the start frame reaches us.
  // Reconcile each frame so late chunks cannot resurrect a committed reply.
  const reconciled = reconcileAssistantHistory(state.events, live);
  state.liveAssistant[id] = reconciled.live;
  if (reconciled.events !== state.events)
    setHistoryEvents(state, reconciled.events);
}
