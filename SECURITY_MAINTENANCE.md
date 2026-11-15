# Dependency security maintenance

Use Node.js 24. CI audits dependencies and builds the application.

Bun 1.3.14 remains the package manager. Run `bun install --frozen-lockfile`, `bun audit`, `bun x tsc --noEmit`, `bun run build`, and `bun test`. jsPDF 4 and Zod 4 replace vulnerable major versions. All existing schema/route tests and a real description PDF export regression test exercise the migrations. No remote AI provider is needed for these tests.
