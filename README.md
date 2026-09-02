# FreshLoop · AI Food Inventory & Meal Planning Assistant

Vanilla JavaScript + Vite mobile-first prototype for the 6203 group project. The app demonstrates the complete product loop:

`upload / manual retrieval → human review → inventory → daily recommendations / DIY → shopping gap → meal review`

## Run locally

```bash
npm install
npm run dev
```

Without Supabase, the app supports a local demo; its demonstration OTP is `123456` and data stays in the current browser's `localStorage`. Recipe generation, recipe translation and image recognition require the server-side `DEEPSEEK_API_KEY`; no template is substituted if that service fails. Manual storage guidance uses local reference data by default. Use **Profile → Reset demo data** to restore the seeded kitchen.

## Implementation status

- Done: four bottom tabs (Inventory / Recipe / Shopping / Profile) and responsive shell.
- Done: simplified split inventory view, five user-facing food categories, search and expiry-date sorting.
- Done: pink / blue / green expiry tiers (0–3 / 4–6 / 7+ days) without exposing internal management-mode names.
- Done: seeded kitchen with the three management modes and Use Soon priority cards.
- Done: social-style daily recommendation feed plus DIY planner returning four detailed recipes, split into two pantry-first and two low-gap ideas, with at most three core ingredients per dish, stocked-condiment preference, multi-turn follow-up, favorites and hard-constraint validation.
- Done: separate manual retrieval and image-upload recognition flows, editable confirmation table, storage-specific dates and package-date review.
- Done: expiry keep/delete prompt, purple expired state, inventory management, poetic hover notes and correct category/icon matching.
- Done: animated shopping completion, per-essential-item thresholds, editable constraints, meal schedule and three consumption-review modes.
- Done: phone registration/login with Supabase SMS OTP, first-login taste/onboarding flow, refrigerator/freezer temperature settings and profile persistence.
- Done: source-grounded storage retrieval that distinguishes ingredient form and preparation, exposes quality ranges/sources and refuses unknown generic freezer defaults.
- Done: recipe reference images with retained source metadata, beginner recipes with explicit oil/seasoning/heat/timing, and profile-aware DeepSeek prompts. Third-party image licences still require review before public release.
- Done: Chinese/English interface, cached translations of existing recipe names/descriptions/steps, English date picker, editable phone, explicit preference confirmation and up to six daily meal times.
- Done: persisted “今天想做” plans, scheduled make/skip confirmation, Twilio SMS adapter and a protected reminder-worker endpoint.
- Next: configure the production Supabase/Twilio/DeepSeek accounts and deployment scheduler.

## Milestones

1. Foundation and domain schemas (complete).
2. Inventory / profile / recipe shell (complete).
3. Remote persistence, phone auth, reminder jobs and server-side DeepSeek adapter (complete; requires deployment environment values).
4. Reproducible evaluation runner for the 20-case A/B/C comparison.
5. Deployment, demo reset endpoint and class presentation recording.

## Remote AI / Supabase path

Copy `.env.example` to `.env.local`. Public browser values are `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Keep `DEEPSEEK_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_AUTH_TOKEN` and `CRON_SECRET` server-side. Apply migrations `001` and `002`, enable a phone/SMS provider in Supabase Auth, and schedule `/api/run-reminders` with the cron secret. Image recognition and recipe generation use the server-side API routes. Set `VITE_REMOTE_STORAGE_GUIDANCE=true` in the deployment environment when remote storage retrieval should be enabled.

## Branches and deployment

- `main`: stable versions suitable for demos and production deployment.
- `dev`: ongoing integration work; merge into `main` only after tests and review pass.
- Create version tags such as `v0.1.0-demo` for important milestones so earlier releases remain easy to restore.
- Vercel should deploy production from `main`. Preview deployments can be enabled for `dev` and pull requests.
- Never commit `.env.local`; copy the required values into the deployment platform's environment-variable settings.

## Project structure

```text
src/
  data/demo.js       # seed profile and inventory
  data/ingredientKnowledge.js # curated local retrieval fallback
  state/store.js     # local persistence and reactive state
  services/ai.js     # server-side AI request boundary; explicit failure states
  services/auth.js   # Supabase phone OTP/profile persistence + reminder scheduling
  services/domain.js # validation, shopping gap and inventory rules
  main.js            # view shell and event wiring
  styles.css         # mobile-first responsive UI
supabase/
  migrations/       # PostgreSQL schema
  seed/              # demo data
server/api/          # server-side route contracts
tests/               # domain tests
```

## Product safety boundary

Freshness is an estimated quality / priority signal, not a food-safety certification. SFA/USDA source ranges, packaging, continuous temperature control and observed food condition are shown separately. Date calculation, hard-constraint validation, inventory updates and shopping gaps are deterministic responsibilities; the LLM does not write to inventory directly.
