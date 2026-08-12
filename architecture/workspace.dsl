workspace {
    name "CityScroll architecture"
    description "Canonical C4 model for CityScroll. ARCHITECTURE.md is the narrative companion; this file is the machine-readable model."

    model {
        visitor = person "Visitor" "Reads CityScroll public records and follows supported actions."
        site_operator = person "Site operator" "Operates keyed administrative and spend views."
        ai_assistant = person "AI assistant" "Uses the metered MCP surface for search, record retrieval, and watch actions."

        cityscroll = softwareSystem "CityScroll" "A precompute-first public-record reader for New York City civic information." {
            browser_site = container "Browser site" "Static markup, styles, committed read models, and browser-native modules." "Static site / vanilla JavaScript"
            worker_api = container "Cloudflare Worker" "HTTP, scheduled, email, and queue handlers for edge reads, stateful features, ingestion, and delivery." "Cloudflare Workers / Web APIs"
            warehouse_factory = container "Warehouse factory" "Host-side bounded ingestion, DuckDB and Parquet batch joins, fixtures, and proof receipts." "Python / DuckDB / Parquet"
            materialization_tools = container "Build and materialization tooling" "Builders and pure seams that export compact read models for the site and Worker." "Node.js / repository tools"
            entity_resolution = container "Entity resolution" "In-process normalize, candidate, score, policy, review, and publication package; links sources without merging them." "JavaScript module"
            ontology_registry = container "Civic Graph ontology" "Backstage object, link, event, assertion, action, grounding, and improvement-flywheel catalog." "JavaScript module / JSON registry"

            d1_notices = container "D1 notice mirror" "Recent City Record notices, full-text search, ingest cursors, and durable workflow tables." "Cloudflare D1" {
                tags "Database"
            }
            kv_nl_meter = container "NL meter KV" "Metering state for natural-language features." "Cloudflare Workers KV" {
                tags "Database"
            }
            kv_alert_state = container "Alert and read-model KV" "Digest state, counters, forecasts, and versioned edge read models." "Cloudflare Workers KV" {
                tags "Database"
            }
            kv_subs = container "Subscription KV" "Confirmed subscriptions, rate limits, and investigation snapshots." "Cloudflare Workers KV" {
                tags "Database"
            }
            kv_feedback = container "Feedback KV" "Stored feedback rows and feedback rate-limit counters." "Cloudflare Workers KV" {
                tags "Database"
            }
            digest_queue = container "Digest queue" "Per-subscription digest jobs with retries and a dead-letter queue." "Cloudflare Queue"
            analytics_engine = container "Usage analytics" "Bounded aggregate page, click, and search events without visitor identifiers." "Cloudflare Analytics Engine" {
                tags "Database"
            }
            r2_source_vault = container "R2 source vault" "Reserved source-document custody seam; inactive because SOURCE_VAULT_ENABLED is false and its binding is commented out." "Cloudflare R2 (planned / disabled)" {
                tags "Database,Inactive"
            }
        }

        public_sources = softwareSystem "NYC public data sources" "City Record, Socrata, DCAS, Legistar, ZAP, geospatial, DOB, and other publisher feeds named by the source contracts and architecture narrative."
        checkbook = softwareSystem "Checkbook NYC" "Public contract, payment, and contract-term source used for bounded lookups and lifecycle joins."
        passport = softwareSystem "PASSPort Public" "Public procurement contract and solicitation source used by the Worker ingest path."
        anthropic = softwareSystem "Anthropic" "External model provider for the metered natural-language route."
        resend = softwareSystem "Resend" "External email delivery provider for confirmed digest messages."

        visitor -> browser_site "Reads public records and record documents [ARCHITECTURE.md:21]" "HTTPS"
        site_operator -> worker_api "Uses keyed operator and spend routes [docs/architecture.md:142-146]" "HTTPS"
        ai_assistant -> worker_api "Uses the metered MCP endpoint [docs/architecture.md:126-128]" "HTTPS"

        browser_site -> worker_api "Calls edge-cached, parameterized, stateful, or secret-backed features [ARCHITECTURE.md:21-23]" "HTTPS"
        browser_site -> public_sources "Reads selected live or hybrid public and geospatial views [ARCHITECTURE.md:21]" "HTTPS"

        worker_api -> public_sources "Ingests and serves source-backed civic records [worker/src/worker.mjs:79-154; worker/src/ingest.mjs:1]" "HTTPS / source contracts"
        worker_api -> checkbook "Proxies Checkbook lookups and joins contract lifecycle data [ARCHITECTURE.md:23; docs/architecture.md:177]" "HTTPS"
        worker_api -> passport "Refreshes PASSPort Public contracts and RFx data during the scheduled path [worker/src/worker.mjs:234-240]" "HTTPS"
        worker_api -> anthropic "Uses the model provider for the metered natural-language route [docs/architecture.md:126]" "HTTPS"
        worker_api -> resend "Sends confirmed digest email through the configured provider [docs/architecture.md:150-152; worker/wrangler.toml:56-58]" "HTTPS"

        warehouse_factory -> public_sources "Ingests bounded public data for offline ownership and batch joins [warehouse/README.md:1-5]" "Source export / API"
        warehouse_factory -> materialization_tools "Supplies DuckDB and Parquet data to repository builders [ARCHITECTURE.md:37,40,50]" "Local module boundary"
        materialization_tools -> browser_site "Writes compact site read models and build-rendered documents [tools/build_primary_documents.mjs:22-45]" "Repository artifact"
        materialization_tools -> worker_api "Publishes Worker data twins consumed by edge routes [ARCHITECTURE.md:37,40,50]" "Repository artifact"

        entity_resolution -> materialization_tools "Provides allowlisted, provenance-bearing links for public materialization [entity_resolution/README.md:87-100]" "JavaScript module import"
        ontology_registry -> materialization_tools "Evaluates catalog coverage and grounding for the improvement flywheel [ontology/README.md:1-13,20-27]" "JavaScript module import"
        worker_api -> entity_resolution "Uses the in-process identity package on the existing Worker/D1 deploy surface [entity_resolution/README.md:1-5]" "JavaScript module import"
        worker_api -> ontology_registry "Uses the backstage catalog as repository infrastructure, not as a public route [ontology/README.md:1-5]" "JavaScript module import"

        worker_api -> d1_notices "Reads and writes the recent-notice mirror and durable workflow tables [ARCHITECTURE.md:35; worker/wrangler.toml:110-117]" "D1 binding DB"
        worker_api -> kv_nl_meter "Stores natural-language metering state [ARCHITECTURE.md:35; worker/wrangler.toml:119-124]" "KV binding NL_METER"
        worker_api -> kv_alert_state "Stores digest state, counters, forecasts, and versioned read models [ARCHITECTURE.md:35; worker/wrangler.toml:119-129]" "KV binding ALERT_STATE"
        worker_api -> kv_subs "Stores confirmed subscriptions and rate-limit state [ARCHITECTURE.md:35; worker/wrangler.toml:130-136]" "KV binding SUBS"
        worker_api -> kv_feedback "Stores feedback rows and rate-limit state [ARCHITECTURE.md:35; worker/wrangler.toml:137-142]" "KV binding FEEDBACK"
        worker_api -> digest_queue "Enqueues per-subscription digest jobs [ARCHITECTURE.md:48; worker/wrangler.toml:94-100; worker/src/worker.mjs:179-183]" "Queue producer DIGEST_QUEUE"
        digest_queue -> worker_api "Delivers retryable digest jobs to the queue consumer [worker/wrangler.toml:102-108; worker/src/worker.mjs:352-363]" "Queue consumer"
        worker_api -> analytics_engine "Writes bounded aggregate usage events when the production binding is present [worker/wrangler.toml:89-92; worker/src/events.mjs:110-129]" "Analytics Engine binding USAGE_ANALYTICS"
        worker_api -> r2_source_vault "Would serve approved public documents only when the disabled source-vault seam is enabled [worker/src/source_vault.mjs:68-69; worker/wrangler.toml:80-87]" "Conditional R2 binding"
    }

    views {
        container cityscroll "cityscroll-containers" {
            include *
            autolayout lr
            description "CityScroll containers and their evidence-backed dependencies. R2 is shown as planned / disabled, not as an active production dependency."
        }

        styles {
            element "Person" {
                shape person
                background #084c61
                color #ffffff
            }
            element "Software System" {
                background #6c757d
                color #ffffff
            }
            element "Container" {
                background #1d7874
                color #ffffff
            }
            element "Database" {
                shape cylinder
                background #5c677d
                color #ffffff
            }
            element "Inactive" {
                opacity 45
                border dashed
            }
        }
    }
}
