// 知识库域 RPC（2026-11-16 第三批）：kb.* 四件。
import type { KnowledgeStore } from "../knowledge";

export interface KbRpcDeps {
  knowledge: Pick<KnowledgeStore, "backend" | "search" | "list" | "read" | "reindex" | "stats">;
}

export interface KbRpc {
  search(params: unknown): unknown;
  list(): unknown;
  read(params: unknown): unknown;
  reindex(): unknown;
}

export function createKbRpc(deps: KbRpcDeps): KbRpc {
  const { knowledge } = deps;
  return {
    search(params: unknown): unknown {
      const { q, limit } = (params ?? {}) as { q: string; limit?: number };
      const { hits, error } = knowledge.search(String(q ?? ""), Math.min(50, Math.max(1, Number(limit ?? 8))));
      return { hits, ...(error ? { error } : {}) };
    },

    list(): unknown {
      return { docs: knowledge.list(), backend: knowledge.backend };
    },

    read(params: unknown): unknown {
      const { file } = params as { file: string };
      const doc = knowledge.read(String(file));
      if (!doc) return { ok: false, error: `文档不存在：${file}` };
      return { ok: true, title: doc.title, body: doc.body };
    },

    reindex(): unknown {
      const { indexed, removed } = knowledge.reindex();
      const st = knowledge.stats();
      return { indexed, removed, docs: st.docs, dbBytes: st.dbBytes };
    },
  };
}
