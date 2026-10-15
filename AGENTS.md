# Wave AI — AI Coding Agent Development Guidelines

> Scope: All code writing, modification, debugging, refactoring, and review tasks involving AI Agents in this repository.
>
> Core principle: **Solve real problems with the minimum amount of necessary code while maintaining correctness, clarity, and maintainability. Do not overengineer merely to make the code "look robust."**

## 1. Primary Principle: Simplicity First

1. **KISS / YAGNI**: Implement only the functionality explicitly required now. Do not build extensions for hypothetical future needs.
2. **Minimal changes**: Prefer modifying existing code. Do not refactor unrelated modules, rename numerous files, or introduce new architectural layers as a side effect.
3. **Do not abstract what can be expressed clearly and directly**: Prefer ordinary functions and existing utilities for simple logic. Do not add layers such as Service, Manager, Factory, Adapter, or Registry merely for the sake of convention.
4. **Reuse existing capabilities first**: Inspect installed dependencies, shared components, and existing implementations before building something from scratch.
5. **Readability over cleverness**: Explicit data flow, intuitive variable names, and concise business logic matter more than complex generics, implicit magic, or excessive encapsulation.
6. **Code volume is not the goal, but every piece of code must serve a purpose**: Prefer removing duplicate code, ineffective branches, and unnecessary state.

## 2. Before Making Changes

- Read the target files, their direct callers, relevant types, database models, and existing project conventions first.
- Distinguish **implemented code** from **planned designs** in `docs/`. Do not assume planned modules already exist.
- Identify the smallest complete flow for the change: **What is the input? → What is the core processing? → What is the output?**
- Follow the project's current technology stack and directory structure by default. Do not proactively replace frameworks or add dependencies.
- Do not predesign compatibility with legacy implementations, multiple cloud providers, multi-model routing, multiple storage backends, or plugin mechanisms unless the requirements explicitly call for them.

## 3. Boundary Validation and Error Handling

### Checks That Must Be Preserved

Perform necessary validation only at **genuine trust boundaries or data-integrity boundaries**, such as:

- HTTP request entry points: Validate request parameters using the existing Zod / Hono mechanisms.
- Identity and resource access: Authentication, user ownership, knowledge base isolation, and authorization checks.
- File uploads: File type, size, access permissions, and necessary security restrictions.
- Third-party APIs: Authentication configuration, explicit failure states, timeouts, and unavailable-service responses.
- Data persistence: Actual constraints such as uniqueness, foreign keys, directory cycles, deletion consistency, and cross-service state synchronization.

### Avoid Excessive Defensive Programming

- **Do not revalidate the same object at every function layer after it has already been validated by Zod.**
- Do not repeatedly check `null`, `undefined`, or types for data with well-defined types produced by controlled internal functions.
- Do not create extensive compatibility branches for missing fields, format variants, or third-party behavior without evidence that these cases actually occur.
- Do not wrap every `await` in its own `try/catch`. Catch errors only when you need to transform them, perform compensation, or recover the flow.
- Do not catch errors merely to log them, return empty arrays, fabricate successful results, or silently swallow failures.
- Do not provide fake, seemingly functional default values for required environment variables. Fail explicitly when they are missing.
- Do not stack multiple retry layers, timeout layers, fallback chains, or debouncing mechanisms just to "be safe."
- **Do not remove genuinely necessary validation.** Simplification means removing redundant and speculative defenses, not compromising security or data consistency.

**Decision rule**: Before adding a check, identify the **specific, realistic, reproducible, or contract-backed** problem it prevents. If you cannot explain that problem, do not add the check.

## 4. Abstraction and File Organization

- Prefer completing tasks within existing modules. Extract a module only when its responsibility is genuinely independent, its logic is sufficiently complex, or real reuse already exists.
- Do not create an extra utility file for two or three lines of logic with only one caller.
- Do not build layers that only forward arguments, or force code into Controller → Service → Repository → Adapter merely to make the architecture diagram look tidy.
- Business routes may call Services, but additional layers are warranted only when reuse, transactions, or complex business rules require them.
- Do not create an entire error-code system for a single error. Follow the existing centralized error-handling mechanism if one exists.
- Do not retain obsolete implementations, large blocks of commented-out code, compatibility functions with no callers, or placeholder implementations marked with TODOs.
- Comments should mainly explain **why** something is done, not restate what each line does. Explanatory comments are appropriate for complex concurrency, transaction, and security constraints.
- Respect existing naming, import style, Prettier, ESLint, and TypeScript conventions. Do not perform unrelated formatting changes.

## 5. TypeScript / React / Hono Constraints

### TypeScript

- Prefer type inference and reuse types provided by Zod, Prisma, Hono RPC, and AI SDK instead of defining the same structure multiple times.
- Avoid excessive use of `any`, non-null assertions, type casts, or convoluted type-level programming.
- After validating external input, rely on trusted type contracts within internal functions instead of parsing the input again at every layer.

### React / Next.js

