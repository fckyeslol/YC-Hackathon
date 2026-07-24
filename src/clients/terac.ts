import { config } from "../config.js";

/** Subset of the Terac opportunity draft we use. See /docs/developers/reference/createOpportunity. */
export interface TeracTask {
  sequence: number;
  task_type: "interview" | "file_upload" | "activity";
  review_type: "auto_approve" | "manual_review" | "self_report";
  task_url: string;
  duration_minutes: number;
}

export interface CreateOpportunityInput {
  title: string;
  internal_title?: string;
  description?: string;
  project_id: string;
  num_participants: number;
  business_type: "b2c" | "b2b";
  tasks: TeracTask[];
  screening_questions?: unknown[];
  filters?: unknown[];
  device_types?: string[];
  expected_days_to_complete?: number;
}

export interface Opportunity {
  id: string;
  status: string;
  title: string;
  num_participants: number;
  pricing?: { cost_per_participant_cents: number; total_cost_cents: number; currency: string };
  links?: { self: string; launch: string; submissions: string };
  submission_stats?: {
    total: number;
    in_progress: number;
    awaiting_review: number;
    approved: number;
    rejected: number;
  };
}

export interface Submission {
  id: string;
  opportunity_id: string;
  status: "in_progress" | "awaiting_review" | "approved" | "rejected";
  participant_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * The CONTENT of a reviewer's submission (not just its status).
 * ⚠️ VERIFICAR: path and shape are assumed (spec terac-review BR-T9) — the live
 * POST/GET was never exercised (only GET org-context has been). Confirm against
 * the real API before marking the spec 🟢.
 */
export interface SubmissionAnswers {
  submission_id: string;
  participant_id: string;
  /** One entry per prompt the reviewer answered. `value` is the raw reviewer input. */
  responses: Array<{ prompt: string; value: string }>;
}

/** Typed wrapper over the Terac external API v2. */
export class TeracClient {
  constructor(
    private readonly apiKey = config.TERAC_API_KEY,
    private readonly base = config.TERAC_API_BASE,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Terac ${method} ${path} -> ${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getOrgContext(): Promise<{ organizationId: string; organizationName: string; balanceDollars: number }> {
    return this.request("GET", "/organizations/current/context");
  }

  async listProjects(): Promise<{ data: Array<{ id: string; name: string }> }> {
    return this.request("GET", "/projects");
  }

  async createProject(name: string): Promise<{ id: string; name: string }> {
    return this.request("POST", "/projects", { name });
  }

  /** Get an existing project by name or create it. */
  async ensureProject(name: string): Promise<string> {
    const { data } = await this.listProjects().catch(() => ({ data: [] as Array<{ id: string; name: string }> }));
    const existing = data.find((p) => p.name === name);
    if (existing) return existing.id;
    const created = await this.createProject(name);
    return created.id;
  }

  async createOpportunity(input: CreateOpportunityInput): Promise<Opportunity> {
    return this.request("POST", "/opportunities", input);
  }

  async launchOpportunity(id: string): Promise<Opportunity> {
    return this.request("POST", `/opportunities/${id}/launch`);
  }

  async getOpportunity(id: string): Promise<Opportunity> {
    return this.request("GET", `/opportunities/${id}`);
  }

  async listSubmissions(opportunityId: string, status?: Submission["status"]): Promise<{ data: Submission[] }> {
    const q = status ? `?status=${status}` : "";
    return this.request("GET", `/opportunities/${opportunityId}/submissions${q}`);
  }

  async approveSubmission(opportunityId: string, submissionId: string): Promise<void> {
    await this.request("POST", `/opportunities/${opportunityId}/submissions/${submissionId}/approve`);
  }

  /**
   * Fetch the CONTENT of a reviewer's submission (spec terac-review BR-T3).
   * `listSubmissions` only returns status; this returns what they actually said.
   * ⚠️ VERIFICAR: endpoint path + response shape assumed (BR-T9).
   */
  async getSubmissionAnswers(opportunityId: string, submissionId: string): Promise<SubmissionAnswers> {
    return this.request("GET", `/opportunities/${opportunityId}/submissions/${submissionId}/answers`);
  }

  async listFilters(): Promise<unknown> {
    return this.request("GET", "/filters");
  }
}

export const terac = new TeracClient();
