// ============================================================================
// customer-after-sales.llm.demo.ts
// Cross-platform entry for real LLM mode.
// ============================================================================

(async () => {
  process.env.LLM_MODE = "real";
  await import("./customer-after-sales.demo");
})();
