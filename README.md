# Verity

## Hosted student demo

The repository includes [Render Blueprint configuration](render.yaml) for one Docker web service and a free Key Value queue in Singapore. The database is a separate Neon project with pgvector enabled. Set the Blueprint's `DATABASE_URL` to Neon's direct PostgreSQL URL (including `sslmode=require`) and `GEMINI_API_KEY` to a Google AI Studio key when applying it. Both are private Render environment values. The hosted app uses Gemini for generation and `gemini-embedding-001` for retrieval embeddings, so it does not need Ollama. Google Scholar discovery stays optional through `SERPAPI_API_KEY`; OpenAlex and Crossref work without it.

The free Render Key Value plan does not persist Redis data after restart. PostgreSQL preserves investigations, and the app's queue reconciliation rebuilds unfinished jobs. A paid Key Value instance is recommended if the demo receives regular traffic. The web service and worker currently run together in one container, which suits a small portfolio demo. Watch the API health check and Gemini quotas after deployment.

Verity investigates a claim using scholarly sources and optional PDFs. A model proposes editable research questions. A durable worker retrieves source material, builds a hybrid search index, classifies passages, checks citations, and writes a source-linked report. Open **New investigation** to run the pipeline. The introductory TypeScript example is curated.

## Local development

Use Node.js 22.14+, Docker Compose, and Ollama. On this Mac the installed generation model is `gemma4:12b-mlx`. Set `OLLAMA_MODEL` in `.env` to a locally supported instruction model on other platforms. Start Ollama and install the configured models before investigating.

```sh
npm ci
npm run setup
docker compose up -d db redis
ollama pull all-minilm
ollama list
npm run dev
```

Ollama listens on port 11434. PostgreSQL with pgvector uses 55439 and Redis uses 56389. Open the address printed by Vite. To serve a compiled build run `npm run build && npm start` and open port 4173. To containerize the app on a host where the container can reach Ollama, run `docker compose --profile app up -d --build`. Named volumes preserve research and queued work across restarts. Set `COOKIE_SECURE=true` behind HTTPS.

