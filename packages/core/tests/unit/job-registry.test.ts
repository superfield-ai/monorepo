import { describe, it, expect } from "vitest";
import {
  resolveJobCandidates,
  type JobSpec,
  type TierTable,
} from "../../job-registry.ts";
import { MODEL_TIER_MAPPING, ModelTier } from "../../models.ts";

describe("resolveJobCandidates", () => {
  describe("built-in defaults", () => {
    it("dev — preferred is claude/sonnet", () => {
      const candidates = resolveJobCandidates("dev");
      expect(candidates[0]).toEqual({
        backend: "claude",
        model: MODEL_TIER_MAPPING.claude[ModelTier.MEDIUM],
      });
    });

    it("dev — second candidate is codex medium", () => {
      const candidates = resolveJobCandidates("dev");
      expect(candidates[1]).toEqual({
        backend: "codex",
        model: MODEL_TIER_MAPPING.codex[ModelTier.MEDIUM],
      });
    });

    it("dev — expands thinking-medium into all three backends", () => {
      const candidates = resolveJobCandidates("dev");
      const backends = candidates.map((c) => c.backend);
      expect(backends).toContain("opencode");
    });

    it("plan — preferred is claude/opus", () => {
      const candidates = resolveJobCandidates("plan");
      expect(candidates[0]).toEqual({
        backend: "claude",
        model: MODEL_TIER_MAPPING.claude[ModelTier.HIGH],
      });
    });

    it("plan — second candidate is codex high", () => {
      const candidates = resolveJobCandidates("plan");
      expect(candidates[1]).toEqual({
        backend: "codex",
        model: MODEL_TIER_MAPPING.codex[ModelTier.HIGH],
      });
    });

    it("issue-audit — preferred is claude/haiku", () => {
      const candidates = resolveJobCandidates("issue-audit");
      expect(candidates[0]).toEqual({
        backend: "claude",
        model: MODEL_TIER_MAPPING.claude[ModelTier.LOW],
      });
    });

    it("all job types resolve without throwing", () => {
      const types = [
        "dev",
        "dev-scout",
        "ci-failure",
        "plan",
        "feature-evaluate",
        "issue-audit",
        "blueprint-conformance",
        "doc-coverage",
        "doc-canonical-sync",
        "doc-consistency",
        "pre-pr-self-audit",
      ] as const;

      for (const type of types) {
        expect(() => resolveJobCandidates(type)).not.toThrow();
        expect(resolveJobCandidates(type).length).toBeGreaterThan(0);
      }
    });
  });

  describe("deduplication", () => {
    it("removes duplicate (backend, model) pairs, keeping first occurrence", () => {
      // The preferred claude/sonnet will also appear in the thinking-medium expansion.
      // Dedup should keep only the first occurrence.
      const candidates = resolveJobCandidates("dev");
      const claudeSonnetCount = candidates.filter(
        (c) =>
          c.backend === "claude" &&
          c.model === MODEL_TIER_MAPPING.claude[ModelTier.MEDIUM],
      ).length;
      expect(claudeSonnetCount).toBe(1);
    });
  });

  describe("job overrides", () => {
    it("replaces the built-in spec when a job override is provided", () => {
      const override: JobSpec = {
        preferred: { backend: "codex", tier: ModelTier.HIGH },
        failovers: [],
      };
      const candidates = resolveJobCandidates("dev", { dev: override });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual({
        backend: "codex",
        model: MODEL_TIER_MAPPING.codex[ModelTier.HIGH],
      });
    });

    it("does not affect other job types when one is overridden", () => {
      const override: JobSpec = {
        preferred: { backend: "codex", tier: ModelTier.HIGH },
        failovers: [],
      };
      const devCandidates = resolveJobCandidates("dev", { dev: override });
      const planCandidates = resolveJobCandidates("plan", { dev: override });
      // plan should still use the built-in claude/opus preferred
      expect(planCandidates[0]?.backend).toBe("claude");
      expect(devCandidates[0]?.backend).toBe("codex");
    });
  });

  describe("tier table overrides", () => {
    it("expands an overridden abstract tier name", () => {
      const tierOverrides: TierTable = {
        "thinking-medium": [
          { backend: "opencode", model: "opencode/custom-model" },
        ],
      };
      const candidates = resolveJobCandidates("dev", {}, tierOverrides);
      // thinking-medium should expand to just the custom entry
      const opencodeEntry = candidates.find(
        (c) => c.backend === "opencode" && c.model === "opencode/custom-model",
      );
      expect(opencodeEntry).toBeDefined();
    });

    it("does not affect tiers that are not overridden", () => {
      const tierOverrides: TierTable = {
        "thinking-low": [{ backend: "opencode", model: "opencode/cheap" }],
      };
      // plan uses thinking-high — should be unaffected
      const candidates = resolveJobCandidates("plan", {}, tierOverrides);
      expect(candidates[0]).toEqual({
        backend: "claude",
        model: MODEL_TIER_MAPPING.claude[ModelTier.HIGH],
      });
    });
  });

  describe("abstract tier expansion order", () => {
    it("coding-medium leads with codex", () => {
      // coding-medium puts codex first
      const override: JobSpec = {
        preferred: { backend: "claude", tier: ModelTier.MEDIUM },
        failovers: ["coding-medium"],
      };
      const candidates = resolveJobCandidates("dev", { dev: override });
      // After preferred (claude/sonnet), next non-duplicate should be codex
      const afterPreferred = candidates.slice(1);
      expect(afterPreferred[0]?.backend).toBe("codex");
    });
  });
});
