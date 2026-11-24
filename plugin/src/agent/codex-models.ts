import type { CodexModelOption } from "../types.ts";
import { AcpClient, type AcpClientOpts } from "./acp.ts";

interface ModelPage {
  data: {
    id: string;
    displayName: string;
    description?: string;
    supportedReasoningEfforts: { reasoningEffort: string }[];
  }[];
  nextCursor?: string | null;
}

/** Use the same App Server catalog as codex-acp, without opening an ACP session or a Codex thread. */
export async function readCodexModels(opts: AcpClientOpts): Promise<CodexModelOption[]> {
  const client = await AcpClient.spawn(opts);
  try {
    await client.request("initialize", { clientInfo: { name: "zotero-agent", title: "Zotero Agent", version: "1" } });
    client.notify("initialized");
    const models = new Map<string, CodexModelOption>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ModelPage = await client.request("model/list", { cursor });
      for (const m of page.data) {
        models.set(m.id, {
          id: m.id,
          name: m.displayName || m.id,
          ...(m.description ? { description: m.description } : {}),
          levels: m.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        });
      }
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated model list cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  } catch (error) {
    const detail = client.stderrTail();
    if (detail && error instanceof Error && error.message.startsWith("agent exited")) {
      throw new Error(`${error.message}\n${detail}`, { cause: error });
    }
    throw error;
  } finally {
    await client.close();
  }
}