Check the container at [Verity](http://127.0.0.1:4173/) or poll `GET /api/health` for database and queue readiness.

## Providers and evidence

Local mode uses Ollama for generation and embedding. To use Google's hosted Gemini generation API, set `AI_PROVIDER=gemini`, `GEMINI_API_KEY` and `GEMINI_MODEL` on the server. The configured provider receives the claim and selected passage text, including selected text from uploads. Embeddings use Ollama in both modes. OpenAlex and Crossref receive the scholarly search query. Optional provider settings are in `.env.example`.

To include Google Scholar in online investigations, set `SERPAPI_API_KEY` in the server's `.env`. Restart the development server, or run `docker compose --profile app up -d app` for the containerized app. SerpApi receives the scholarly search terms. The worker combines Scholar titles and links with OpenAlex and Crossref results, looks up available abstracts by DOI, and retrieves supported open full text. Reports cite passages from retrieved abstracts, full text or uploads. [SerpApi Google Scholar API](https://serpapi.com/google-scholar-api)

The worker records source access, full-text paragraphs where available through arXiv HTML or Europe PMC XML, indexed abstracts, and page numbers for uploaded PDF text. PDFs need a text layer. The browser extracts up to 60 pages per document. The worker indexes up to 90 chunks per source and 160 per run. PostgreSQL text search and vector distance rank passages for the claim and its questions. The model reranks up to 14 candidates for relevance and selects the top ten for evidence review. The worker falls back to hybrid order when reranking is unavailable. Each retained finding must contain a verbatim quote and pass a separate model entailment check. The final synopsis is checked again. Human edits invalidate the earlier synopsis and create a report revision.

The Evaluation page shows estimated generation API cost for each completed investigation. Set `GEMINI_INPUT_USD_PER_MTOK` and `GEMINI_OUTPUT_USD_PER_MTOK` for the configured Gemini model and billing tier. The estimate includes recorded retry responses, reasoning tokens, and the planning request when its plan is first used. Local Ollama has no generation API fee. Search credits, hosting and electricity are outside the estimate. [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

## Jobs, accounts, and persistence

Express exposes cookie-scoped guest workspaces and password-based accounts. Register from the workspace footer to retain the guest's reports under an email login. Server records are scoped to the authenticated identity. PostgreSQL stores reports, uploaded text, indexed chunks, model provenance, revisions and retrieval snapshots. Redis and BullMQ run the queue with retries, stalled-job recovery and a database outbox reconciliation loop. The worker is hosted in the server process and continues after the browser closes. Restarting the service resumes queued work. Local browser reports from the earlier viewer are available in guest mode.

## API

Use the same cookie jar across calls. Request and response bodies use JSON.

| Method | Path | Operation |
|---|---|---|
| GET | /api/account | Start guest session or get current account |
| GET | /api/health | Check database and queue readiness |
| POST | /api/account/register, /api/account/login, /api/account/logout | Manage account session |
| POST | /api/plan | Generate an editable plan or return HTTP 422 with a request to narrow the claim |
| POST | /api/research | Submit a claim alone for automatic planning, or an edited plan with uploads. Returns HTTP 202 |
| GET | /api/research | List owned sessions |
| GET | /api/research/:id | Retrieve a session and job status |
| GET | /api/research/:id/questions, /sources, /evidence, /report | Inspect research artifacts beneath the same session |
| GET | /api/research/:id/events | Stream status events |
| POST | /api/research/:id/stop, /retry | Stop or retry a run |
| GET | /api/research/:id/chunks/:chunkId | Inspect original retrieved context |
| PATCH | /api/research/:id/evidence/:evidenceId | Save a human review |
| GET | /api/evaluation | View run measurements and the benchmark |

## Evaluation

Run `npm test` for deterministic regression tests. With the local container running, `node scripts/check-service.mjs` exercises account ownership, job retry, inference, source grounding, report synthesis and human revision using a private synthetic workspace. Run `npm run evaluate` for measured hybrid retrieval across 50 controlled cases and live stance/citation checks on five supplied passages. Add `-- --full` to evaluate model output on all 50. The Evaluation page displays the saved benchmark and real investigation measurements.

Run `node --env-file=.env scripts/check-worker-recovery.mjs` with the local database and Redis running to verify recovery after killing a worker mid-investigation. This check starts its own worker and uses a separate queue with a deterministic model fixture.

The bundled fictional observations have explicit expected labels and never appear in user reports. They measure controlled behavior. A separate SciFact benchmark uses 50 independently annotated development claims from 50 distinct publications, balanced equally between support and contradiction. Retrieval is measured within this passage pool. The short run classifies ten annotated passages, five from each class. These measurements cover the reference set and do not measure accuracy over the open web.

To reproduce the SciFact measurements, download the official data archive, extract the selected records locally, and run the same evaluator. Results contain identifiers and scores. [SciFact research repository](https://github.com/allenai/scifact)

```sh
curl -fL https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz -o /tmp/verity-scifact.tar.gz
python3 evaluation/scifact.py /tmp/verity-scifact.tar.gz /tmp/verity-reference.json
npm run evaluate -- --dataset=/tmp/verity-reference.json --scifact
npm run evaluate -- --dataset=/tmp/verity-reference.json --scifact --compare-reranking
```

The comparison runs both ranking methods over the same candidate pool and records recall@3 for the first ten claims. Add `--full` to compare all cases.

Passage reviewers can also grade original AI findings in the workspace. Evaluation reports citation precision, unsupported finding rate and stance agreement over those judgments. To use a separately reviewed set, pass `-- --dataset=/absolute/path/cases.json --full`. Each row has a unique id, topic, claim, passage and expected stance (supports, contradicts, inconclusive or absent). Exact quote rate measures text alignment. It cannot establish semantic correctness by itself.
