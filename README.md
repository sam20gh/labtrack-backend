# LabTrack — backend API

Express 4 + Mongoose 8 REST API for LabTrack, backed by MongoDB Atlas. Deployed on Render
at `https://labtrack-backend.onrender.com`, auto-deploying on push to `main`.

The mobile client lives in a separate repo: `github.com/sam20gh/labtrack-frontend`.

## Setup

```bash
npm install
cp .env.example .env      # fill in real values
npm start                 # node index.js — listens on PORT or 5002
```

A healthy boot prints `✅ MongoDB Atlas connected successfully`. Missing or invalid Mongo
credentials call `process.exit(1)` — the server never starts in a degraded state.

There is no test suite and no lint config. `node --check <file>` is the only static check.

## Environment

See [`.env.example`](.env.example) for the annotated list.

| Variable | Purpose |
|---|---|
| `MONGO_USERNAME` / `MONGO_PASSWORD` / `MONGO_CLUSTER_URL` / `MONGO_DB_NAME` | Atlas connection parts, assembled by `config/db.js` |
| `MONGO_URI` | Full URI; takes precedence over the four above |
| `SECRET_KEY` | Signs **and** verifies legacy JWTs (users and professionals) |
| `SUPABASE_URL` | Supabase project URL — JWKS discovery for access-token verification |
| `SUPABASE_JWT_SECRET` | Supabase shared JWT secret (HS256 projects) |
| `LEGACY_AUTH_DISABLED` | `true` retires legacy SECRET_KEY tokens once all clients use Supabase |
| `OPENAI_API_KEY` | DeepSeek API key (the OpenAI SDK reads this name) |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Cloudflare Images uploads |
| `PORT` | Optional, defaults to 5002 |

## Layout

```
index.js                 Mounts nine routers under /api/*
config/db.js             Atlas connection
middleware/
  authMiddleware.js      Bearer verification against SECRET_KEY
models/
  userModel.js           User + the large embedded healthAssessment subdocument
  testResultModel.js     TestResult
  AIFeedback.js          Cached model output, keyed by testID
  Plan.js                Generated health plan (structured_plan + flattened timeline)
  Product.js             Purchasable tests
  Professional.js        Practitioners; speciality is a 48-value enum
controllers/             One file per resource; named async exports, try/catch throughout
routes/                  Thin routers, auth applied per-route
utils/
  feedbackParser.js      Keyword extraction from AI text → structured health plan
  planGenerator.js       Matches the plan to Products and Professionals, builds the timeline
uploads/                 Multer temp dir for image uploads
```

## Endpoints

Full reference with auth requirements and payload shapes: `docs/API.md` in the LabTrack
workspace directory that contains this repo.

| Router | Auth |
|---|---|
| `/api/users` | Bearer, except `POST /signup` and `POST /login` |
| `/api/interpretation`, `/api/biomarkers`, `/api/plan-items`, `/api/plans`, `/api/products`, `/api/dna-reports`, `/api/orders`, `/api/appointments`, `/api/reports`, `/api/payments`, `/api/notifications` | Bearer |
| `/api/test-results` | Bearer, and the `user_id` must be the caller |
| `/api/reviews` | Bearer, `professional` or `admin` role only |
| `/api/professionals`, `/api/deepseek`, `/api/images`, `/api/auth` | **none** |

## AI pipeline

1. `GET /api/interpretation/latest` — the person's most recent interpretation, whatever
   document it came from, plus their newest result. One call; this is what the home screen reads.
2. `POST /api/interpretation/generate` — `utils/interpretationEngine.js` calls Claude Opus 5
   with a structured-output schema. The prompt carries the whole person: profile, every DNA
   variant, every biomarker with its dated series, and the previous interpretation so the new
   one can be written as a delta. Cached by source id unless `force: true`.
3. `utils/planGeneratorV2.regeneratePlan()` turns the structured output into dated `PlanItem`
   rows. **Whole-person scoped** — it clears every `source: 'ai'` item for the user before
   inserting, so it must only ever be handed a whole-person interpretation. `source: 'specialist'`
   items are spared, which is what protects clinician-ordered follow-ups.

`utils/interpretationSchema.js` is the output contract: specialities are constrained to the
`Professional.speciality` enum, so an unmatchable value cannot be produced. To recognise a new
marker, make sure a matching `Product` name or `Professional.speciality` **enum value** exists — unmatched items
are dropped silently.

## Known issues

Several verified defects affect this service, including unauthenticated CRUD on
`/api/professionals` (which also returns password hashes), an unauthenticated
`/api/deepseek`, missing ownership checks on protected routes, and speciality strings in
`feedbackParser.js` that match no enum value. See `docs/KNOWN-ISSUES.md` in the workspace
directory before working on auth or the plan generator.
