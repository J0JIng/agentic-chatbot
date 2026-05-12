import { getChatGraph } from "./chatGraph";
import { log } from "@/lib/logger";

let graphInitialised = false;

/** Compiles and caches the LangGraph StateGraph on first call; no-ops on subsequent calls. */
export async function initialiseAllAgents() {
  if (graphInitialised) {
    log({ level: "info", node: "agentSetup", message: "Chat graph already initialised, using cache" });
    return;
  }

  try {
    log({ level: "info", node: "agentSetup", message: "Initialising chat graph" });
    getChatGraph();
    graphInitialised = true;
    log({ level: "info", node: "agentSetup", message: "Chat graph initialised successfully" });
  } catch (error) {
    log({ level: "error", node: "agentSetup", message: "Failed to initialise chat graph", error: String(error) });
    throw error;
  }
}

/** Returns the compiled StateGraph, initialising it first if needed. */
export async function getAgents() {
  if (!graphInitialised) await initialiseAllAgents();
  return { graph: getChatGraph() };
}

/** Returns the compiled StateGraph. */
export async function getAgent(name: string) {
  return getChatGraph();
}
