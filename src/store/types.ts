/** Persisted domain model for Verdict. */

export type PollStatus = "open" | "closed";
export type PanelSource = "imessage" | "terac";
export type VoteChannel = "reply" | "tapback" | "terac";

/** A single judgment question posed to the panel. */
export interface Poll {
  readonly id: string;
  /** Human-facing question, e.g. "Is this claim true?" */
  readonly prompt: string;
  /** Ordered option labels; index = the Label used by the aggregator. */
  readonly options: readonly string[];
  status: PollStatus;
  readonly createdAt: string;
  /** The LLM's own answer + confidence — the "before" we compare against. */
  modelGuess?: { label: number; confidence: number; rationale?: string };
  /** Known correct answer index, when benchmarking accuracy. Optional. */
  groundTruth?: number;
  /** Linked Terac opportunity, once recruitment is launched. */
  teracOpportunityId?: string;
}

/** A panelist — a human answering, whether recruited via Terac or ad-hoc over iMessage. */
export interface Panelist {
  readonly id: string;
  readonly source: PanelSource;
  /** E.164 phone once known (from the inbound iMessage). */
  phone?: string;
  /** Linq chat id for this panelist. */
  chatId?: string;
  /** Terac submission id, when recruited via Terac. */
  teracSubmissionId?: string;
  /** Poll this panelist was assigned to. */
  pollId?: string;
  readonly createdAt: string;
}

/** One vote by one panelist on one poll. Latest vote per (poll,rater) wins. */
export interface Vote {
  readonly pollId: string;
  readonly raterId: string;
  readonly label: number;
  readonly channel: VoteChannel;
  readonly at: string;
}

export interface StoreSnapshot {
  polls: Poll[];
  panelists: Panelist[];
  votes: Vote[];
}
