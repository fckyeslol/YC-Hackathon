import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Poll, Panelist, Vote, StoreSnapshot } from "./types.js";

/**
 * In-memory store with debounced JSON snapshotting. Chosen over SQLite to avoid
 * native builds on Windows; state is small and a single server owns it. Emits a
 * "change" event after every mutation so the SSE layer can push live updates.
 */
export class Store extends EventEmitter {
  private polls = new Map<string, Poll>();
  private panelists = new Map<string, Panelist>();
  private votes: Vote[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path = "data/store.json") {
    super();
    this.load();
  }

  // --- Polls ---

  createPoll(input: { prompt: string; options: string[]; groundTruth?: number }): Poll {
    const poll: Poll = {
      id: randomUUID(),
      prompt: input.prompt,
      options: [...input.options],
      status: "open",
      createdAt: new Date().toISOString(),
      ...(input.groundTruth !== undefined ? { groundTruth: input.groundTruth } : {}),
    };
    this.polls.set(poll.id, poll);
    this.touch();
    return poll;
  }

  getPoll(id: string): Poll | undefined {
    return this.polls.get(id);
  }

  listPolls(): Poll[] {
    return [...this.polls.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updatePoll(id: string, patch: Partial<Poll>): Poll {
    const existing = this.polls.get(id);
    if (!existing) throw new Error(`Poll ${id} not found`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.polls.set(id, updated);
    this.touch();
    return updated;
  }

  // --- Panelists ---

  addPanelist(input: Omit<Panelist, "id" | "createdAt">): Panelist {
    const panelist: Panelist = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.panelists.set(panelist.id, panelist);
    this.touch();
    return panelist;
  }

  updatePanelist(id: string, patch: Partial<Panelist>): Panelist {
    const existing = this.panelists.get(id);
    if (!existing) throw new Error(`Panelist ${id} not found`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.panelists.set(id, updated);
    this.touch();
    return updated;
  }

  getPanelist(id: string): Panelist | undefined {
    return this.panelists.get(id);
  }

  findPanelistByPhone(phone: string): Panelist | undefined {
    return [...this.panelists.values()].find((p) => p.phone === phone);
  }

  findPanelistByChat(chatId: string): Panelist | undefined {
    return [...this.panelists.values()].find((p) => p.chatId === chatId);
  }

  listPanelists(pollId?: string): Panelist[] {
    const all = [...this.panelists.values()];
    return pollId ? all.filter((p) => p.pollId === pollId) : all;
  }

  // --- Votes (latest per rater+poll wins) ---

  recordVote(vote: Vote): void {
    this.votes = this.votes.filter((v) => !(v.pollId === vote.pollId && v.raterId === vote.raterId));
    this.votes.push(vote);
    this.touch();
  }

  getVotes(pollId: string): Vote[] {
    return this.votes.filter((v) => v.pollId === pollId);
  }

  // --- Persistence + change notification ---

  private touch(): void {
    this.emit("change");
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 250);
  }

  private save(): void {
    const snapshot: StoreSnapshot = {
      polls: [...this.polls.values()],
      panelists: [...this.panelists.values()],
      votes: this.votes,
    };
    try {
      if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      console.error("[store] snapshot write failed:", err);
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as StoreSnapshot;
      for (const p of snapshot.polls ?? []) this.polls.set(p.id, p);
      for (const p of snapshot.panelists ?? []) this.panelists.set(p.id, p);
      this.votes = snapshot.votes ?? [];
    } catch (err) {
      // BR-A7: a parse error message can embed a snapshot fragment (incl. phones).
      // Log the error TYPE only, never the raw error/content.
      console.error("[store] snapshot load failed, starting empty:", err instanceof Error ? err.name : "unknown");
    }
  }
}