- Calculate derived values directly. Do not introduce additional state plus `useEffect` for values that can be derived from props or state.
- Use `useMemo`, `useCallback`, and `React.memo` only when there is a genuine performance or reference-stability need, not as ceremonial optimizations.
- Continue using the existing TanStack Query setup for remote data. Use React state for local UI state and the project's existing Zustand patterns for UI state shared across components. Do not maintain duplicate state without justification.
- Prefer reusing existing components and shadcn/ui. Do not create a new component system for simple interactions.
- Do not modify third-party or generated foundational UI components arbitrarily.

### Hono / API

- Keep request validation, authentication context, business-function invocation, and response handling at the route layer. Avoid mixing core business logic with transport details.
- Use existing authentication middleware, Zod Validator, and error-handling conventions.
- Do not recreate response wrappers, HTTP client wrappers, or exception-conversion layers.
- Allow real failures to surface clearly. Do not conceal underlying failures with `{ success: true }`.

## 6. Wave AI-Specific Business Rules

### AI SDK / Agent

- Prefer native capabilities of the AI SDK version already installed in the repository. Do not manually reimplement streaming transport, message protocols, or tool-calling loops already provided by the SDK.
- Keep ordinary chat simple. Unless explicitly required, do not inject multi-agent orchestration, runtime state machines, recovery mechanisms, approval workflows, or a full Harness into the chat path.
- `docs/agent-deep-research-harness-plan.md` is an implementation reference, not a mandate to implement every design in it immediately.

### MinerU / OSS / Knowledge Base

- Keep the main workflow clear: **Upload source files to OSS → Parse with MinerU → Store content and metadata in PostgreSQL → Chunk / vectorize (when needed)**.
- Represent asynchronous parsing with explicit task states. Do not introduce unused task frameworks, multi-layer adapters, or complex schedulers prematurely.
- Third-party API errors must remain visible. Add limited retries only when **truly necessary and the operation is idempotent**.
- Do not store duplicate copies of the same document content or introduce a second parsing or vector-storage solution beyond current requirements.
- **Do not sacrifice data ownership, acyclic directory constraints, asynchronous task consistency, or reliable source-file cleanup in the name of simplification.** Verify the purpose of existing locks, transactions, and cleanup jobs before deciding whether they can be simplified.

## 7. Prohibited Patterns Commonly Generated by AI

Unless explicitly required and supported by a real need, do not:

1. Write placeholder classes, empty methods, extension points, or feature flags for future functionality.
2. Define multiple interface layers and abstract base classes for a single implementation.
3. Perform layer upon layer of defensive type checking on controlled internal data.
4. Wrap every function call in `try/catch`.
5. Automatically replace errors with `[]`, `null`, default objects, or fake successes.
6. Introduce logging systems, metrics systems, caching layers, retry frameworks, task queues, and other infrastructure all at once.
7. Add a dependency for work that existing project dependencies can already handle simply.
8. Turn business functions into complicated generic utilities solely to make the code "more reusable."
9. Write excessive line-by-line comments, duplicate documentation, or test boilerplate unrelated to the task.
10. Change global configuration, the database schema, lockfiles, or unrelated modules while implementing a small feature.

## 8. Priority Order for Code Changes

Consider the following order instead of adding code by default:

1. **Remove**: Eliminate ineffective logic, duplicate branches, obsolete code, and unused wrappers.
2. **Reuse**: Check whether existing functions, Hooks, components, or libraries can do the job directly.
3. **Simplify**: Reduce indirection so the main flow is easy to understand at a glance.
4. **Add**: Introduce new implementation only when the first three steps cannot satisfy the actual requirement.

When refactoring existing code, preserve externally observable behavior and data contracts. Before simplifying anything involving databases, authentication, file deletion, or concurrency semantics, identify and verify the relevant invariants.

## 9. Delivery and Verification

- Modify only files related to the current task. Do not run formatting commands that indiscriminately rewrite the entire repository.
- Prefer the project's existing commands: `npm run typecheck` and `npm run lint`; run `npm run build` when necessary.
- Run only test commands that actually exist. Do not claim that nonexistent tests have passed.
- For changes involving uploads, parsing, login, persistence, or deletion, verify at least the normal path and critical failure paths.
- Do not claim to have verified operations you did not actually execute.
- After completion, briefly explain: **what changed, what redundant code was removed, which checks were run, and what real risks remain**.
- If new complexity was unavoidable, explain the concrete reason. Do not justify it solely as "future extensibility."

## 10. Agent Pre-Change Checklist

- [ ] Is this the functionality the user actually requested now?
- [ ] Have I read and reused existing implementations?
- [ ] Is there duplicate logic that can simply be removed?
- [ ] Are boundary checks performed at the correct layer without duplication?
- [ ] Have I introduced unnecessary abstractions, state, or dependencies?
- [ ] Are authentication, data isolation, file security, and database consistency still protected?
- [ ] Have I modified only the necessary files and performed appropriate verification?

**Final execution rule: Correctness is the baseline; simplicity is the default. Do not make the one real case difficult to understand just to handle a hundred hypothetical cases.**
