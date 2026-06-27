/*---------------------------------------------------------------------------------------------
 *  AgentMemoryProvider — self-contained in-process memory provider.
 *
 *  NO external server required. NO iii-engine. NO agentmemory npm package.
 *  All algorithms (BM25, Vector, RRF, privacy filter, decay) run in-process.
 *  Persistence via a lightweight file server (host.mjs) for JSONL read/write.
 *
 *  Architecture:
 *    ┌─ In-memory indexes (BM25 + Vector) ──────────────────────┐
 *    │                                                           │
 *    │  writeMemory() → privacy filter → store in memory         │
 *    │                           ↓                               │
 *    │                    update BM25 + Vector indexes          │
 *    │                                                           │
 *    │  loadContext() / searchMemory()                          │
 *    │     → BM25 search + Vector search + substring fallback   │
 *    │     → RRF fusion (k=60)                                   │
 *    │     → reinforce hit entries (strength += 0.1)             │
 *    │                                                           │
 *    │  Periodic: apply Ebbinghaus decay (strength *= 0.9^n)    │
 *    └───────────────────────────────────────────────────────────┘
 *                          ↕ fetch (JSONL persistence)
 *    ┌─ File server (host.mjs, port 3111) ──────────────────────┐
 *    │  GET /mem/<agentId>/<file>  → read JSONL                  │
 *    │  PUT /mem/<agentId>/<file>  → write JSONL (atomic)        │
 *    └───────────────────────────────────────────────────────────┘
 *--------------------------------------------------------------------------------------------*/

import { BM25Index } from './bm25Index.js';
import { VectorIndex, embed } from './vectorIndex.js';
import { stripPrivateData, stripUndefinedLiterals } from './privacyFilter.js';
import { DedupManager } from './dedup.js';
import { AuditLog } from './auditLog.js';
import { selectWithBudget, estimateTokens } from './tokenBudget.js';
import { compress, compressSynthetic, type CompressedObservation } from './compressor.js';
import { KnowledgeGraph, type GraphRetrievalResult } from './knowledgeGraph.js';
import { expandQuery } from './queryExpansion.js';
import { PatternDetector } from './patternDetector.js';
import { ProjectProfileBuilder, type ProjectProfile } from './projectProfile.js';
import { SlotRegistry } from './slots.js';
import { Timeline, type TimelineEntry } from './timeline.js';
import { Diagnostics, type DiagnosticResult } from './diagnostics.js';
import { LessonExtractor, type Lesson } from './lessons.js';
import { ConsolidationPipeline, type EpisodicMemory, type SemanticMemory, type ProceduralMemory } from './consolidation.js';
import { RelationGraph, type MemoryRelation, type RelationType } from './relations.js';
import { Reflector } from './reflector.js';
import { ProvenanceTracker, type ProvenanceChain } from './provenance.js';
import { ReplayRecorder, type ReplaySession, type ReplayEvent } from './replay.js';
import { FileEnricher, type EnrichmentResult } from './enricher.js';
import { WorkingMemory, type WorkingMemoryItem } from './workingMemory.js';
import { FileIndex, type FileRecord, type FileAccessMode } from './fileIndex.js';
import { ClaudeBridge, type BridgeConfig } from './claudeBridge.js';
import { FacetManager } from './facets.js';
import { SnapshotManager, type SnapshotMeta, type SnapshotDiff } from './snapshots.js';
import { SignalHub, type Signal, type SignalType } from './signals.js';
import { CheckpointManager, type Checkpoint, type CheckpointType } from './checkpoints.js';
import { DiskManager, type DiskUsageStats } from './diskManager.js';
import { BranchAwareManager, type WorktreeInfo, type BranchSession, type MergeResult } from './branchAware.js';
import { GovernanceManager, type GovernanceFilter, type BulkDeleteResult, type GovernanceDeleteResult } from './governance.js';
import { RetentionScorer, type RetentionScore, type RetentionTiers, type RetentionResult, type DecayConfig } from './retention.js';
import { RoutineManager, type Routine, type RoutineRun, type RoutineStep } from './routines.js';
import { CascadeManager, type CascadeResult } from './cascade.js';
import { CrystallizeManager, type Crystal, type CrystalDigest, type CrystallizeAction } from './crystallize.js';
import { FrontierDetector, type FrontierItem, type FrontierAction, type FrontierEdge, type FrontierCheckpoint } from './frontier.js';
import { SmartSearch, type SmartSearchResult, type SmartSearchOptions, type FollowupStats } from './smartSearch.js';
import { SessionSummarizer, type SessionSummary, type SessionMessage } from './summarize.js';
import { SlidingWindow, type WindowEntry, type SlidingWindowStats, type SlidingWindowOptions } from './slidingWindow.js';
import { HookSystem, type HookType, type HookContext, type HookResult, type HookRegistration, createSessionStartHook, createPostToolUseHook, createPostToolFailureHook, createTaskCompletedHook, createPreToolUseHook, createUserPromptSubmitHook, createNotificationHook } from './hooks.js';
import { MemoryVerifier, type VerifyResult, type Citation, type VerifyEntry } from './verify.js';
import { TeamMemoryManager, type TeamSharedItem, type TeamProfile, type TeamConfig, type BroadcastMessage, type SharedItemType } from './teamMemory.js';
import { LeaseManager, type Lease, type AcquireResult } from './leases.js';
import { SkillExtractor, type ExtractedSkill, type SkillExtractInput } from './skillExtract.js';
import { TemporalGraph, type TemporalEdge, type TemporalNode, type TemporalEdgeType, type TemporalConflict } from './temporalGraph.js';
import { FlowCompressor, type FlowPattern, type FlowCompressResult, type FlowEntry } from './flowCompress.js';
import { ExportImportManager, type ExportPackage, type ExportEntry, type ImportResult } from './exportImport.js';
import { BloomFilter, HyperLogLog } from './bloomFilter.js';
import { RecentSearchesManager, type SearchHistoryEntry, type SearchHistoryStats } from './recentSearches.js';
import { AccessTracker, type AccessLog } from './accessTracker.js';
import { CircuitBreaker, CircuitBreakerRegistry, type CircuitBreakerState } from './circuitBreaker.js';
import { FallbackChain, CircuitProtectedFallbackChain, type FallbackProvider, type FallbackResult } from './fallbackChain.js';
import { SentinelManager, type Sentinel, type SentinelTrigger, type SentinelType, type SentinelConfig } from './sentinels.js';
import { MigrationManager, type MigratableEntry, type MigrationResult } from './migrate.js';
import { ImageRefManager, type ImageRef, type ImageRefStats } from './imageRefs.js';
import { MeshCoordinator, type MeshNode, type MeshMessage, type MeshTopology, type DistributionStrategy, type TaskDistribution } from './meshCoord.js';
import { ContextBuilder, type ContextSource, type ContextBuildResult } from './contextBuilder.js';
import { HealthMonitor, type HealthStatus, type HealthCheck, type HealthSnapshot, type HealthTrend, type HealthAlert } from './healthMonitor.js';
import { AccessPatternAnalyzer, type AccessPattern, type BurstDetection, type AccessHeatmap } from './accessPatterns.js';
import { QuotaManager, type QuotaConfig, type QuotaUsage, type QuotaCheckResult, type QuotaDimension, type EnforcementPolicy } from './quotaManager.js';
import { EventBus, type EventType, type MemoryEvent, type Subscription } from './eventBus.js';
import { RateLimiter, RateLimiterRegistry, type RateLimitConfig, type RateLimitResult } from './rateLimiter.js';
import { MetricsCollector, type LatencyStats, type OperationStats, type MetricsSummary } from './metricsCollector.js';
import { ResilientProvider, type ResilientOptions, type ResilientResult } from './resilientProvider.js';
import { NotificationHub, type Notification, type NotificationChannel, type NotificationPriority, type NotificationStats } from './notificationHub.js';
import { SubagentTracker, type SubagentRecord, type DelegationNode } from './subagentTracker.js';
import { PreCompactInjector, type PreCompactResult, type InjectEntry } from './preCompactInjector.js';
import { PostCommitCapture, type CommitInfo, type CommitMemoryEntry, type CommitStats } from './postCommitCapture.js';
import { SearchCache } from './searchCache.js';
import { PriorityQueue, type QueueItem, type QueuePriority, type BatchResult, type PriorityQueueStats } from './priorityQueue.js';
import { ConfigManager, type MemorySystemConfig, type ConfigChangeRecord } from './configManager.js';
import { UnifiedScorer, type ScoreInput, type ScoreWeights, type ScoreBreakdown } from './unifiedScorer.js';
import { FuzzySearcher, type FuzzyResult, type FuzzySearchOptions } from './fuzzySearch.js';
import { IndexRebuilder, type RebuildStatus, type IntegrityResult } from './indexRebuilder.js';
import { DiffCompressor, type DiffResult, type VersionedContent } from './diffCompressor.js';
import { ConcurrentLock } from './concurrentLock.js';
import { BatchProcessor, type BatchWriteItem, type BatchWriteResult, type BatchDeleteResult, type BatchSearchResult } from './batchProcessor.js';
import { SessionReplayManager, type ReplayEvent as SessionReplayEvent, type SessionDiff, type SessionTimeline } from './sessionReplay.js';
import { ReportGenerator, type SystemReport, type ReportType, type ReportDataSource } from './reportGenerator.js';
import { ActionManager, type Action, type ActionEdge, type ActionStatus, type ActionEdgeType } from './actions.js';
import { EvictionManager, type EvictionConfig, type EvictionStats, type EvictEntry } from './evict.js';
import { FileCompressor, type FileCompressionResult, COMPRESS_FILE_SYSTEM_PROMPT } from './compressFile.js';
import { VisionSearchManager, type StoredImageEmbedding, type VisionSearchResult, type VisionEmbedResult } from './visionSearch.js';
import { ImageQuotaCleanup, type ImageQuotaConfig, type ImageQuotaResult } from './imageQuotaCleanup.js';
import { VectorIndexMigrator, type VectorMigrationConfig, type VectorMigrationResult, type MigratableVectorEntry } from './migrateVectorIndex.js';
import { ProjectResolver, resolveProject, resolveProjectRoot } from './projectResolver.js';
import { NoopProvider, noopProvider, type LLMProvider, type EmbeddingProvider } from './noopProvider.js';
import { IndexPersistence, type IndexShardManifest, type SerializedEntry } from './indexPersistence.js';
import { memoryToObservation, mergeMemories, compareMemories, extractKeyInfo, formatMemory, type MemoryLike, type ObservationLike } from './memoryUtils.js';
import { rerank, rerankSimple, isRerankerAvailable, type RerankableResult, type RerankedResult } from './reranker.js';
import { Logger, logger, type LogLevel, type LogEntry } from './logger.js';
import { PromptManager, ALL_PROMPTS, getPrompt, COMPRESSION_SYSTEM_PROMPT, CONSOLIDATION_EPISODIC_SYSTEM, REFLECT_SYSTEM, SUMMARY_SYSTEM, GRAPH_EXTRACTION_SYSTEM, parseXmlTag, parseXmlTags, buildXmlString } from './prompts.js';
import { TriggerSystem, type TriggerTopic, type TriggerPayload, type TriggerConfig } from './triggerSystem.js';
import { HealthThresholds, type HealthDimension, type HealthLevel, type ThresholdConfig } from './healthThresholds.js';
import { ImageStore, type ImageStoreConfig } from './imageStore.js';
import { SketchManager, type Sketch, type SketchStatus, type SketchCreateOptions, type SketchAddActionOptions, type SketchPromoteResult, type SketchDiscardResult, type SketchGcResult } from './sketches.js';
import { exportToObsidian, type ObsidianExportDataSources, type ObsidianExportResult, type ObsidianExportOptions } from './obsidianExport.js';
import { createEmbeddingProvider, OpenAIEmbeddingProvider, GeminiEmbeddingProvider, CohereEmbeddingProvider, VoyageEmbeddingProvider, ClipEmbeddingProvider } from './embeddingProviders.js';
import { getSynonyms, expandQueryTerms, addSynonymGroup } from './synonyms.js';

// ─── Saros IMemoryProvider contract mirror ─────────────────────────────────

interface IMemoryEntry {
	readonly id: string;
	readonly type: 'working' | 'episodic' | 'semantic' | 'procedural';
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
	readonly timestamp?: number;
	readonly importance?: number;
	readonly score?: number;
}

interface IMemoryContext {
	readonly shortTermMemories: IMemoryEntry[];
	readonly longTermMemories: IMemoryEntry[];
	readonly systemPrompt?: string;
	readonly relevantDocuments?: unknown[];
}

interface IMemoryProvider {
	readonly id: string;
	readonly name: string;
	loadContext(agentId: string, sessionId: string, query?: string, options?: any): Promise<IMemoryContext>;
	writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
	searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_URL = 'http://127.0.0.1:3111';
const REQUEST_TIMEOUT_MS = 5000;
const RRF_K = 60;
const SHORT_TERM_FILE = 'short-term.jsonl';
const LONG_TERM_FILE = 'long-term.jsonl';
const VECTOR_INDEX_FILE = 'vector-index.json';
const SHORT_TERM_LIMIT = 200;
const DECAY_DAYS = 30;
const DECAY_FACTOR = 0.9;
const MIN_STRENGTH = 0.1;
const REINFORCE_INCREMENT = 0.1;
const MAX_STRENGTH = 1.0;
const STRENGTH_FLOOR = 0.15;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_LONG_TERM_ENTRIES = 5000;
const LOW_IMPORTANCE_THRESHOLD = 3;
const LOW_IMPORTANCE_MAX_DAYS = 90;

// ─── Extended memory entry with lifecycle fields ────────────────────────────

interface InternalMemoryEntry extends IMemoryEntry {
	strength: number;
	accessCount: number;
	lastAccessedAt: number;
	supersededBy?: string;
	// Version chain (from agentmemory source)
	parentId?: string;        // parent version ID (chain)
	isLatest?: boolean;       // is this the latest version?
	// Auto-forget TTL (from agentmemory source)
	forgetAfter?: number;     // timestamp when this entry should be auto-forgotten
}

// ─── File server helpers ────────────────────────────────────────────────────

function serverBase(): string {
	const envUrl = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_URL'];
	if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl.replace(/\/+$/, '');
	return DEFAULT_URL;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const resp = await fetch(url, { ...options, signal: ctrl.signal });
		if (!resp.ok) {
			console.warn(`[AgentMemory] ${options?.method ?? 'GET'} ${url} -> HTTP ${resp.status}`);
			return null;
		}
		return (await resp.json()) as T;
	} catch (err) {
		console.warn(`[AgentMemory] ${options?.method ?? 'GET'} ${url} FAILED: ${(err as Error).message}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function readFile(agentId: string, file: string): Promise<string> {
	const url = `${serverBase()}/mem/${encodeURIComponent(agentId)}/${file}`;
	const result = await fetchJson<string>(url);
	return result ?? '';
}

async function writeFile(agentId: string, file: string, content: string): Promise<boolean> {
	const url = `${serverBase()}/mem/${encodeURIComponent(agentId)}/${file}`;
	console.log(`[AgentMemory] writeFile: PUT ${url} (${content.length} bytes)`);
	try {
		const result = await fetchJson<{ ok: boolean }>(url, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: content,
		});
		console.log(`[AgentMemory] writeFile: ${agentId}/${file} result=`, result);
		return result?.ok ?? false;
	} catch (err) {
		console.error(`[AgentMemory] writeFile: ${agentId}/${file} FAILED:`, err);
		return false;
	}
}

async function checkHealth(): Promise<boolean> {
	const result = await fetchJson<{ status: string }>(`${serverBase()}/health`);
	return result?.status === 'ok';
}

// ─── Decay manager ──────────────────────────────────────────────────────────

function applyDecay(entries: InternalMemoryEntry[]): void {
	const now = Date.now();
	for (const entry of entries) {
		const lastAccess = entry.lastAccessedAt || entry.timestamp || now;
		const daysSince = (now - lastAccess) / (1000 * 60 * 60 * 24);
		if (daysSince > DECAY_DAYS) {
			const decayPeriods = Math.floor(daysSince / DECAY_DAYS);
			entry.strength = Math.max(MIN_STRENGTH, entry.strength * Math.pow(DECAY_FACTOR, decayPeriods));
		}
	}
}

function reinforce(entry: InternalMemoryEntry): void {
	entry.strength = Math.min(MAX_STRENGTH, entry.strength + REINFORCE_INCREMENT);
	entry.accessCount++;
	entry.lastAccessedAt = Date.now();
}

// ─── AgentMemoryProvider implementation ────────────────────────────────────

export class AgentMemoryProvider implements IMemoryProvider {
	readonly id = 'agentmemory';
	readonly name = 'AgentMemory';

	/** Per-agent in-memory storage */
	private _shortTerm = new Map<string, InternalMemoryEntry[]>();
	private _longTerm = new Map<string, InternalMemoryEntry[]>();

	/** Per-agent search indexes */
	private _bm25 = new Map<string, BM25Index>();
	private _vector = new Map<string, VectorIndex>();

	/** Track if data has been loaded from disk */
	private _loaded = new Set<string>();

	/** Pending user messages (for user/assistant pairing) */
	private _pendingUser = new Map<string, string>();

	/** Health check cache */
	private _healthChecked = false;
	private _serverAvailable = false;

	/** Session tracking: agentId → { sessionId, startedAt, observationCount } */
	private _activeSessions = new Map<string, { sessionId: string; startedAt: number; observationCount: number }>();

	/** Periodic decay + eviction sweep timer */
	private _sweepTimer: ReturnType<typeof setInterval> | undefined;

	/** Write debouncing: batch disk writes within 5s window */
	private _dirtyAgents = new Set<string>();
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	private static readonly FLUSH_DELAY_MS = 1000; // 从 5000ms 降至 1000ms，减少窗口关闭时数据丢失风险
	private _periodicFlushTimer: ReturnType<typeof setInterval> | undefined;

	/** Embedding upgrade throttle: avoid re-upgrading on every load */
	private _embeddingUpgraded = new Set<string>();

	/** Per-agent dedup managers (SHA-256, 5min window) */
	private _dedup = new Map<string, DedupManager>();

	/** Audit log for all operations */
	private _audit = new AuditLog();

	/** Token budget for context injection (default 2000 tokens) */
	private _tokenBudget = 2000;

	/** Per-agent knowledge graphs */
	private _graphs = new Map<string, KnowledgeGraph>();

	/** Per-agent project profile builder */
	private _profileBuilder = new ProjectProfileBuilder();

	/** Per-agent cached profiles (regenerated on demand) */
	private _profiles = new Map<string, ProjectProfile>();

	/** Per-agent pattern detector */
	private _patternDetector = new PatternDetector();

	/** Per-agent memory slots (persona/preferences/project_context) */
	private _slots = new SlotRegistry();

	/** Timeline builder */
	private _timeline = new Timeline();

	/** Diagnostics runner */
	private _diagnostics = new Diagnostics();

	/** Per-agent lesson extractor */
	private _lessons = new LessonExtractor();

	/** Per-agent consolidation pipeline (4-tier) */
	private _consolidation = new Map<string, ConsolidationPipeline>();

	/** Per-agent relation graph */
	private _relations = new Map<string, RelationGraph>();

	/** Per-agent reflector (auto-update slots) */
	private _reflector = new Reflector();

	/** Per-agent provenance tracker */
	private _provenance = new Map<string, ProvenanceTracker>();

	/** Session replay recorder */
	private _replay = new ReplayRecorder();

	/** File enricher */
	private _enricher = new FileEnricher();

	/** Per-agent working memory (ephemeral, per-task) */
	private _workingMemory = new WorkingMemory();

	/** Per-agent file index */
	private _fileIndex = new FileIndex();

	/** Claude bridge (MEMORY.md sync) */
	private _claudeBridge = new ClaudeBridge();

	/** Facet manager (multi-dimensional tags) */
	private _facets = new FacetManager();

	/** Per-agent snapshot manager */
	private _snapshots = new Map<string, SnapshotManager>();

	/** Signal hub (inter-agent messaging) */
	private _signals = new SignalHub();

	/** Checkpoint manager (external condition gates) */
	private _checkpoints = new CheckpointManager();

	/** Disk manager (storage tracking + quota) */
	private _diskManager = new DiskManager();

	// ─── Round 8: branch-aware, governance, retention, routines, cascade, crystallize, frontier, smartSearch, summarize, slidingWindow
	private _branchAware = new BranchAwareManager();
	private _governance: GovernanceManager | undefined;  // lazy init (needs audit)
	private _retentionScorer = new RetentionScorer();
	private _routines = new RoutineManager();
	private _cascade = new CascadeManager();
	private _crystallize = new CrystallizeManager();
	private _frontier = new FrontierDetector();
	private _smartSearch: SmartSearch | undefined;  // lazy init (needs searchFn)
	private _summarizer = new SessionSummarizer();
	private _slidingWindows = new Map<string, SlidingWindow>();

	// ─── Round 9: hooks, verify, teamMemory, leases, skillExtract, temporalGraph, flowCompress, exportImport, bloomFilter, recentSearches
	private _hooks = new HookSystem();
	private _verifier = new MemoryVerifier();
	private _teamMemory: TeamMemoryManager | undefined;  // lazy init (needs config)
	private _leases = new LeaseManager();
	private _skillExtractor = new SkillExtractor();
	private _temporalGraphs = new Map<string, TemporalGraph>();
	private _flowCompressor = new FlowCompressor();
	private _exportImport = new ExportImportManager();
	private _bloomFilters = new Map<string, BloomFilter>();
	private _recentSearches = new RecentSearchesManager();
	private _searchCache = new SearchCache<IMemoryEntry[]>(100, 5 * 60 * 1000); // P3-3: LRU cache, 5min TTL

	// ─── Round 10: accessTracker, circuitBreaker, fallbackChain, sentinels, migrate, imageRefs, meshCoord, contextBuilder, healthMonitor, accessPatterns
	private _accessTracker = new AccessTracker();
	private _circuitRegistry = new CircuitBreakerRegistry();
	private _sentinelManager = new SentinelManager();
	private _migrationManager = new MigrationManager();
	private _imageRefs = new ImageRefManager();
	private _meshCoord = new MeshCoordinator();
	private _contextBuilder = new ContextBuilder();
	private _patternAnalyzer = new AccessPatternAnalyzer();
	private _healthMonitor: HealthMonitor | undefined;  // lazy init (needs circuit + sentinel)

	// ─── Round 11: quotaManager, eventBus, rateLimiter, metricsCollector, resilientProvider, notificationHub, subagentTracker, preCompactInjector, postCommitCapture, priorityQueue
	private _quotaManager = new QuotaManager();
	private _eventBus = new EventBus();
	private _rateLimiters = new RateLimiterRegistry();
	private _metrics = new MetricsCollector();
	private _notifications = new NotificationHub();
	private _subagentTracker = new SubagentTracker();
	private _preCompactInjector = new PreCompactInjector();
	private _postCommitCapture = new PostCommitCapture();
	private _writeQueue = new PriorityQueue<{ agentId: string; entry: IMemoryEntry }>();

	// ─── Round 12: configManager, unifiedScorer, fuzzySearch, indexRebuilder, diffCompressor, concurrentLock, batchProcessor, sessionReplay, reportGenerator
	private _configManager = new ConfigManager();
	private _configUnsub: (() => void) | null = null;
	// Config-derived instance fields (hot-reloaded via _applyConfig)
	private _rrfK = 60;
	private _searchWeights = { bm25: 0.35, vector: 0.40, graph: 0.15, text: 0.10, maxPerSession: 3 };
	private _unifiedScorer = new UnifiedScorer();
	private _fuzzySearcher = new FuzzySearcher();
	private _indexRebuilder = new IndexRebuilder();
	private _diffCompressor = new DiffCompressor();
	private _concurrentLock = new ConcurrentLock();
	private _batchProcessor = new BatchProcessor();
	private _sessionReplay = new SessionReplayManager();
	private _reportGenerator: ReportGenerator | undefined;  // lazy init

	// ─── Round 13 (1:1 parity): actions, evict, compressFile, visionSearch, imageQuotaCleanup, migrateVectorIndex, projectResolver, noopProvider, indexPersistence, memoryUtils, reranker, logger, prompts, triggerSystem, healthThresholds, imageStore
	private _actionManager = new ActionManager();
	private _evictionManager = new EvictionManager();
	private _fileCompressor = new FileCompressor();
	private _visionSearch = new VisionSearchManager();
	private _imageQuotaCleanup = new ImageQuotaCleanup();
	private _vectorIndexMigrator = new VectorIndexMigrator();
	private _projectResolver = new ProjectResolver();
	private _indexPersistence = new IndexPersistence();
	private _promptManager = new PromptManager();
	private _triggerSystem = new TriggerSystem();
	private _healthThresholds = new HealthThresholds();
	private _imageStore = new ImageStore();
	private _sketchManager = new SketchManager();
	private _externalEmbeddingProvider = createEmbeddingProvider();

	constructor() {
		// Start periodic sweep every 6 hours
		this._sweepTimer = setInterval(() => {
			this._runSweep().catch(err => {
				console.warn('[AgentMemory] periodic sweep failed:', err);
			});
		}, SWEEP_INTERVAL_MS);
		// Don't keep the process alive just for this timer
		if (this._sweepTimer && typeof (this._sweepTimer as any).unref === 'function') {
			(this._sweepTimer as any).unref();
		}

		// Register default hooks
		this._hooks.register(createSessionStartHook().type, createSessionStartHook().handler, createSessionStartHook().priority);
		this._hooks.register(createUserPromptSubmitHook().type, createUserPromptSubmitHook().handler, createUserPromptSubmitHook().priority);
		this._hooks.register(createPreToolUseHook().type, createPreToolUseHook().handler, createPreToolUseHook().priority);
		this._hooks.register(createPostToolUseHook().type, createPostToolUseHook().handler, createPostToolUseHook().priority);
		this._hooks.register(createPostToolFailureHook().type, createPostToolFailureHook().handler, createPostToolFailureHook().priority);
		this._hooks.register(createTaskCompletedHook().type, createTaskCompletedHook().handler, createTaskCompletedHook().priority);
		this._hooks.register(createNotificationHook().type, createNotificationHook().handler, createNotificationHook().priority);

		// Config hot-reload: subscribe to ConfigManager changes and apply them
		this._applyConfig();
		this._configUnsub = this._configManager.onChange((config, changes) => {
			for (const change of changes) {
				console.info(`[AgentMemory] Config changed: ${change.path} = ${JSON.stringify(change.newValue)}`);
			}
			this._applyConfig();
		});

		// 定期保存（每30秒），确保数据不会因窗口异常关闭而丢失
		this._periodicFlushTimer = setInterval(() => {
			if (this._dirtyAgents.size > 0) {
				console.log(`[AgentMemory] periodic flush: ${this._dirtyAgents.size} dirty agent(s)`);
				this._flushPendingWrites().catch(err => {
					console.error('[AgentMemory] periodic flush failed:', err);
				});
			}
		}, 30_000);
		// Don't keep the process alive just for this timer
		if (this._periodicFlushTimer && typeof (this._periodicFlushTimer as any).unref === 'function') {
			(this._periodicFlushTimer as any).unref();
		}
	}

	/**
	 * Set a TTL (forget-after timestamp) on a specific memory.
	 * The memory will be auto-forgotten during the next sweep cycle.
	 * Inspired by agentmemory's Memory.forgetAfter field.
	 */
	setForgetAfter(agentId: string, memoryId: string, forgetAfterTs: number): boolean {
		const long = this._longTerm.get(agentId);
		if (!long) return false;
		const entry = long.find(e => e.id === memoryId);
		if (!entry) return false;
		entry.forgetAfter = forgetAfterTs;
		this._schedulePersist(agentId);
		return true;
	}

	/**
	 * Auto-forget: immediately remove memories with expired TTL or contradictions.
	 * Inspired by agentmemory's auto-forget function.
	 * Returns counts of what was forgotten.
	 */
	autoForget(agentId: string, dryRun: boolean = false): {
		ttlExpired: string[];
		contradictions: Array<{ memoryA: string; memoryB: string; similarity: number }>;
		lowValue: string[];
	} {
		const long = this._longTerm.get(agentId) ?? [];
		const now = Date.now();
		const result = { ttlExpired: [] as string[], contradictions: [] as Array<{ memoryA: string; memoryB: string; similarity: number }>, lowValue: [] as string[] };

		// 1. TTL expiration
		for (const entry of long) {
			if (entry.forgetAfter && now > entry.forgetAfter) {
				result.ttlExpired.push(entry.id);
			}
		}

		// 2. Contradiction detection (concept-based Jaccard similarity)
		const conceptIndex = new Map<string, string[]>();
		for (const entry of long) {
			if (entry.supersededBy || entry.isLatest === false) continue;
			const concepts = (entry.metadata?.['concepts'] as string[]) ?? [];
			for (const c of concepts) {
				const key = c.toLowerCase();
				if (!conceptIndex.has(key)) conceptIndex.set(key, []);
				conceptIndex.get(key)!.push(entry.id);
			}
		}
		const CONTRADICTION_THRESHOLD = 0.9;
		const compared = new Set<string>();
		for (const [, memIds] of conceptIndex) {
			for (let i = 0; i < memIds.length; i++) {
				for (let j = i + 1; j < memIds.length; j++) {
					const pairKey = memIds[i] < memIds[j] ? `${memIds[i]}|${memIds[j]}` : `${memIds[j]}|${memIds[i]}`;
					if (compared.has(pairKey)) continue;
					compared.add(pairKey);
					const memA = long.find(e => e.id === memIds[i]);
					const memB = long.find(e => e.id === memIds[j]);
					if (!memA || !memB) continue;
					// Simple Jaccard on word sets
					const wordsA = new Set(memA.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
					const wordsB = new Set(memB.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
					let intersection = 0;
					for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
					const sim = intersection / (wordsA.size + wordsB.size - intersection);
					if (sim > CONTRADICTION_THRESHOLD) {
						result.contradictions.push({ memoryA: memIds[i], memoryB: memIds[j], similarity: sim });
						if (!dryRun) {
							// Mark older one as superseded
							const older = (memA.timestamp ?? 0) < (memB.timestamp ?? 0) ? memA : memB;
							older.isLatest = false;
							older.supersededBy = (memA.timestamp ?? 0) < (memB.timestamp ?? 0) ? memB.id : memA.id;
						}
					}
				}
			}
		}

		// 3. Low value: importance <= 2 and age > 180 days
		const maxAgeMs = 180 * 24 * 60 * 60 * 1000;
		for (const entry of long) {
			if (entry.supersededBy || entry.isLatest === false) continue;
			if ((entry.importance ?? 5) <= 2 && (now - (entry.timestamp ?? now)) > maxAgeMs) {
				result.lowValue.push(entry.id);
			}
		}

		// Apply deletions (non-dryRun)
		if (!dryRun && (result.ttlExpired.length > 0 || result.lowValue.length > 0)) {
			const toDelete = new Set([...result.ttlExpired, ...result.lowValue]);
			const remaining = long.filter(e => !toDelete.has(e.id));
			this._longTerm.set(agentId, remaining);
			const bm25 = this._bm25.get(agentId);
			const vector = this._vector.get(agentId);
			for (const id of toDelete) {
				bm25?.remove(id);
				vector?.remove(id);
			}
			this._schedulePersist(agentId);
		}

		return result;
	}

	/**
	 * Remove all data for a specific agent — prevents memory leaks from accumulated agents.
	 * Cleans up all 16+ per-agent Map/Set entries.
	 */
	removeAgent(agentId: string): void {
		// Fire session_end hook before cleanup
		const session = this._activeSessions.get(agentId);
		if (session) {
			this._hooks.triggerAndCollect('session_end', { agentId, sessionId: session.sessionId, timestamp: Date.now() }).catch(() => {});
		}
		// Core memory arrays
		this._shortTerm.delete(agentId);
		this._longTerm.delete(agentId);
		// Search indexes
		this._bm25.delete(agentId);
		this._vector.delete(agentId);
		// State tracking
		this._loaded.delete(agentId);
		this._pendingUser.delete(agentId);
		this._activeSessions.delete(agentId);
		this._dirtyAgents.delete(agentId);
		this._embeddingUpgraded.delete(agentId);
		// Auxiliary data structures
		this._dedup.delete(agentId);
		this._graphs.delete(agentId);
		this._profiles.delete(agentId);
		this._consolidation.delete(agentId);
		this._relations.delete(agentId);
		this._provenance.delete(agentId);
		this._snapshots.delete(agentId);
		this._slidingWindows.delete(agentId);
		this._temporalGraphs.delete(agentId);
		this._bloomFilters.delete(agentId);
		// Search cache
		this._searchCache.invalidateAgent(agentId);
		// Log cleanup
		console.log(`[AgentMemory] Agent '${agentId}' removed — all per-agent data structures cleaned`);
	}

	dispose(): void {
		// Fire session_end hooks + session.stopped triggers for all active sessions
		for (const [agentId, session] of this._activeSessions) {
			this._triggerSystem.fireSync('session.stopped', { agentId, sessionId: session.sessionId });
			this._hooks.triggerAndCollect('session_end', { agentId, sessionId: session.sessionId, timestamp: Date.now() }).catch(() => {});
			this._eventBus.emitSync({ type: 'session_ended', source: 'memoryProvider', agentId, data: { sessionId: session.sessionId, observationCount: session.observationCount } });
		}
		if (this._sweepTimer) {
			clearInterval(this._sweepTimer);
			this._sweepTimer = undefined;
		}
		if (this._periodicFlushTimer) {
			clearInterval(this._periodicFlushTimer);
			this._periodicFlushTimer = undefined;
		}
		if (this._configUnsub) {
			this._configUnsub();
			this._configUnsub = null;
		}
		// Flush any pending writes before disposing
		this._flushPendingWrites().catch(() => { /* best effort */ });
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		this._shortTerm.clear();
		this._longTerm.clear();
		this._bm25.clear();
		this._vector.clear();
		this._loaded.clear();
		this._pendingUser.clear();
		this._activeSessions.clear();
		this._dirtyAgents.clear();
		this._embeddingUpgraded.clear();
		this._graphs.clear();
		this._profiles.clear();
		this._dedup.clear();
		this._slots.clearAll();
		this._lessons.clear('');
		this._consolidation.forEach(p => p.clear(''));
		this._consolidation.clear();
		this._relations.forEach(r => r.clear());
		this._relations.clear();
		this._provenance.forEach(p => p.clear());
		this._provenance.clear();
		for (const agentId of this._loaded) {
			this._workingMemory.clear(agentId);
			this._fileIndex.clear(agentId);
			this._snapshots.get(agentId)?.clear(agentId);
		}
		this._snapshots.clear();
		this._facets.clear();
		this._signals.clear();
		this._checkpoints.clear();
		// Round 8 modules
		this._branchAware.clear();
		this._routines.clear();
		this._crystallize.clear();
		this._summarizer.clear();
		this._slidingWindows.clear();
		// Round 9 modules
		this._hooks.clear();
		this._leases.dispose();
		this._skillExtractor.clear();
		this._temporalGraphs.forEach(g => g.clear());
		this._temporalGraphs.clear();
		this._flowCompressor.clear();
		this._bloomFilters.clear();
		this._recentSearches.clear();
		this._searchCache.clear();
		// Round 10 modules
		this._accessTracker.clear();
		this._circuitRegistry.clear();
		this._sentinelManager.clear();
		this._imageRefs.clear();
		this._meshCoord.clear();
		this._healthMonitor?.dispose();
		// Round 11 modules
		this._eventBus.clear();
		this._rateLimiters.dispose();
		this._metrics.clear();
		this._notifications.clear();
		this._subagentTracker.clear();
		this._postCommitCapture.clear();
		this._writeQueue.dispose();
		// Round 12 modules
		this._diffCompressor.clear();
		this._concurrentLock.clear();
		this._sessionReplay.clear();
		// Round 13 modules (1:1 parity)
		this._actionManager.clear();
		this._visionSearch.clear();
		this._projectResolver.clear();
		this._indexPersistence.dispose();
		this._promptManager.clear();
		this._triggerSystem.clear();
		this._imageStore.clear();
	}

	// ─── Load from disk (lazy) ──────────────────────────────────────────────

	private async _ensureLoaded(agentId: string): Promise<void> {
		if (this._loaded.has(agentId)) return;

		// Check server health once
		if (!this._healthChecked) {
			this._serverAvailable = await checkHealth();
			this._healthChecked = true;
			if (!this._serverAvailable) {
				console.warn('[AgentMemory] file server not available, running in memory-only mode');
			}
		}

		if (!this._serverAvailable) {
			this._loaded.add(agentId);
			return;
		}

		// Load JSONL files + vector index
		const [shortRaw, longRaw, vectorRaw] = await Promise.all([
			readFile(agentId, SHORT_TERM_FILE),
			readFile(agentId, LONG_TERM_FILE),
			readFile(agentId, VECTOR_INDEX_FILE),
		]);

		const shortEntries = this._parseJsonl(shortRaw);
		const longEntries = this._parseJsonl(longRaw);

		this._shortTerm.set(agentId, shortEntries);
		this._longTerm.set(agentId, longEntries);

		// Apply decay on load
		applyDecay(longEntries);

		// Build indexes
		const bm25 = new BM25Index();
		const vector = new VectorIndex();
		// Try to restore persisted vectors first (avoids re-embedding)
		let restoredVectors = 0;
		if (vectorRaw && vectorRaw.trim().length > 0) {
			restoredVectors = vector.deserialize(vectorRaw);
		}
		for (const entry of longEntries) {
			if (entry.supersededBy) continue; // skip superseded
			bm25.add(entry.id, entry.content);
			// Only compute embedding if not already restored from disk
			if (!vectorRaw || vectorRaw.trim().length === 0) {
				const vec = embedSyncCached(entry.content);
				if (vec) vector.add(entry.id, vec);
			}
		}
		this._bm25.set(agentId, bm25);
		this._vector.set(agentId, vector);

		// Async: upgrade embeddings to real ones (only if not already upgraded)
		if (restoredVectors === 0) {
			this._upgradeEmbeddings(agentId).catch(() => { /* best effort */ });
		}

		this._loaded.add(agentId);
		console.log(`[AgentMemory] loaded agent=${agentId}: short=${shortEntries.length}, long=${longEntries.length}, vectors=${restoredVectors > 0 ? `${restoredVectors} restored` : 'computed'}`);
	}

	private _parseJsonl(raw: string): InternalMemoryEntry[] {
		if (!raw || raw.trim().length === 0) return [];
		// Handle both JSON array and JSONL format
		const trimmed = raw.trim();
		if (trimmed.startsWith('[')) {
			try {
				const arr = JSON.parse(trimmed);
				return arr.map((e: any) => this._normalizeEntry(e));
			} catch { return []; }
		}
		const entries: InternalMemoryEntry[] = [];
		for (const line of trimmed.split('\n')) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				entries.push(this._normalizeEntry(obj));
			} catch { /* skip malformed */ }
		}
		return entries;
	}

	private _normalizeEntry(raw: any): InternalMemoryEntry {
		const md = raw.metadata ?? {};
		return {
			id: raw.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: raw.type ?? 'long_term',
			content: raw.content ?? '',
			metadata: md,
			timestamp: raw.timestamp ?? Date.now(),
			importance: raw.importance ?? 5,
			strength: md['strength'] ?? raw.strength ?? 1.0,
			accessCount: md['accessCount'] ?? raw.accessCount ?? 0,
			lastAccessedAt: md['lastAccessedAt'] ?? raw.lastAccessedAt ?? raw.timestamp ?? Date.now(),
			supersededBy: md['supersededBy'],
		};
	}

	/** Upgrade sync embeddings to real @xenova/transformers embeddings (throttled) */
	private async _upgradeEmbeddings(agentId: string): Promise<void> {
		if (this._embeddingUpgraded.has(agentId)) return; // already upgraded
		const vector = this._vector.get(agentId);
		if (!vector) return;
		const longEntries = this._longTerm.get(agentId);
		if (!longEntries) return;

		for (const entry of longEntries) {
			if (entry.supersededBy) continue;
			const realVec = await embed(entry.content);
			if (realVec) {
				vector.remove(entry.id);
				vector.add(entry.id, realVec);
			}
		}
		console.log(`[AgentMemory] upgraded embeddings for agent=${agentId} (${vector.size} vectors)`);
		this._embeddingUpgraded.add(agentId);
	}

	// ─── Persistence ─────────────────────────────────────────────────────────

	// ─── Debounced persistence ────────────────────────────────────────────────

	/**
	 * Mark an agent's data as dirty and schedule a debounced flush.
	 * Multiple writes within 5s are batched into a single disk write.
	 */
	private _schedulePersist(agentId: string): void {
		this._dirtyAgents.add(agentId);
		if (this._flushTimer) return; // already scheduled
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			this._flushPendingWrites().catch(err => {
				console.warn('[AgentMemory] flush failed:', err);
			});
		}, AgentMemoryProvider.FLUSH_DELAY_MS);
		// Don't keep process alive for this
		if (this._flushTimer && typeof (this._flushTimer as any).unref === 'function') {
			(this._flushTimer as any).unref();
		}
	}

	/** Flush all pending writes to disk immediately */
	private async _flushPendingWrites(): Promise<void> {
		const agents = Array.from(this._dirtyAgents);
		this._dirtyAgents.clear();
		if (agents.length === 0) return;
		console.log(`[AgentMemory] _flushPendingWrites: saving ${agents.length} agent(s): ${agents.join(', ')}`);
		await Promise.all(agents.map(async (agentId) => {
			if (!this._serverAvailable) {
				console.warn(`[AgentMemory] _flushPendingWrites: server not available, skipping ${agentId}`);
				return;
			}
			const longEntries = this._longTerm.get(agentId) ?? [];
			const shortEntries = this._shortTerm.get(agentId) ?? [];
			console.log(`[AgentMemory] _flushPendingWrites: ${agentId} has ${longEntries.length} long-term, ${shortEntries.length} short-term entries`);
			const longJsonl = longEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
			const shortJsonl = shortEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
			// Also persist vector index (avoids re-embedding on next startup)
			const vectorIdx = this._vector.get(agentId);
			const vectorJson = vectorIdx && vectorIdx.size > 0 ? vectorIdx.serialize() : '';
			const writes: Promise<boolean>[] = [
				writeFile(agentId, LONG_TERM_FILE, longJsonl),
				writeFile(agentId, SHORT_TERM_FILE, shortJsonl),
			];
			if (vectorJson) {
				writes.push(writeFile(agentId, VECTOR_INDEX_FILE, vectorJson));
			}
			try {
				const results = await Promise.all(writes);
				console.log(`[AgentMemory] _flushPendingWrites: ${agentId} save results: long=${results[0]}, short=${results[1]}, vector=${results[2] ?? 'skipped'}`);
			} catch (err) {
				console.error(`[AgentMemory] _flushPendingWrites: ${agentId} save failed:`, err);
			}
		}));
	}

	private async _persistLongTerm(agentId: string): Promise<void> {
		this._schedulePersist(agentId);
	}

	private async _persistShortTerm(agentId: string): Promise<void> {
		this._schedulePersist(agentId);
	}

	// ─── Statistics (for detail pane / diagnostics) ─────────────────────────

	/**
	 * Get memory statistics for an agent.
	 * Used by the memory detail pane to show counts, index sizes, etc.
	 */
	getStats(agentId: string): {
		longTermCount: number;
		shortTermCount: number;
		bm25IndexSize: number;
		vectorIndexSize: number;
		vectorAvailable: boolean;
		serverAvailable: boolean;
		activeSession: boolean;
		pendingWrites: number;
		strengthBuckets: { high: number; mid: number; low: number; evicted: number };
		graphNodes: number;
		graphEdges: number;
	} {
		const longEntries = this._longTerm.get(agentId) ?? [];
		const shortEntries = this._shortTerm.get(agentId) ?? [];
		const bm25 = this._bm25.get(agentId);
		const vector = this._vector.get(agentId);

		let high = 0, mid = 0, low = 0, evicted = 0;
		for (const e of longEntries) {
			if (e.supersededBy) { evicted++; continue; }
			if (e.strength > 0.5) high++;
			else if (e.strength > 0.2) mid++;
			else low++;
		}

		return {
			longTermCount: longEntries.filter(e => !e.supersededBy).length,
			shortTermCount: shortEntries.length,
			bm25IndexSize: bm25?.size ?? 0,
			vectorIndexSize: vector?.size ?? 0,
			vectorAvailable: vector?.available ?? false,
			serverAvailable: this._serverAvailable,
			activeSession: this._activeSessions.has(agentId),
			pendingWrites: this._dirtyAgents.size,
			strengthBuckets: { high, mid, low, evicted },
			graphNodes: this._graphs.get(agentId)?.nodeCount ?? 0,
			graphEdges: this._graphs.get(agentId)?.edgeCount ?? 0,
		};
	}

	/** Extended stats for UI (implements IMemoryProvider.getExtendedStats) */
	getExtendedStats(agentId: string): Record<string, unknown> {
		const stats = this.getStats(agentId);
		const accessStats = this._accessTracker.getStats();
		const searchStats = this._recentSearches.getStats(agentId);
		const healthSummary = this._healthMonitor?.getHealthSummary();
		const circuitStates = this._circuitRegistry.getAllStates();
		const notifStats = this._notifications.getStats(agentId);
		const bloomStats = this._bloomFilters.get(agentId)?.getStats();
		const windowStats = this._getSlidingWindow(agentId).getStats();

		return {
			// Core
			longTerm: stats.longTermCount,
			shortTerm: stats.shortTermCount,
			bm25Size: stats.bm25IndexSize,
			vectorSize: stats.vectorIndexSize,
			graphNodes: stats.graphNodes,
			graphEdges: stats.graphEdges,
			pendingWrites: stats.pendingWrites,
			// Access
			accessTracked: accessStats.totalTracked,
			totalAccesses: accessStats.totalAccesses,
			// Search
			totalSearches: searchStats.totalSearches,
			zeroResultSearches: searchStats.zeroResultCount,
			avgSearchResults: searchStats.avgResultCount,
			// Window
			windowSize: windowStats.windowSize,
			windowHitRate: Math.round(windowStats.hitRate * 100) + '%',
			// Bloom
			bloomFillRatio: bloomStats ? Math.round(bloomStats.fillRatio * 100) + '%' : 'N/A',
			// Health
			healthStatus: healthSummary?.status ?? 'N/A',
			openCircuits: Object.values(circuitStates).filter((s: any) => s.state === 'open').length,
			// Notifications
			unreadNotifs: notifStats.unread,
			// Temporal
			temporalEdges: this._temporalGraphs.get(agentId)?.getStats().edges ?? 0,
			// Audit
			auditEntries: this._audit.getSummary(),
		};
	}

	/** Extended diagnostics for UI (implements IMemoryProvider.runExtendedDiagnostics) */
	runExtendedDiagnostics(agentId: string): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		const stats = this.getStats(agentId);

		// Server
		result['file_server'] = stats.serverAvailable ? 'pass' : 'warn';
		// Index consistency
		result['bm25_index'] = stats.bm25IndexSize > 0 ? 'pass' : 'warn';
		result['vector_index'] = stats.vectorIndexSize > 0 ? 'pass' : 'warn';
		result['graph'] = stats.graphNodes > 0 ? 'pass' : 'warn';
		// Strength distribution
		result['strength_high'] = stats.strengthBuckets.high;
		result['strength_mid'] = stats.strengthBuckets.mid;
		result['strength_low'] = stats.strengthBuckets.low;
		result['strength_evicted'] = stats.strengthBuckets.evicted;
		// Pending writes
		result['pending_writes'] = stats.pendingWrites === 0 ? 'pass' : 'warn';
		// Circuit breakers
		const circuits = this._circuitRegistry.getAllStates();
		const openCount = Object.values(circuits).filter((s: any) => s.state === 'open').length;
		result['circuit_breakers'] = openCount === 0 ? 'pass' : 'fail';
		// Active session
		result['active_session'] = stats.activeSession ? 'pass' : 'warn';
		// Bloom filter
		const bloom = this._bloomFilters.get(agentId);
		if (bloom) {
			const bloomStats = bloom.getStats();
			result['bloom_fpr'] = bloomStats.estimatedFalsePositiveRate < 0.05 ? 'pass' : 'warn';
		}
		// Temporal conflicts
		const temporalConflicts = this.detectTemporalConflicts(agentId);
		result['temporal_conflicts'] = temporalConflicts.length === 0 ? 'pass' : 'warn';

		return result;
	}

	/**
	 * Get or build the project profile for an agent.
	 * Cached and regenerated on demand when new memories are added.
	 */
	getProfile(agentId: string): ProjectProfile | null {
		const cached = this._profiles.get(agentId);
		if (cached) return cached;
		const longEntries = this._longTerm.get(agentId);
		if (!longEntries || longEntries.length === 0) return null;
		const profile = this._profileBuilder.build(agentId, longEntries);
		this._profiles.set(agentId, profile);
		return profile;
	}

	// ─── Timeline API ───────────────────────────────────────────────────────

	/** Get chronological timeline of memories */
	getTimeline(agentId: string): TimelineEntry[] {
		const longEntries = this._longTerm.get(agentId) ?? [];
		return this._timeline.build(longEntries as any[]);
	}

	// ─── Diagnostics API ────────────────────────────────────────────────────

	/** Run health diagnostics */
	runDiagnostics(agentId: string): DiagnosticResult {
		const longEntries = this._longTerm.get(agentId) ?? [];
		const shortEntries = this._shortTerm.get(agentId) ?? [];
		return this._diagnostics.run({
			longTermCount: longEntries.filter(e => !e.supersededBy).length,
			shortTermCount: shortEntries.length,
			bm25: this._bm25.get(agentId),
			vector: this._vector.get(agentId),
			graph: this._graphs.get(agentId),
			audit: this._audit,
			longEntries: longEntries as any[],
			serverAvailable: this._serverAvailable,
			pendingWrites: this._dirtyAgents.size,
		});
	}

	// ─── Slots API ──────────────────────────────────────────────────────────

	/** Get a pinned slot's content */
	getSlot(agentId: string, label: string): string {
		return this._slots.get(agentId, label as any);
	}

	/** Set a pinned slot's content */
	setSlot(agentId: string, label: string, content: string): void {
		this._slots.set(agentId, label as any, content);
		this._audit.record('write', agentId, [], { type: 'slot', label, contentLength: content.length });
	}

	/** Get all slots */
	getSlots(agentId: string): unknown[] {
		return this._slots.getAll(agentId);
	}

	// ─── Lessons API ─────────────────────────────────────────────────────────

	/** Get all lessons for an agent */
	getLessons(agentId: string): Lesson[] {
		return this._lessons.getLessons(agentId);
	}

	/** Get top lessons by confidence */
	getTopLessons(agentId: string, limit: number = 10): Lesson[] {
		return this._lessons.getTopLessons(agentId, limit);
	}

	/** Search lessons by keyword */
	searchLessons(agentId: string, query: string): Lesson[] {
		return this._lessons.search(agentId, query);
	}

	/** Add a manual lesson */
	addLesson(agentId: string, content: string, context?: string, tags?: string[]): Lesson {
		const lesson = this._lessons.add(agentId, content, context, tags);
		this._audit.record('write', agentId, [lesson.id], { type: 'lesson', contentLength: content.length });
		return lesson;
	}

	/** Delete a lesson */
	deleteLesson(agentId: string, lessonId: string): void {
		this._lessons.delete(agentId, lessonId);
		this._audit.record('delete', agentId, [lessonId], { type: 'lesson' });
	}

	// ─── Consolidation API (4-tier) ─────────────────────────────────────────

	getEpisodicMemories(agentId: string): EpisodicMemory[] {
		return this._consolidation.get(agentId)?.getEpisodic(agentId) ?? [];
	}

	getSemanticMemories(agentId: string): SemanticMemory[] {
		return this._consolidation.get(agentId)?.getSemantic(agentId) ?? [];
	}

	getProceduralMemories(agentId: string): ProceduralMemory[] {
		return this._consolidation.get(agentId)?.getProcedural(agentId) ?? [];
	}

	/** Get consolidation context string (Semantic + Procedural) */
	getConsolidationContext(agentId: string): string {
		return this._consolidation.get(agentId)?.buildContext(agentId) ?? '';
	}

	// ─── Relations API ──────────────────────────────────────────────────────

	getRelations(agentId: string, memoryId: string): MemoryRelation[] {
		const graph = this._relations.get(agentId);
		if (!graph) return [];
		return [...graph.getFrom(memoryId), ...graph.getTo(memoryId)];
	}

	getRelationStats(agentId: string): Record<string, number> {
		return this._relations.get(agentId)?.getStats() ?? {};
	}

	// ─── Provenance API ──────────────────────────────────────────────────────

	traceProvenance(agentId: string, memoryId: string): ProvenanceChain | null {
		const tracker = this._provenance.get(agentId);
		if (!tracker) return null;
		return tracker.trace(memoryId);
	}

	verifyProvenance(agentId: string, memoryId: string): { valid: boolean; missingSources: string[] } | null {
		const tracker = this._provenance.get(agentId);
		if (!tracker) return null;
		return tracker.verify(memoryId);
	}

	// ─── Replay API ──────────────────────────────────────────────────────────

	getReplaySession(sessionId: string): ReplaySession | null {
		return this._replay.getSession(sessionId);
	}

	getReplaySessions(agentId: string): ReplaySession[] {
		return this._replay.getSessions(agentId);
	}

	getToolSummary(sessionId: string): Array<{ toolName: string; count: number; avgDurationMs: number; successRate: number }> {
		return this._replay.getToolSummary(sessionId);
	}

	// ─── Enricher API ────────────────────────────────────────────────────────

	enrichFile(agentId: string, filePath: string): EnrichmentResult | null {
		const longEntries = this._longTerm.get(agentId);
		if (!longEntries) return null;
		return this._enricher.enrich(filePath, longEntries as any[]);
	}

	// ─── Working Memory API ──────────────────────────────────────────────────

	setWorkingMemory(agentId: string, key: string, value: string, category?: string): void {
		this._workingMemory.set(agentId, key, value, (category as any) ?? 'note');
	}

	getWorkingMemory(agentId: string, key: string): string | undefined {
		return this._workingMemory.get(agentId, key);
	}

	getAllWorkingMemory(agentId: string): WorkingMemoryItem[] {
		return this._workingMemory.getAll(agentId);
	}

	clearWorkingMemory(agentId: string): void {
		this._workingMemory.clear(agentId);
	}

	// ─── File Index API ──────────────────────────────────────────────────────

	getHotFiles(agentId: string, limit?: number): FileRecord[] {
		return this._fileIndex.getHotFiles(agentId, limit ?? 10);
	}

	getFileStats(agentId: string) {
		return this._fileIndex.getStats(agentId);
	}

	getErrorFiles(agentId: string): FileRecord[] {
		return this._fileIndex.getErrorFiles(agentId);
	}

	// ─── Claude Bridge API ───────────────────────────────────────────────────

	exportToMarkdown(agentId: string, config?: Partial<BridgeConfig>): string {
		const longEntries = this._longTerm.get(agentId) ?? [];
		return this._claudeBridge.export(agentId, longEntries as any[], { enabled: true, maxEntries: 50, maxLineBudget: 200, ...config });
	}

	importFromMarkdown(markdown: string): Array<{ content: string; type: string; importance: number }> {
		return this._claudeBridge.import(markdown);
	}

	// ─── Facets API ──────────────────────────────────────────────────────────

	tagMemory(memoryId: string, dimension: string, value: string): void {
		this._facets.tag(memoryId, 'memory', dimension, value);
	}

	untagMemory(memoryId: string, dimension: string, value: string): void {
		this._facets.untag(memoryId, dimension, value);
	}

	queryByFacets(filters: Record<string, string | string[]>): string[] {
		return this._facets.query(filters);
	}

	getFacetStats(): { totalFacets: number; dimensions: number; targets: number } {
		return this._facets.getStats();
	}

	// ─── Snapshots API ───────────────────────────────────────────────────────

	createSnapshot(agentId: string, label: string): SnapshotMeta | null {
		const entries = this._longTerm.get(agentId);
		if (!entries) return null;
		const mgr = this._snapshots.get(agentId) ?? new SnapshotManager();
		this._snapshots.set(agentId, mgr);
		return mgr.create(agentId, label, entries as any[]);
	}

	listSnapshots(agentId: string): SnapshotMeta[] {
		return this._snapshots.get(agentId)?.list(agentId) ?? [];
	}

	diffSnapshots(agentId: string, fromId: string, toId: string): SnapshotDiff | null {
		return this._snapshots.get(agentId)?.diff(agentId, fromId, toId) ?? null;
	}

	// ─── Signals API ──────────────────────────────────────────────────────────

	sendSignal(from: string, type: SignalType, content: string, opts?: { to?: string; threadId?: string; replyTo?: string }): string {
		return this._signals.send(from, type, content, opts);
	}

	readSignals(agentId: string, opts?: { type?: SignalType; limit?: number }): Signal[] {
		return this._signals.read(agentId, opts);
	}

	getUnreadSignalCount(agentId: string): number {
		return this._signals.getUnreadCount(agentId);
	}

	replySignal(originalId: string, from: string, content: string): string {
		return this._signals.reply(originalId, from, content);
	}

	// ─── Checkpoints API ─────────────────────────────────────────────────────

	createCheckpoint(opts: { name: string; description?: string; type: CheckpointType; expiresInMs?: number }): Checkpoint {
		return this._checkpoints.create(opts);
	}

	resolveCheckpoint(id: string, status: 'passed' | 'failed', resolvedBy: string): boolean {
		return this._checkpoints.resolve(id, status, resolvedBy);
	}

	isCheckpointPassed(id: string): boolean {
		return this._checkpoints.isPassed(id);
	}

	// ─── Disk Management API ──────────────────────────────────────────────────

	getDiskUsage(): DiskUsageStats {
		const agents = Array.from(this._loaded).map(agentId => ({
			agentId,
			shortTermEntries: (this._shortTerm.get(agentId) ?? []).map(e => ({ content: e.content })),
			longTermEntries: (this._longTerm.get(agentId) ?? []).map(e => ({ content: e.content, metadata: e.metadata })),
		}));
		return this._diskManager.estimate({ agents });
	}

	setDiskQuota(mb: number): void {
		this._diskManager.setQuota(mb);
	}

	// ─── Branch-Aware API ────────────────────────────────────────────────────

	/** Register worktree info (from extension host git command) */
	registerWorktree(info: Omit<WorktreeInfo, 'detectedAt'>): WorktreeInfo {
		return this._branchAware.registerWorktree(info);
	}

	/** Get worktree info by cwd */
	getWorktree(cwd: string): WorktreeInfo | null {
		return this._branchAware.getWorktree(cwd);
	}

	/** Generate branch-scoped agentId */
	scopedAgentId(baseAgentId: string, branch: string | null): string {
		return this._branchAware.scopedAgentId(baseAgentId, branch);
	}

	/** List branch sessions for a base agentId */
	listBranchSessions(baseAgentId: string): BranchSession[] {
		return this._branchAware.listBranchSessions(baseAgentId);
	}

	/** Plan merge of memories from one branch to another */
	planBranchMerge(fromScoped: string, toScoped: string, fromEntries: unknown[]): MergeResult {
		return this._branchAware.planMerge(fromScoped, toScoped, fromEntries);
	}

	// ─── Governance API ──────────────────────────────────────────────────────

	private _ensureGovernance(): GovernanceManager {
		if (!this._governance) {
			this._governance = new GovernanceManager(this._audit);
		}
		return this._governance;
	}

	/** Delete memories by exact IDs */
	governanceDelete(agentId: string, ids: string[], reason?: string): GovernanceDeleteResult {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({
			id: e.id, type: e.type, content: e.content, strength: e.strength,
			timestamp: e.timestamp ?? 0, metadata: e.metadata, supersededBy: e.supersededBy,
		}));
		const result = this._ensureGovernance().deleteByIds(
			ids, entries,
			(id: string) => {
				const long = this._longTerm.get(agentId);
				if (!long) return false;
				const idx = long.findIndex(e => e.id === id);
				if (idx < 0) return false;
				const removed = long.splice(idx, 1)[0];
				this._bm25.get(agentId)?.remove(id);
				this._vector.get(agentId)?.remove(id);
				return !!removed;
			},
			reason,
		);
		if (result.deleted > 0) {
			this._schedulePersist(agentId);
		}
		return result;
	}

	/** Bulk filter/delete memories by criteria (supports dryRun) */
	governanceBulk(agentId: string, filter: GovernanceFilter & { dryRun?: boolean }): BulkDeleteResult {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({
			id: e.id, type: e.type, content: e.content, strength: e.strength,
			timestamp: e.timestamp ?? 0, metadata: e.metadata, supersededBy: e.supersededBy,
		}));
		return this._ensureGovernance().bulkFilter(
			filter, entries,
			filter.dryRun ? undefined : (id: string) => {
				const long = this._longTerm.get(agentId);
				if (!long) return false;
				const idx = long.findIndex(e => e.id === id);
				if (idx < 0) return false;
				long.splice(idx, 1);
				this._bm25.get(agentId)?.remove(id);
				this._vector.get(agentId)?.remove(id);
				return true;
			},
		);
	}

	// ─── Retention API ───────────────────────────────────────────────────────

	/** Get retention scores for an agent's memories */
	getRetentionScores(agentId: string): RetentionResult {
		const entries = (this._longTerm.get(agentId) ?? []).filter(e => !e.supersededBy);
		return this._retentionScorer.scoreAll(
			entries.map(e => ({
				id: e.id, type: e.type, content: e.content, strength: e.strength,
				confidence: e.metadata?.['confidence'] as number | undefined,
				importance: e.importance,
				timestamp: e.timestamp ?? Date.now(),
				accessCount: e.accessCount,
				lastAccessedAt: e.lastAccessedAt,
			})),
		);
	}

	/** Get eviction candidates (lowest retention scores) */
	getEvictionCandidates(agentId: string, maxEvict?: number): RetentionScore[] {
		const result = this.getRetentionScores(agentId);
		return this._retentionScorer.getEvictionCandidates(result.scores, maxEvict);
	}

	/** Update retention decay config */
	updateRetentionConfig(config: Partial<DecayConfig>): { success: boolean; error?: string } {
		return this._retentionScorer.updateConfig(config);
	}

	// ─── Routines API ────────────────────────────────────────────────────────

	createRoutine(opts: { name: string; description?: string; steps: Array<Omit<RoutineStep, 'order' | 'dependsOn'> & { order?: number; dependsOn?: number[] }>; tags?: string[]; frozen?: boolean; sourceProceduralIds?: string[] }): Routine | null {
		return this._routines.create(opts);
	}

	getRoutine(id: string): Routine | null {
		return this._routines.get(id);
	}

	listRoutines(filter?: { frozen?: boolean; tags?: string[] }): Routine[] {
		return this._routines.list(filter);
	}

	startRoutineRun(routineId: string, triggeredBy: string): RoutineRun | null {
		return this._routines.startRun(routineId, triggeredBy);
	}

	updateRoutineStep(runId: string, stepOrder: number, status: 'pending' | 'running' | 'done' | 'skipped' | 'failed', result?: string, error?: string): boolean {
		return this._routines.updateStep(runId, stepOrder, status, result, error);
	}

	completeRoutineRun(runId: string, status: 'completed' | 'failed' | 'aborted'): boolean {
		return this._routines.completeRun(runId, status);
	}

	getRoutineHistory(routineId: string, limit?: number): RoutineRun[] {
		return this._routines.getRunHistory(routineId, limit);
	}

	// ─── Cascade API ─────────────────────────────────────────────────────────

	/** Manually trigger cascade from a superseded memory */
	triggerCascade(agentId: string, supersededEntryId: string): CascadeResult | null {
		const entries = this._longTerm.get(agentId);
		if (!entries) return null;
		const superseded = entries.find(e => e.id === supersededEntryId);
		if (!superseded) return null;
		const graph = this._graphs.get(agentId);
		return this._cascade.cascadeFromSupersede(
			{
				id: superseded.id,
				content: superseded.content,
				concepts: (superseded.metadata?.['concepts'] as string[]) ?? [],
				sourceObservationIds: [superseded.id],
			},
			entries.map(e => ({
				id: e.id,
				content: e.content,
				concepts: (e.metadata?.['concepts'] as string[]) ?? [],
				sourceObservationIds: [e.id],
				supersededBy: e.supersededBy,
				metadata: e.metadata,
			})),
			graph,
		);
	}

	// ─── Crystallize API ─────────────────────────────────────────────────────

	crystallizeActions(actions: CrystallizeAction[], edges: Array<{ sourceActionId: string; targetActionId: string; type: 'requires' | 'produces' | 'follows' | 'parallel' }>, opts?: { sessionId?: string; project?: string; customDigest?: CrystalDigest }): Crystal | null {
		return this._crystallize.crystallize(actions, edges, opts);
	}

	getCrystal(id: string): Crystal | null {
		return this._crystallize.get(id);
	}

	listCrystals(filter?: { sessionId?: string; project?: string }): Crystal[] {
		return this._crystallize.list(filter);
	}

	searchCrystals(query: string, limit?: number): Crystal[] {
		return this._crystallize.search(query, limit);
	}

	// ─── Frontier API ────────────────────────────────────────────────────────

	computeFrontier(
		actions: FrontierAction[],
		edges: FrontierEdge[],
		checkpoints: FrontierCheckpoint[],
		leases: Array<{ actionId: string; agentId: string; expiresAt: number; status: 'active' | 'expired' | 'released' }>,
		opts?: { project?: string; agentId?: string; limit?: number; includeLeasedByOthers?: boolean },
	): FrontierItem[] {
		return this._frontier.compute(actions, edges, checkpoints, leases, opts);
	}

	getBlockedActions(
		actions: FrontierAction[],
		edges: FrontierEdge[],
		checkpoints: FrontierCheckpoint[],
	): Array<{ action: FrontierAction; blockers: string[] }> {
		return this._frontier.getBlocked(actions, edges, checkpoints);
	}

	// ─── Smart Search API ────────────────────────────────────────────────────

	async smartSearch(agentId: string, opts: SmartSearchOptions): Promise<SmartSearchResult> {
		await this._ensureLoaded(agentId);
		if (!this._smartSearch) {
			this._smartSearch = new SmartSearch({
				searchFn: async (query: string, limit: number) => {
					const results = await this._hybridSearch(agentId, query, limit);
					return results.map(r => ({
						id: r.id,
						content: r.content,
						score: r.score ?? 0,
					}));
				},
				lessonSearchFn: (query: string) => {
					return this._lessons.search(agentId, query).map(l => ({
						id: l.id,
						content: l.content,
						confidence: l.confidence,
						tags: l.tags,
					}));
				},
			});
		}
		return this._smartSearch.search({ ...opts, agentId });
	}

	getFollowupStats(): FollowupStats {
		return this._smartSearch?.getFollowupStats() ?? { followupWithinWindow: 0, agentInitiatedSearches: 0, rate: 0 };
	}

	// ─── Session Summarize API ───────────────────────────────────────────────

	summarizeSession(sessionId: string, messages: SessionMessage[]): SessionSummary | null {
		return this._summarizer.summarize(sessionId, messages);
	}

	getSessionSummary(sessionId: string): SessionSummary[] {
		return this._summarizer.getBySession(sessionId);
	}

	getLatestSessionSummary(sessionId: string): SessionSummary | null {
		return this._summarizer.getLatest(sessionId);
	}

	searchSessionSummaries(query: string, limit?: number): SessionSummary[] {
		return this._summarizer.search(query, limit);
	}

	// ─── Sliding Window API ──────────────────────────────────────────────────

	private _getSlidingWindow(agentId: string): SlidingWindow {
		let window = this._slidingWindows.get(agentId);
		if (!window) {
			window = new SlidingWindow();
			this._slidingWindows.set(agentId, window);
		}
		return window;
	}

	/** Access a memory in the sliding window (adds or refreshes) */
	accessInWindow(agentId: string, entry: Omit<WindowEntry, 'accessCount' | 'pinned' | 'insertedAt' | 'lastAccessedAt' | 'tokenEstimate'> & { tokenEstimate?: number }): WindowEntry {
		return this._getSlidingWindow(agentId).access(entry);
	}

	/** Get top entries from sliding window within token budget */
	getWindowTop(agentId: string, tokenBudget?: number): WindowEntry[] {
		return this._getSlidingWindow(agentId).getTop(tokenBudget);
	}

	/** Pin a memory in the sliding window */
	pinInWindow(agentId: string, id: string): boolean {
		return this._getSlidingWindow(agentId).pin(id);
	}

	/** Unpin a memory */
	unpinInWindow(agentId: string, id: string): boolean {
		return this._getSlidingWindow(agentId).unpin(id);
	}

	getWindowStats(agentId: string): SlidingWindowStats {
		return this._getSlidingWindow(agentId).getStats();
	}

	// ─── Hooks API ──────────────────────────────────────────────────────────

	/** Register a custom hook */
	registerHook(type: HookType, handler: (ctx: HookContext) => HookResult | Promise<HookResult> | null, priority?: number): string {
		return this._hooks.register(type, handler, priority);
	}

	/** Unregister a hook */
	unregisterHook(id: string): boolean {
		return this._hooks.unregister(id);
	}

	/** Trigger hooks and collect results */
	async triggerHooks(type: HookType, ctx: HookContext): Promise<{ injectContext: string; observeEntries: Array<{ content: string; type: 'working' | 'episodic' | 'semantic' | 'procedural'; metadata?: Record<string, unknown> }>; shouldPersist: boolean }> {
		return this._hooks.triggerAndCollect(type, ctx);
	}

	/**
	 * IMemoryProvider.triggerHook — simplified wrapper for agentOSService lifecycle integration.
	 * Accepts plain string/Record types, converts to HookType/HookContext internally,
	 * and processes results (observe entries written to memory, inject context logged).
	 */
	async triggerHook(type: string, ctx: Record<string, unknown>): Promise<void> {
		const hookType = type as HookType;
		const hookCtx: HookContext = {
			agentId: (ctx['agentId'] as string) ?? 'default',
			sessionId: (ctx['sessionId'] as string) ?? '',
			timestamp: (ctx['timestamp'] as number) ?? Date.now(),
			cwd: ctx['cwd'] as string | undefined,
			project: ctx['project'] as string | undefined,
			...ctx,
		};
		const result = await this._hooks.triggerAndCollect(hookType, hookCtx);
		// Process observe entries — write them to memory
		for (const entry of result.observeEntries) {
			try {
				await this.writeMemory(hookCtx.agentId, {
					id: `hook-${hookType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					type: entry.type,
					content: entry.content,
					metadata: { ...entry.metadata, source: `hook:${hookType}`, sessionId: hookCtx.sessionId },
					timestamp: hookCtx.timestamp,
				});
			} catch { /* ignore hook-induced write failures */ }
		}
	}

	/** Get hook stats */
	getHookStats(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } {
		return this._hooks.getStats();
	}

	/** List registered hooks */
	listHooks(type?: HookType): HookRegistration[] {
		return this._hooks.list(type);
	}

	// ─── Verify API ──────────────────────────────────────────────────────────

	/** Verify a memory's source citations */
	verifyMemory(agentId: string, memoryId: string): VerifyResult | null {
		const entries = this._longTerm.get(agentId) ?? [];
		const entry = entries.find(e => e.id === memoryId);
		if (!entry) return null;
		const verifyEntries: VerifyEntry[] = entries.map(e => ({
			id: e.id, content: e.content, type: e.type, metadata: e.metadata, timestamp: e.timestamp ?? 0, supersededBy: e.supersededBy,
		}));
		const verifyEntry: VerifyEntry = { id: entry.id, content: entry.content, type: entry.type, metadata: entry.metadata, timestamp: entry.timestamp ?? 0, supersededBy: entry.supersededBy };
		const provenance = this._provenance.get(agentId);
		const trace = provenance ? provenance.trace(memoryId) : undefined;
		const sources = trace && trace.chain.length > 0 ? trace.chain[0].sourceMemoryIds : undefined;
		return this._verifier.verify(memoryId, verifyEntry, verifyEntries, sources);
	}

	/** Verify all memories */
	verifyAllMemories(agentId: string): { total: number; valid: number; partial: number; invalid: number; orphan: number; results: VerifyResult[] } {
		const entries = this._longTerm.get(agentId) ?? [];
		const verifyEntries: VerifyEntry[] = entries.map(e => ({
			id: e.id, content: e.content, type: e.type, metadata: e.metadata, timestamp: e.timestamp ?? 0, supersededBy: e.supersededBy,
		}));
		return this._verifier.verifyAll(verifyEntries);
	}

	/** Get citations for a memory */
	getMemoryCitations(agentId: string, memoryId: string): Citation[] {
		const entries = this._longTerm.get(agentId) ?? [];
		const verifyEntries: VerifyEntry[] = entries.map(e => ({
			id: e.id, content: e.content, type: e.type, metadata: e.metadata, timestamp: e.timestamp ?? 0, supersededBy: e.supersededBy,
		}));
		return this._verifier.getCitations(memoryId, verifyEntries);
	}

	// ─── Team Memory API ─────────────────────────────────────────────────────

	/** Initialize team memory (call once per team) */
	initTeamMemory(config: TeamConfig): void {
		this._teamMemory = new TeamMemoryManager(config);
	}

	/** Share a memory to team */
	shareToTeam(itemId: string, itemType: SharedItemType, content: string, metadata?: Record<string, unknown>, project?: string): TeamSharedItem | null {
		if (!this._teamMemory) return null;
		return this._teamMemory.shareItem({ itemId, itemType, content, metadata, project });
	}

	/** Get team feed */
	getTeamFeed(limit?: number, type?: SharedItemType): TeamSharedItem[] {
		return this._teamMemory?.getFeed({ limit, type }) ?? [];
	}

	/** Get team profile */
	getTeamProfile(): TeamProfile | null {
		return this._teamMemory?.getProfile() ?? null;
	}

	/** Broadcast to team */
	broadcastToTeam(from: string, content: string): BroadcastMessage | null {
		return this._teamMemory?.broadcast(from, content) ?? null;
	}

	// ─── Leases API ───────────────────────────────────────────────────────────

	/** Acquire a lease on an action */
	acquireLease(actionId: string, agentId: string, ttlMs?: number): AcquireResult {
		return this._leases.acquire(actionId, agentId, ttlMs);
	}

	/** Release a lease */
	releaseLease(actionId: string, agentId: string): boolean {
		return this._leases.release(actionId, agentId);
	}

	/** Renew a lease */
	renewLease(leaseId: string, ttlMs?: number): AcquireResult {
		return this._leases.renew(leaseId, ttlMs);
	}

	/** Check if an action is leased */
	isActionLeased(actionId: string): boolean {
		return this._leases.isLeased(actionId);
	}

	/** Get active leases */
	getActiveLeases(): Lease[] {
		return this._leases.getActiveLeases();
	}

	// ─── Skill Extract API ────────────────────────────────────────────────────

	/** Extract a skill from a completed session */
	extractSkill(input: SkillExtractInput): ExtractedSkill | null {
		return this._skillExtractor.extract(input);
	}

	/** Get a skill by ID */
	getSkill(id: string): ExtractedSkill | null {
		return this._skillExtractor.get(id);
	}

	/** List all skills */
	listSkills(filter?: { tags?: string[]; minConfidence?: number }): ExtractedSkill[] {
		return this._skillExtractor.list(filter);
	}

	/** Search skills */
	searchSkills(query: string, limit?: number): ExtractedSkill[] {
		return this._skillExtractor.search(query, limit);
	}

	/** Mark a skill as used */
	markSkillUsed(id: string): boolean {
		return this._skillExtractor.markUsed(id);
	}

	// ─── Temporal Graph API ──────────────────────────────────────────────────

	/** Get active temporal relationships for an agent */
	getTemporalRelationships(agentId: string, atTime?: number): TemporalEdge[] {
		const graph = this._temporalGraphs.get(agentId);
		if (!graph) return [];
		// Return all active edges
		const nodes = Array.from({ length: 0 });  // just get all edges
		const edges: TemporalEdge[] = [];
		// We need to iterate all nodes to get edges
		for (const node of this._getAllTemporalNodes(agentId)) {
			edges.push(...graph.getActiveRelationships(node.id, atTime));
		}
		// Deduplicate
		const seen = new Set<string>();
		return edges.filter(e => {
			if (seen.has(e.id)) return false;
			seen.add(e.id);
			return true;
		});
	}

	private _getAllTemporalNodes(agentId: string): TemporalNode[] {
		const graph = this._temporalGraphs.get(agentId);
		if (!graph) return [];
		// Access internal nodes via getStats workaround
		const stats = graph.getStats();
		if (stats.nodes === 0) return [];
		// We don't have a direct getNodes() method, return empty for now
		// (the temporal graph is used internally for enrichment)
		return [];
	}

	/** Detect temporal conflicts */
	detectTemporalConflicts(agentId: string): TemporalConflict[] {
		const graph = this._temporalGraphs.get(agentId);
		return graph?.detectTemporalConflicts() ?? [];
	}

	/** Get temporal graph stats */
	getTemporalGraphStats(agentId: string): { nodes: number; edges: number; ongoingEdges: number; endedEdges: number; avgVersionPerEdge: number } {
		return this._temporalGraphs.get(agentId)?.getStats() ?? { nodes: 0, edges: 0, ongoingEdges: 0, endedEdges: 0, avgVersionPerEdge: 0 };
	}

	// ─── Flow Compress API ───────────────────────────────────────────────────

	/** Compress a flow of entries */
	compressFlow(agentId: string, entries: FlowEntry[]): FlowCompressResult {
		return this._flowCompressor.compress(agentId, entries);
	}

	/** Get flow patterns for an agent */
	getFlowPatterns(agentId: string): FlowPattern[] {
		return this._flowCompressor.getPatterns(agentId);
	}

	/** Get flow compress stats */
	getFlowStats(agentId?: string): { totalPatterns: number; patternsByType: Record<string, number>; avgRepetition: number } {
		return this._flowCompressor.getStats(agentId);
	}

	// ─── Export/Import API ──────────────────────────────────────────────────

	/** Export memories as JSON */
	exportJson(agentId: string): string {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({
			id: e.id, type: e.type, content: e.content, timestamp: e.timestamp ?? 0,
			importance: e.importance, strength: e.strength, accessCount: e.accessCount,
			metadata: e.metadata, supersededBy: e.supersededBy,
		}));
		const shortCount = (this._shortTerm.get(agentId) ?? []).length;
		return this._exportImport.exportJson(agentId, entries, shortCount);
	}

	/** Export memories as Markdown */
	exportMarkdown(agentId: string): string {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({
			id: e.id, type: e.type, content: e.content, timestamp: e.timestamp ?? 0,
			importance: e.importance, strength: e.strength, accessCount: e.accessCount,
			metadata: e.metadata, supersededBy: e.supersededBy,
		}));
		return this._exportImport.exportMarkdown(agentId, entries);
	}

	/** Export memories as Obsidian format */
	exportObsidian(agentId: string): string {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({
			id: e.id, type: e.type, content: e.content, timestamp: e.timestamp ?? 0,
			importance: e.importance, strength: e.strength, accessCount: e.accessCount,
			metadata: e.metadata, supersededBy: e.supersededBy,
		}));
		return this._exportImport.exportObsidian(agentId, entries);
	}

	/** Import from JSON */
	importJson(json: string): ImportResult {
		return this._exportImport.importJson(json);
	}

	/** Import from Markdown */
	importMarkdown(md: string): ImportResult {
		return this._exportImport.importMarkdown(md);
	}

	// ─── Bloom Filter API ───────────────────────────────────────────────────

	/** Get bloom filter stats for an agent */
	getBloomFilterStats(agentId: string): { count: number; capacity: number; bitSize: number; hashCount: number; fillRatio: number; estimatedFalsePositiveRate: number; memoryBytes: number } | null {
		return this._bloomFilters.get(agentId)?.getStats() ?? null;
	}

	// ─── Recent Searches API ────────────────────────────────────────────────

	/** Get search history for an agent */
	getSearchHistory(agentId: string, limit?: number): SearchHistoryEntry[] {
		return this._recentSearches.getHistory(agentId, limit);
	}

	/** Get search stats */
	getSearchStats(agentId?: string): SearchHistoryStats {
		return this._recentSearches.getStats(agentId);
	}

	/** Get zero-result queries (for search improvement) */
	getZeroResultQueries(agentId?: string, limit?: number): Array<{ query: string; count: number; lastSearched: number }> {
		return this._recentSearches.getZeroResultQueries(agentId, limit);
	}

	/** Get search suggestions based on history */
	getSearchSuggestions(agentId: string, partialQuery: string, limit?: number): string[] {
		return this._recentSearches.getSuggestions(agentId, partialQuery, limit);
	}

	// ─── Access Tracker API ──────────────────────────────────────────────────

	/** Get access log for a memory */
	getAccessLog(memoryId: string): AccessLog {
		return this._accessTracker.get(memoryId);
	}

	/** Get top accessed memories for an agent */
	getTopAccessedMemories(agentId: string, limit?: number): Array<{ memoryId: string; count: number; lastAt: string }> {
		return this._accessTracker.getTopAccessed(agentId, limit);
	}

	/** Get recently accessed memories for an agent */
	getRecentlyAccessedMemories(agentId: string, limit?: number): Array<{ memoryId: string; lastAt: string; count: number }> {
		return this._accessTracker.getRecentlyAccessed(agentId, limit);
	}

	/** Get access stats */
	getAccessTrackerStats(): { totalTracked: number; totalAccesses: number; avgAccessPerMemory: number } {
		return this._accessTracker.getStats();
	}

	// ─── Circuit Breaker API ────────────────────────────────────────────────

	/** Get circuit breaker state for a service */
	getCircuitBreakerState(name: string): CircuitBreakerState | null {
		return this._circuitRegistry.get(name).getState();
	}

	/** Get all circuit breaker states */
	getAllCircuitBreakerStates(): Record<string, CircuitBreakerState> {
		return this._circuitRegistry.getAllStates();
	}

	/** Check if a service is available (circuit closed) */
	isServiceAvailable(name: string): boolean {
		return this._circuitRegistry.isAllowed(name);
	}

	/** Reset all circuit breakers */
	resetCircuitBreakers(): void {
		this._circuitRegistry.resetAll();
	}

	// ─── Sentinels API ───────────────────────────────────────────────────────

	createSentinel(opts: { name: string; type: SentinelType; config?: SentinelConfig; linkedActionIds?: string[]; expiresInMs?: number }): Sentinel | null {
		return this._sentinelManager.create(opts);
	}

	evaluateSentinels(metrics: Record<string, number>): SentinelTrigger[] {
		return this._sentinelManager.evaluate(metrics);
	}

	evaluatePatternSentinels(text: string): SentinelTrigger[] {
		return this._sentinelManager.evaluatePattern(text);
	}

	getTriggeredSentinels(): Sentinel[] {
		return this._sentinelManager.getTriggered();
	}

	listSentinels(filter?: { type?: SentinelType; status?: Sentinel['status'] }): Sentinel[] {
		return this._sentinelManager.list(filter);
	}

	getSentinelStats(): { total: number; active: number; triggered: number; resolved: number; expired: number; totalTriggers: number } {
		return this._sentinelManager.getStats();
	}

	// ─── Migration API ───────────────────────────────────────────────────────

	migrateMemories(agentId: string, targetVersion?: number, dryRun?: boolean): MigrationResult {
		const entries = (this._longTerm.get(agentId) ?? []) as unknown as MigratableEntry[];
		return this._migrationManager.migrate(entries, targetVersion, dryRun);
	}

	getMigrationStats(agentId?: string): { total: number; byVersion: Record<number, number>; needsMigration: number; currentVersion: number } {
		const entries = agentId
			? (this._longTerm.get(agentId) ?? []) as unknown as MigratableEntry[]
			: Array.from(this._longTerm.values()).flat() as unknown as MigratableEntry[];
		return this._migrationManager.getMigrationStats(entries);
	}

	getCurrentDataVersion(): number {
		return this._migrationManager.getCurrentVersion();
	}

	// ─── Image Refs API ─────────────────────────────────────────────────────

	incrementImageRef(filePath: string, memoryId?: string, sizeBytes?: number): ImageRef {
		return this._imageRefs.increment(filePath, memoryId, sizeBytes);
	}

	decrementImageRef(filePath: string, memoryId?: string): { refCount: number; orphaned: boolean } {
		return this._imageRefs.decrement(filePath, memoryId);
	}

	getImageRefStats(): ImageRefStats {
		return this._imageRefs.getStats();
	}

	cleanupOrphanedImages(maxAgeMs?: number): { cleaned: number; freedBytes: number } {
		return this._imageRefs.cleanupOrphaned(maxAgeMs);
	}

	// ─── Mesh Coordination API ──────────────────────────────────────────────

	registerMeshNode(agentId: string, capabilities?: string[], metadata?: Record<string, unknown>): MeshNode {
		return this._meshCoord.registerNode(agentId, capabilities, metadata);
	}

	meshHeartbeat(agentId: string, load?: number): boolean {
		return this._meshCoord.heartbeat(agentId, load);
	}

	discoverMeshNodes(capability?: string): MeshNode[] {
		return this._meshCoord.discoverNodes(capability);
	}

	distributeTask(taskId: string, requiredCapability?: string, strategy?: DistributionStrategy): TaskDistribution | null {
		return this._meshCoord.distributeTask(taskId, requiredCapability, strategy);
	}

	getMeshTopology(): MeshTopology {
		return this._meshCoord.getMeshTopology();
	}

	routeMeshMessage(from: string, to: string, content: string, type?: MeshMessage['type']): MeshMessage | null {
		return this._meshCoord.routeMessage(from, to, content, type);
	}

	// ─── Context Builder API ────────────────────────────────────────────────

	buildContext(sources: ContextSource[], budget?: number): ContextBuildResult {
		return this._contextBuilder.build(sources, budget);
	}

	getContextBudget(): number {
		return this._contextBuilder.getDefaultBudget();
	}

	setContextBudget(budget: number): void {
		this._contextBuilder.setDefaultBudget(budget);
	}

	// ─── Health Monitor API ─────────────────────────────────────────────────

	private _ensureHealthMonitor(): HealthMonitor {
		if (!this._healthMonitor) {
			this._healthMonitor = new HealthMonitor({
				circuitRegistry: this._circuitRegistry,
				sentinelManager: this._sentinelManager,
				diagnostics: this._diagnostics,
			});
			// Register default health checks
			this._healthMonitor.registerCheck('file-server', 'infrastructure', () => {
				const ok = this._serverAvailable;
				return { status: ok ? 'pass' : 'warn', message: ok ? '文件服务器运行中' : '文件服务器不可用' };
			}, 60_000);
			this._healthMonitor.registerCheck('memory-count', 'capacity', () => {
				let total = 0;
				for (const entries of this._longTerm.values()) total += entries.length;
				return {
					status: total > 5000 ? 'warn' : 'pass',
					message: `Total memories: ${total}`,
					metrics: { totalMemories: total },
				};
			}, 300_000);
		}
		return this._healthMonitor;
	}

	async runHealthChecks(): Promise<HealthSnapshot> {
		return this._ensureHealthMonitor().runAllChecks();
	}

	getHealthSummary(): HealthSnapshot | null {
		return this._healthMonitor?.getHealthSummary() ?? null;
	}

	getHealthTrends(limit?: number): HealthTrend[] {
		return this._healthMonitor?.getTrends(limit) ?? [];
	}

	getActiveAlerts(): HealthAlert[] {
		return this._healthMonitor?.getActiveAlerts() ?? [];
	}

	startHealthMonitoring(intervalMs?: number): void {
		this._ensureHealthMonitor().startMonitoring(intervalMs);
	}

	stopHealthMonitoring(): void {
		this._healthMonitor?.stopMonitoring();
	}

	// ─── Access Patterns API ────────────────────────────────────────────────

	analyzeAccessPattern(memoryId: string): AccessPattern {
		const log = this._accessTracker.get(memoryId);
		return this._patternAnalyzer.analyze(memoryId, log.recent);
	}

	detectAccessBursts(memoryId: string): BurstDetection {
		const log = this._accessTracker.get(memoryId);
		return this._patternAnalyzer.detectBursts(memoryId, log.recent);
	}

	getHotMemories(agentId: string, limit?: number): Array<{ memoryId: string; frequency: number; pattern: string }> {
		const logs = this._accessTracker.getByAgent(agentId);
		return this._patternAnalyzer.getHotMemories(logs, limit);
	}

	getColdMemories(agentId: string, limit?: number): Array<{ memoryId: string; lastAccessAt: number; dormantDays: number }> {
		const logs = this._accessTracker.getByAgent(agentId);
		return this._patternAnalyzer.getColdMemories(logs, limit);
	}

	getAccessHeatmap(agentId: string): AccessHeatmap {
		const logs = this._accessTracker.getByAgent(agentId);
		const allTimestamps = logs.flatMap(l => l.recent);
		return this._patternAnalyzer.getAccessHeatmap(allTimestamps);
	}

	getAccessPatternStats(agentId: string): { totalAnalyzed: number; byPattern: Record<string, number>; avgFrequency: number; hotCount: number; dormantCount: number } {
		const logs = this._accessTracker.getByAgent(agentId);
		return this._patternAnalyzer.getStats(logs);
	}

	// ─── Quota Manager API ───────────────────────────────────────────────────

	/** Check quota for an agent */
	checkQuota(agentId: string, usage: { longTermCount: number; shortTermCount: number; tokenEstimate: number; imageStorageBytes: number; sessionCount: number; auditLogEntries: number }): QuotaCheckResult {
		return this._quotaManager.check(agentId, usage);
	}

	/** Update quota config */
	updateQuotaConfig(config: Partial<QuotaConfig>): void {
		this._quotaManager.updateConfig(config);
	}

	getQuotaConfig(): QuotaConfig { return this._quotaManager.getConfig(); }
	getQuotaStats(): { violationCount: number; agentsTracked: number; config: QuotaConfig } { return this._quotaManager.getStats(); }

	// ─── Event Bus API ───────────────────────────────────────────────────────

	/** Subscribe to an event */
	onEvent(eventType: EventType | '*', handler: (event: MemoryEvent) => void | Promise<void>): string {
		return this._eventBus.on(eventType, handler);
	}

	/** Subscribe once */
	onEventOnce(eventType: EventType, handler: (event: MemoryEvent) => void | Promise<void>): string {
		return this._eventBus.once(eventType, handler);
	}

	/** Unsubscribe */
	offEvent(subscriptionId: string): boolean {
		return this._eventBus.off(subscriptionId);
	}

	/** Emit event */
	async emitEvent(event: Omit<MemoryEvent, 'timestamp'>): Promise<void> {
		await this._eventBus.emit(event);
	}

	// ─── IMemoryProvider lifecycle event subscriptions ──────────────────────
	// 桥接 _eventBus 的 memory_written / memory_write_failed 事件到 IMemoryProvider 接口，
	// 使聊天 UI 能订阅真实的写入结果（替代旧的 fire-and-forget + 假"已保存"信号）。

	onMemoryWritten(handler: (agentId: string, data: { memoryId: string; noticeId?: string; memoryType?: string; contentLength?: number }) => void): () => void {
		const subId = this._eventBus.on('memory_written', (event) => {
			handler(event.agentId ?? '', {
				memoryId: (event.data?.['memoryId'] as string) ?? '',
				noticeId: event.data?.['noticeId'] as string | undefined,
				memoryType: event.data?.['memoryType'] as string | undefined,
				contentLength: event.data?.['contentLength'] as number | undefined,
			});
		});
		return () => { this._eventBus.off(subId); };
	}

	onMemoryWriteFailed(handler: (agentId: string, data: { noticeId?: string; error: string; memoryType?: string }) => void): () => void {
		const subId = this._eventBus.on('custom', (event) => {
			if (event.data?.['event'] !== 'memory_write_failed') return;
			handler(event.agentId ?? '', {
				noticeId: event.data?.['noticeId'] as string | undefined,
				error: (event.data?.['error'] as string) ?? 'Unknown error',
				memoryType: event.data?.['memoryType'] as string | undefined,
			});
		});
		return () => { this._eventBus.off(subId); };
	}

	/** Get event history */
	getEventHistory(limit?: number, type?: EventType): MemoryEvent[] {
		return this._eventBus.getHistory(limit, type);
	}

	getEventBusStats(): { totalSubscriptions: number; subscriptionsByType: Record<string, number>; wildcardSubscriptions: number; totalEventsEmitted: number } {
		return this._eventBus.getStats();
	}

	// ─── Rate Limiter API ──────────────────────────────────────────────────

	/** Try to acquire tokens for a rate-limited operation */
	tryAcquireTokens(name: string, tokens?: number): RateLimitResult {
		return this._rateLimiters.tryAcquire(name, tokens);
	}

	/** Get rate limiter stats */
	getRateLimiterStats(): Record<string, { totalRequests: number; rejectedRequests: number; rejectionRate: number; currentTokens: number; capacity: number }> {
		return this._rateLimiters.getAllStats();
	}

	// ─── Metrics Collector API ──────────────────────────────────────────────

	/** Measure async operation latency */
	async measureOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		return this._metrics.measure(operation, fn);
	}

	/** Get operation stats */
	getOperationStats(operation: string): OperationStats | null {
		return this._metrics.getOperationStats(operation);
	}

	/** Get all metrics summary */
	getMetricsSummary(): MetricsSummary {
		return this._metrics.getSummary();
	}

	/** Set a gauge value */
	setGauge(name: string, value: number): void { this._metrics.setGauge(name, value); }

	// ─── Notification Hub API ──────────────────────────────────────────────

	/** Send a notification */
	notify(opts: { channel: NotificationChannel; priority?: NotificationPriority; title: string; message: string; source: string; agentId?: string; dedupKey?: string }): Notification | null {
		return this._notifications.notify(opts);
	}

	/** Subscribe to notifications */
	subscribeToNotifications(handler: (notification: Notification) => void): () => void {
		return this._notifications.subscribe(handler);
	}

	/** Get unread notifications */
	getUnreadNotifications(agentId?: string, limit?: number): Notification[] {
		return this._notifications.getUnread(agentId, limit);
	}

	/** Mark notification as read */
	markNotificationRead(id: string): boolean {
		return this._notifications.markRead(id);
	}

	getNotificationStats(agentId?: string): NotificationStats {
		return this._notifications.getStats(agentId);
	}

	// ─── Subagent Tracker API ──────────────────────────────────────────────

	/** Start a subagent */
	startSubagent(parentAgentId: string | null, task: string): SubagentRecord | null {
		return this._subagentTracker.start(parentAgentId, task);
	}

	/** Stop a subagent */
	stopSubagent(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean {
		return this._subagentTracker.stop(agentId, status, result, error);
	}

	/** Get subagent record */
	getSubagent(agentId: string): SubagentRecord | null {
		return this._subagentTracker.get(agentId);
	}

	/** Get children of an agent */
	getSubagentChildren(parentId: string): SubagentRecord[] {
		return this._subagentTracker.getChildren(parentId);
	}

	/** Get delegation tree */
	getDelegationTree(rootId: string): DelegationNode | null {
		return this._subagentTracker.getDelegationTree(rootId);
	}

	getSubagentStats(): { totalAgents: number; running: number; completed: number; failed: number; cancelled: number; avgDurationMs: number; maxDepth: number } {
		return this._subagentTracker.getStats();
	}

	// ─── Pre-Compact Injector API ──────────────────────────────────────────

	/** Prepare context to inject before compaction */
	preparePreCompactInjection(ctx: { sessionId: string; agentId: string; currentMessages: Array<{ role: string; content: string; timestamp: number }>; tokenBudget: number }): PreCompactResult {
		const entries = (this._longTerm.get(ctx.agentId) ?? []).map(e => ({
			id: e.id, content: e.content, score: e.strength, importance: e.importance,
			type: e.type, timestamp: e.timestamp ?? 0, metadata: e.metadata,
		}));
		const slots = [
			{ name: 'persona', content: this._slots.get(ctx.agentId, 'persona' as any) },
			{ name: 'guidance', content: this._slots.get(ctx.agentId, 'guidance' as any) },
		].filter(s => s.content.length > 0);
		const windowEntries = this._getSlidingWindow(ctx.agentId).getAll().map(w => ({ id: w.id, content: w.content }));
		return this._preCompactInjector.prepare(ctx, entries, slots, windowEntries);
	}

	// ─── Post-Commit Capture API ───────────────────────────────────────────

	/** Capture a git commit */
	captureCommit(commit: CommitInfo): CommitMemoryEntry {
		return this._postCommitCapture.capture(commit);
	}

	/** Get recent commits */
	getRecentCommits(limit?: number): CommitMemoryEntry[] {
		return this._postCommitCapture.getRecent(limit);
	}

	/** Search commits */
	searchCommits(query: string, limit?: number): CommitMemoryEntry[] {
		return this._postCommitCapture.search(query, limit);
	}

	getCommitStats(): CommitStats {
		return this._postCommitCapture.getStats();
	}

	// ─── Priority Queue API ────────────────────────────────────────────────

	/** Enqueue a write operation */
	enqueueWrite(agentId: string, entry: IMemoryEntry, priority?: QueuePriority): string {
		return this._writeQueue.enqueue({ agentId, entry }, priority);
	}

	/** Get write queue stats */
	getWriteQueueStats(): PriorityQueueStats {
		return this._writeQueue.getStats();
	}

	/** Get write queue size */
	getWriteQueueSize(): number {
		return this._writeQueue.size;
	}

	// ─── Config Manager API ─────────────────────────────────────────────────

	getSystemConfig(): MemorySystemConfig { return this._configManager.get(); }
	setConfig(path: string, value: unknown): { success: boolean; error?: string } { return this._configManager.set(path, value); }
	updateConfig(updates: Record<string, unknown>): { success: boolean; errors: string[] } { return this._configManager.update(updates); }
	resetConfig(): void { this._configManager.reset(); }
	exportConfig(): string { return this._configManager.export(); }
	importConfig(json: string): { success: boolean; error?: string } { return this._configManager.import(json); }

	/**
	 * Apply config values to instance fields (called on init + on config change).
	 * This is the hot-reload mechanism: when ConfigManager.onChange fires,
	 * this method re-reads config and updates the search weights, RRF k, etc.
	 */
	private _applyConfig(): void {
		const searchCfg = this._configManager.getSection('search');
		this._rrfK = searchCfg.rrfK;
		this._searchWeights = {
			bm25: searchCfg.bm25Weight,
			vector: searchCfg.vectorWeight,
			graph: searchCfg.graphWeight,
			text: searchCfg.textWeight,
			maxPerSession: searchCfg.maxPerSession,
		};
	}

	// ─── Unified Scorer API ────────────────────────────────────────────────

	scoreMemory(input: ScoreInput): { total: number; breakdown: ScoreBreakdown } { return this._unifiedScorer.score(input); }
	scoreAndRankMemories(entries: Array<{ id: string } & ScoreInput>, limit?: number): Array<{ id: string; score: number; breakdown: ScoreBreakdown }> { return this._unifiedScorer.scoreAndRank(entries, limit); }
	updateScoreWeights(weights: Partial<ScoreWeights>): void { this._unifiedScorer.updateWeights(weights); }

	// ─── Fuzzy Search API ─────────────────────────────────────────────────

	fuzzySearch(agentId: string, query: string, options?: FuzzySearchOptions): FuzzyResult[] {
		const entries = (this._longTerm.get(agentId) ?? []).filter(e => !e.supersededBy).map(e => ({ id: e.id, content: e.content }));
		return this._fuzzySearcher.search(query, entries, options);
	}

	fuzzySuggest(agentId: string, partialQuery: string, limit?: number): string[] {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({ id: e.id, content: e.content }));
		return this._fuzzySearcher.suggest(partialQuery, entries, limit);
	}

	// ─── Index Rebuilder API ──────────────────────────────────────────────

	async rebuildIndex(agentId: string): Promise<RebuildStatus> {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({ id: e.id, content: e.content }));
		return this._indexRebuilder.rebuild(
			agentId, entries,
			() => new BM25Index(),
			() => new VectorIndex(),
			(newBm25, newVector) => {
				this._bm25.set(agentId, newBm25);
				this._vector.set(agentId, newVector);
			},
		);
	}

	checkIndexIntegrity(agentId: string): IntegrityResult | null {
		const entries = (this._longTerm.get(agentId) ?? []).map(e => ({ id: e.id, content: e.content }));
		const bm25 = this._bm25.get(agentId);
		const vector = this._vector.get(agentId);
		if (!bm25 || !vector) return null;
		return this._indexRebuilder.checkIntegrity(agentId, entries, bm25, vector);
	}

	getRebuildStatus(agentId: string): RebuildStatus | null { return this._indexRebuilder.getStatus(agentId); }
	isIndexRebuilding(agentId: string): boolean { return this._indexRebuilder.isRebuilding(agentId); }

	// ─── Diff Compressor API ──────────────────────────────────────────────

	storeVersionedContent(id: string, content: string): VersionedContent { return this._diffCompressor.storeVersion(id, content); }
	reconstructVersion(id: string, version?: number): string | null { return this._diffCompressor.reconstruct(id, version); }
	diffContent(oldText: string, newText: string): DiffResult { return this._diffCompressor.diff(oldText, newText); }

	// ─── Concurrent Lock API ──────────────────────────────────────────────

	async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> { return this._concurrentLock.withLock(agentId, fn); }
	getLockStats(): { totalAcquired: number; totalReleased: number; totalWaited: number; totalTimedOut: number; activeLocks: number; queuedOperations: number } { return this._concurrentLock.getStats(); }

	// ─── Batch Processor API ──────────────────────────────────────────────

	async batchWrite(agentId: string, items: BatchWriteItem[]): Promise<BatchWriteResult> {
		return this._batchProcessor.batchWrite(agentId, items, async (aid, item) => {
			await this.writeMemory(aid, {
				id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				type: item.type, content: item.content, importance: item.importance,
				metadata: item.metadata, timestamp: item.timestamp ?? Date.now(),
			});
			return { written: true, deduplicated: false, compressed: item.content.length > 100 };
		});
	}

	async batchSearch(agentId: string, queries: string[]): Promise<BatchSearchResult> {
		return this._batchProcessor.batchSearch(agentId, queries, async (aid, q) => this.searchMemory(aid, q));
	}

	// ─── Session Replay API ──────────────────────────────────────────────

	recordReplayEvent(event: Omit<SessionReplayEvent, 'id'>): SessionReplayEvent { return this._sessionReplay.record(event); }
	replaySession(sessionId: string): SessionReplayEvent[] { return this._sessionReplay.replay(sessionId); }
	getSessionTimeline(sessionId: string): SessionTimeline | null { return this._sessionReplay.getTimeline(sessionId); }
	compareSessions(sessionA: string, sessionB: string): SessionDiff | null { return this._sessionReplay.compare(sessionA, sessionB); }
	listReplaySessions(): Array<{ sessionId: string; eventCount: number; startTime: number; endTime: number }> { return this._sessionReplay.listSessions(); }

	// ─── Report Generator API ─────────────────────────────────────────────

	async generateReport(type?: ReportType, agentId?: string): Promise<SystemReport> {
		if (!this._reportGenerator) {
			this._reportGenerator = new ReportGenerator({
				getStats: (aid) => this.getStats(aid ?? agentId ?? ''),
				getHealthSummary: () => this.getHealthSummary(),
				getActiveAlerts: () => this.getActiveAlerts(),
				getMetricsSummary: () => this.getMetricsSummary(),
				getAccessTrackerStats: () => this.getAccessTrackerStats(),
				getAccessPatternStats: (aid) => this.getAccessPatternStats(aid ?? agentId ?? ''),
				getSearchStats: (aid) => this.getSearchStats(aid),
				getQuotaStats: () => this.getQuotaStats(),
				getAllCircuitBreakerStates: () => this.getAllCircuitBreakerStates(),
				getNotificationStats: () => this.getNotificationStats(),
				getRateLimiterStats: () => this.getRateLimiterStats(),
				getSubagentStats: () => this.getSubagentStats(),
				getEventBusStats: () => this.getEventBusStats(),
				getWriteQueueStats: () => this.getWriteQueueStats(),
				getImageRefStats: () => this.getImageRefStats(),
				getMeshTopology: () => this.getMeshTopology(),
				getCommitStats: () => this.getCommitStats(),
				getFlowStats: (aid) => this.getFlowStats(aid),
			});
		}
		return this._reportGenerator.generate(type, agentId);
	}

	// ─── Actions API (1:1 parity) ──────────────────────────────────────────

	createAction(opts: { title: string; description?: string; priority?: number; createdBy?: string; project?: string; tags?: string[]; parentId?: string }): Action | null { return this._actionManager.create(opts); }
	updateAction(id: string, updates: Partial<Pick<Action, 'title' | 'description' | 'priority' | 'status' | 'tags' | 'assignedTo'>>): boolean { return this._actionManager.update(id, updates); }
	getAction(id: string): Action | null { return this._actionManager.get(id); }
	listActions(filter?: { status?: ActionStatus; project?: string; tags?: string[] }): Action[] { return this._actionManager.list(filter); }
	addActionEdge(sourceId: string, targetId: string, type: ActionEdgeType): boolean { return this._actionManager.addEdge(sourceId, targetId, type); }
	getActionEdges(actionId: string): ActionEdge[] { return this._actionManager.getEdges(actionId); }
	getActionChildren(parentId: string): Action[] { return this._actionManager.getChildren(parentId); }
	deleteAction(id: string): boolean { return this._actionManager.delete(id); }
	getActionStats(): { total: number; byStatus: Record<string, number>; totalEdges: number; blocked: number } { return this._actionManager.getStats(); }

	// ─── Eviction API (1:1 parity) ─────────────────────────────────────────

	evictMemories(entries: EvictEntry[], dryRun?: boolean): { evicted: EvictEntry[]; stats: EvictionStats } { return this._evictionManager.evict(entries, dryRun); }
	updateEvictionConfig(config: Partial<EvictionConfig>): void { this._evictionManager.updateConfig(config); }

	// ─── File Compression API (1:1 parity) ────────────────────────────────

	compressFileContent(content: string): FileCompressionResult { return this._fileCompressor.compress(content); }
	compressFileBatch(contents: string[]): FileCompressionResult[] { return this._fileCompressor.compressBatch(contents); }

	// ─── Vision Search API (1:1 parity) ───────────────────────────────────

	async embedImage(imageRef: string, sessionId?: string, observationId?: string): Promise<VisionEmbedResult> { return this._visionSearch.embedImage(imageRef, sessionId, observationId); }
	async searchByImage(imageRef: string, limit?: number): Promise<VisionSearchResult[]> { return this._visionSearch.searchByImage(imageRef, limit); }
	getVisionSearchStats(): { totalEmbeddings: number; dimensions: number; modelName: string; providerAvailable: boolean } { return this._visionSearch.getStats(); }

	// ─── Image Quota Cleanup API (1:1 parity) ─────────────────────────────

	runImageQuotaCleanup(): ImageQuotaResult { return this._imageQuotaCleanup.cleanup(this._imageRefs); }

	// ─── Vector Index Migration API (1:1 parity) ──────────────────────────

	async migrateVectorIndex(config: VectorMigrationConfig, embedFn: (content: string) => Promise<Float32Array | number[] | null>): Promise<VectorMigrationResult> {
		const entries: MigratableVectorEntry[] = [];
		for (const [agentId, longEntries] of this._longTerm) {
			for (const e of longEntries) {
				entries.push({ id: e.id, content: e.content, modelName: e.metadata?.['modelName'] as string, dimensions: e.metadata?.['dimensions'] as number });
			}
		}
		return this._vectorIndexMigrator.migrate(entries, config, embedFn);
	}

	// ─── Project Resolver API (1:1 parity) ────────────────────────────────

	resolveProject(cwd?: string): string { return this._projectResolver.resolve(cwd); }

	// ─── Index Persistence API (1:1 parity) ───────────────────────────────

	getIndexPersistenceStats(): { totalSaves: number; totalLoads: number; lastSaveAt: number; pendingSave: boolean } { return this._indexPersistence.getStats(); }

	// ─── Reranker API (1:1 parity) ────────────────────────────────────────

	async rerankSearchResults(query: string, results: RerankableResult[], topK?: number): Promise<RerankedResult[]> { return rerank(query, results, topK); }
	rerankSearchResultsSimple(query: string, results: RerankableResult[], topK?: number): RerankedResult[] { return rerankSimple(query, results, topK); }
	isRerankerAvailable(): boolean { return isRerankerAvailable(); }

	// ─── Logger API (1:1 parity) ──────────────────────────────────────────

	getLogBuffer(filter?: { level?: LogLevel; module?: string; limit?: number }): LogEntry[] { return logger.getBuffer(filter); }
	getLogStats(): Record<LogLevel, number> & { total: number } { return logger.getStats(); }

	// ─── Prompts API (1:1 parity) ─────────────────────────────────────────

	getPromptTemplate(name: string): { name: string; systemPrompt: string; description: string } | null { return this._promptManager.get(name); }
	listPrompts(): Array<{ name: string; systemPrompt: string; description: string }> { return this._promptManager.list(); }

	// ─── Trigger System API (1:1 parity) ──────────────────────────────────

	registerTrigger(topic: TriggerTopic, handler: (payload: TriggerPayload) => void | Promise<void>, opts?: { priority?: number; once?: boolean }): string { return this._triggerSystem.register(topic, handler, opts); }
	unregisterTrigger(id: string): boolean { return this._triggerSystem.unregister(id); }
	async fireTrigger(topic: TriggerTopic, payload: Omit<TriggerPayload, 'topic' | 'timestamp'>): Promise<void> { return this._triggerSystem.fire(topic, payload); }
	getTriggerStats(): { totalTriggers: number; totalFired: number; totalErrors: number; triggersByTopic: Record<string, number> } { return this._triggerSystem.getStats(); }

	// ─── Health Thresholds API (1:1 parity) ───────────────────────────────

	evaluateHealth(dimension: HealthDimension, value: number): HealthLevel { return this._healthThresholds.evaluate(dimension, value); }
	evaluateHealthAll(metrics: Partial<Record<HealthDimension, number>>): Array<{ dimension: HealthDimension; value: number; level: HealthLevel }> { return this._healthThresholds.evaluateAll(metrics); }
	getHealthThreshold(dimension: HealthDimension): ThresholdConfig { return this._healthThresholds.getThreshold(dimension); }

	// ─── Image Store API (1:1 parity) ─────────────────────────────────────

	getImageStoreStats(): { totalImages: number; totalBytes: number; maxBytes: number; usageRatio: number; overQuota: boolean } { return this._imageStore.getStats(); }

	// ─── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * Pre-compact injection: Called by ContextManager before context compression.
	 * Returns memory context to inject into the compressed context.
	 */
	onPreCompact(agentId: string, sessionId: string, currentMessages: Array<{ role: string; content: string; timestamp: number }>, tokenBudget: number): PreCompactResult {
		// Fire pre_compact hook + compact.pre trigger (P1 optimization)
		const compactCtx = { agentId, sessionId, timestamp: Date.now(), currentMessages, tokenBudget };
		this._hooks.triggerAndCollect('pre_compact', compactCtx).catch(() => {});
		this._triggerSystem.fireSync('compact.pre', { agentId, sessionId, data: { messageCount: currentMessages.length, tokenBudget } });
		this._eventBus.emitSync({ type: 'custom', source: 'memoryProvider', agentId, data: { event: 'pre_compact', messageCount: currentMessages.length, tokenBudget } });

		return this._preCompactInjector.prepare(
			{ sessionId, agentId, currentMessages, tokenBudget },
			(this._longTerm.get(agentId) ?? []).filter(e => !e.supersededBy).map(e => ({
				id: e.id, content: e.content, score: e.strength, importance: e.importance,
				type: e.type, timestamp: e.timestamp ?? 0, metadata: e.metadata,
			})),
			[
				{ name: 'persona', content: this._slots.get(agentId, 'persona' as any) },
				{ name: 'guidance', content: this._slots.get(agentId, 'guidance' as any) },
			].filter(s => s.content.length > 0),
			this._getSlidingWindow(agentId).getAll().map(w => ({ id: w.id, content: w.content })),
		);
	}

	/**
	 * Called when a task is completed. Fires task.completed trigger + crystallize.
	 */
	onTaskCompleted(agentId: string, sessionId: string, taskSubject: string, taskId?: string): void {
		this._triggerSystem.fireSync('task.completed', { agentId, sessionId, data: { taskId, taskSubject } });
		this._hooks.triggerAndCollect('task_completed', { agentId, sessionId, timestamp: Date.now(), taskId, taskSubject }).catch(() => {});
		this._eventBus.emitSync({ type: 'custom', source: 'memoryProvider', agentId, data: { event: 'task_completed', taskId, taskSubject } });
	}

	/**
	 * Called when a git commit is made. Captures commit info into memory.
	 */
	onGitCommit(commit: CommitInfo): CommitMemoryEntry {
		const entry = this._postCommitCapture.capture(commit);
		this._triggerSystem.fireSync('commit.post', { data: { sha: commit.sha } });
		this._eventBus.emitSync({ type: 'custom', source: 'memoryProvider', data: { event: 'git_commit', sha: commit.sha } });
		return entry;
	}

	/**
	 * Called when a subagent starts.
	 */
	onSubagentStart(parentAgentId: string, task: string): SubagentRecord | null {
		const record = this._subagentTracker.start(parentAgentId, task);
		if (record) {
			this._triggerSystem.fireSync('subagent.start', { agentId: record.agentId, data: { parentAgentId, task } });
		}
		return record;
	}

	/**
	 * Called when a subagent stops.
	 */
	onSubagentStop(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean {
		const success = this._subagentTracker.stop(agentId, status, result, error);
		if (success) {
			this._triggerSystem.fireSync('subagent.stop', { agentId, data: { status, result: result?.slice(0, 200) } });
		}
		return success;
	}

	private _isFileTool(toolName: string): boolean {
		const lower = toolName.toLowerCase();
		return lower.includes('file') || lower.includes('read') || lower.includes('write')
			|| lower.includes('edit') || lower.includes('open') || lower.includes('search')
			|| lower.includes('grep') || lower.includes('find');
	}

	private _extractFilePath(metadata: Record<string, unknown>): string | null {
		const args = metadata['toolArgs'];
		if (typeof args === 'string') {
			// Try to extract path from args string
			const match = args.match(/[\w:/\\.-]+\.\w+/);
			if (match) return match[0];
		}
		if (typeof args === 'object' && args !== null) {
			const obj = args as Record<string, unknown>;
			const path = obj['path'] ?? obj['filePath'] ?? obj['file'];
			if (typeof path === 'string') return path;
		}
		return null;
	}

	/**
	 * Force flush all pending writes to disk.
	 * Called by the detail pane's "refresh" button.
	 */
	async flush(): Promise<void> {
		await this._flushPendingWrites();
		this._audit.record('flush', '', [], { dirtyAgents: this._dirtyAgents.size });
	}

	/**
	 * Get audit log entries for diagnostics.
	 */
	getAuditLog(filter?: { operation?: string; agentId?: string; limit?: number }): unknown[] {
		return this._audit.query(filter as any);
	}

	/**
	 * Get audit summary statistics.
	 */
	getAuditSummary(): Record<string, number> {
		return this._audit.getSummary() as Record<string, number>;
	}

	// ─── Periodic sweep: decay + auto-forget + cap ──────────────────────────

	/**
	 * Run decay + eviction sweep across all loaded agents.
	 * Called periodically (every 6 hours) and can be triggered manually.
	 */
	private async _runSweep(): Promise<void> {
		const agentIds = Array.from(this._loaded);
		for (const agentId of agentIds) {
			await this._sweepAgent(agentId);
		}
		// Clean up stale _pendingUser entries (user message without matching assistant response)
		// These accumulate when a user sends a message but the agent crashes/times out before responding
		const PENDING_USER_TTL_MS = 5 * 60 * 1000; // 5 minutes
		for (const [agentId] of this._pendingUser) {
			const session = this._activeSessions.get(agentId);
			if (session && Date.now() - session.startedAt > PENDING_USER_TTL_MS) {
				this._pendingUser.delete(agentId);
			}
		}
	}

	private async _sweepAgent(agentId: string): Promise<void> {
		const longEntries = this._longTerm.get(agentId);
		if (!longEntries) return;

		const now = Date.now();
		const maxAgeMs = LOW_IMPORTANCE_MAX_DAYS * 24 * 60 * 60 * 1000;
		const bm25 = this._bm25.get(agentId);
		const vector = this._vector.get(agentId);

		let evicted = 0;
		const remaining: InternalMemoryEntry[] = [];

		for (const entry of longEntries) {
			let shouldEvict = false;
			let reason = '';

			// 0. TTL expiration (forgetAfter) — from agentmemory auto-forget
			if (entry.forgetAfter && now > entry.forgetAfter) {
				shouldEvict = true;
				reason = 'ttl_expired';
			}

			// 1. Superseded entries older than 30 days
			if (!shouldEvict && entry.supersededBy) {
				const age = now - (entry.timestamp ?? now);
				if (age > 30 * 24 * 60 * 60 * 1000) {
					shouldEvict = true;
					reason = 'superseded_old';
				}
			}

			// 2. Strength below floor
			if (!shouldEvict && entry.strength < STRENGTH_FLOOR) {
				shouldEvict = true;
				reason = 'strength_below_floor';
			}

			// 3. Low importance + old
			if (!shouldEvict && (entry.importance ?? 5) < LOW_IMPORTANCE_THRESHOLD) {
				const age = now - (entry.timestamp ?? now);
				if (age > maxAgeMs) {
					shouldEvict = true;
					reason = 'low_importance_old';
				}
			}

			if (shouldEvict) {
				bm25?.remove(entry.id);
				vector?.remove(entry.id);
				evicted++;
			} else {
				remaining.push(entry);
			}
		}

		// 4. Cap: if too many entries, evict weakest first
		if (remaining.length > MAX_LONG_TERM_ENTRIES) {
			remaining.sort((a, b) => (a.strength ?? 0) - (b.strength ?? 0));
			const toEvict = remaining.splice(0, remaining.length - MAX_LONG_TERM_ENTRIES);
			for (const entry of toEvict) {
				bm25?.remove(entry.id);
				vector?.remove(entry.id);
				evicted++;
			}
			// Re-sort by timestamp
			remaining.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		}

		if (evicted > 0) {
			this._longTerm.set(agentId, remaining);
			await this._persistLongTerm(agentId);
			this._audit.record('sweep', agentId, [], { evicted, remaining: remaining.length });
			console.log(`[AgentMemory] sweep: agent=${agentId} evicted=${evicted} (remaining=${remaining.length})`);
		}

		// Apply decay to remaining entries
		applyDecay(remaining);
		this._audit.record('decay', agentId, [], { entryCount: remaining.length });

		// Retention scoring (lambda decay + reinforcement boost + tiers)
		const retentionResult = this._retentionScorer.scoreAll(
			remaining.map(e => ({
				id: e.id,
				type: e.type,
				content: e.content,
				strength: e.strength,
				confidence: e.metadata?.['confidence'] as number | undefined,
				importance: e.importance,
				timestamp: e.timestamp ?? Date.now(),
				accessCount: e.accessCount,
				lastAccessedAt: e.lastAccessedAt,
				supersededBy: e.supersededBy,
			})),
			'episodic',
		);
		if (retentionResult.total > 0) {
			this._audit.record('retention', agentId, [], { ...retentionResult.tiers });
		}

		// Prune stale graph nodes/edges (cascade cleanup)
		const graph = this._graphs.get(agentId);
		if (graph) {
			const pruned = graph.pruneStale();
			if (pruned.nodes > 0 || pruned.edges > 0) {
				this._audit.record('cascade', agentId, [], { pruned });
			}
		}

		// Extract lessons from long-term memories (throttled to 24h)
		const extractedLessons = this._lessons.extract(agentId, remaining);
		if (extractedLessons.length > 0) {
			this._audit.record('consolidate', agentId, [], { lessonsExtracted: extractedLessons.length });
		}

		// Run 4-tier consolidation pipeline (Episodic → Semantic → Procedural)
		const pipeline = this._consolidation.get(agentId) ?? new ConsolidationPipeline();
		this._consolidation.set(agentId, pipeline);
		const consolResult = await pipeline.consolidate(agentId, remaining);
		if (consolResult.newEpisodic + consolResult.newSemantic + consolResult.newProcedural > 0) {
			this._audit.record('consolidate', agentId, [], consolResult);
		}

		// Reflect: auto-update slots from recent observations
		const reflectResult = this._reflector.reflect(agentId, remaining, this._slots);
		if (reflectResult.todosAdded + reflectResult.preferencesAdded + reflectResult.conventionsAdded > 0) {
			this._audit.record('consolidate', agentId, [], { reflect: reflectResult });
		}
	}

	// ─── Session lifecycle ──────────────────────────────────────────────────

	/**
	 * Start a session for tracking. Called implicitly by loadContext.
	 */
	private _startSession(agentId: string, sessionId: string): void {
		this._activeSessions.set(agentId, {
			sessionId,
			startedAt: Date.now(),
			observationCount: 0,
		});
	}

	/**
	 * End a session. Creates a session summary entry.
	 */
	private _endSession(agentId: string): InternalMemoryEntry | null {
		const session = this._activeSessions.get(agentId);
		if (!session) return null;
		this._activeSessions.delete(agentId);

		const durationMs = Date.now() - session.startedAt;
		const summary: InternalMemoryEntry = {
			id: `session-summary-${session.sessionId}-${Date.now()}`,
			type: 'episodic',
			content: `会话摘要：${session.observationCount} 次观察，持续 ${Math.round(durationMs / 1000)}s`,
			timestamp: Date.now(),
			importance: 6,
			strength: 1.0,
			accessCount: 0,
			lastAccessedAt: Date.now(),
			metadata: {
				source: 'session_end',
				sessionId: session.sessionId,
				observationCount: session.observationCount,
				durationMs,
			},
		};
		return summary;
	}

	// ─── IMemoryProvider implementation ──────────────────────────────────────

	async loadContext(
		agentId: string,
		sessionId: string,
		query?: string,
		options?: any,
	): Promise<IMemoryContext> {
		await this._ensureLoaded(agentId);

		// Track session
		if (!this._activeSessions.has(agentId)) {
			this._startSession(agentId, sessionId);
			// Fire session.started trigger + session_start hook
			this._triggerSystem.fireSync('session.started', { agentId, sessionId });
			this._hooks.triggerAndCollect('session_start', { agentId, sessionId, timestamp: Date.now() }).catch(() => {});
			this._eventBus.emitSync({ type: 'session_started', source: 'memoryProvider', agentId, data: { sessionId } });
		}

		const longEntries = this._longTerm.get(agentId) ?? [];
		const shortEntries = this._shortTerm.get(agentId) ?? [];

		// If we have a query, do hybrid search for long-term memories
		// but STILL include short-term memories and structured context (Slots/WorkingMemory/Consolidation)
		if (query && query.trim().length > 0) {
			const results = await this._hybridSearch(agentId, query, 10);
			// Include recent short-term (Working) memories — these are the current session's context
			const topShort = shortEntries.slice(-15).map(e => this._toPublicEntry(e));
			// Build structured context (Slots + WorkingMemory + Consolidation)
			const structuredPrompt = this._slots.buildSystemPrompt(agentId)
				+ '\n\n' + this._workingMemory.buildContext(agentId)
				+ (this._consolidation.get(agentId)?.buildContext(agentId) ?? '');
			return {
				shortTermMemories: topShort,
				longTermMemories: results,
				systemPrompt: structuredPrompt,
				relevantDocuments: [],
			};
		}

		// No query → return top entries by strength (adaptive token budget)
		const eligibleLong = [...longEntries]
			.filter(e => !e.supersededBy && e.strength > STRENGTH_FLOOR)
			.sort((a, b) => b.strength - a.strength);

		// Merge with sliding window entries (recently accessed memories)
		const window = this._getSlidingWindow(agentId);
		const windowEntries = window.getAll();
		const windowIds = new Set(windowEntries.map(w => w.id));
		const fromWindow = eligibleLong.filter(e => windowIds.has(e.id));
		const fromLong = eligibleLong.filter(e => !windowIds.has(e.id));
		// Window entries first (recently accessed), then by strength
		const mergedLong = [...fromWindow, ...fromLong];

		// Use token budget instead of fixed count
		const publicEntries = mergedLong.map(e => this._toPublicEntry(e));
		const budgetResult = selectWithBudget(
			publicEntries,
			this._tokenBudget,
			e => e.metadata?.['strength'] as number ?? 0.5,
			e => e.content,
		);
		const topLong = budgetResult.selected;

		// Record accessed entries in sliding window
		for (const e of topLong) {
			window.access({
				id: e.id,
				content: e.content,
				type: e.type,
				timestamp: e.timestamp ?? Date.now(),
				score: e.score ?? e.importance ?? 5,
				source: 'restore' as const,
			});
		}

		const topShort = shortEntries.slice(-15).map(e => this._toPublicEntry(e));

		this._audit.record('search', agentId, [], {
			mode: 'profile',
			longTermCount: topLong.length,
			tokensUsed: budgetResult.tokensUsed,
			truncated: budgetResult.truncated,
		});

		return {
			shortTermMemories: topShort,
			longTermMemories: topLong,
			systemPrompt: this._slots.buildSystemPrompt(agentId)
				+ '\n\n' + this._workingMemory.buildContext(agentId)
				+ '\n\n' + this._buildSystemPrompt(topLong, topShort)
				+ (this._consolidation.get(agentId)?.buildContext(agentId) ?? ''),
			relevantDocuments: [],
		};
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		// Extract noticeId from metadata for UI correlation (pending → saved/failed)
		const noticeId = (entry.metadata?.['noticeId'] as string | undefined);
		const memoryType = (entry.metadata?.['memoryType'] as string | undefined) ?? entry.type;

		try {
			const didEmit = await this._writeMemoryInner(agentId, entry);
			// P3-3: Invalidate search cache for this agent (new memory changes search results)
			this._searchCache.invalidateAgent(agentId);
			// Only emit a guarantee event if _writeMemoryInner did NOT already emit one
			// (early returns: empty content, duplicate, buffered user).
			// contentLength: 0 signals the UI to remove the pending card (nothing meaningful saved).
			if (noticeId && !didEmit) {
				this._eventBus.emitSync({
					type: 'memory_written',
					source: 'memoryProvider',
					agentId,
					data: { memoryId: '', type: entry.type, contentLength: 0, noticeId, memoryType },
				});
			}
		} catch (error) {
			// Emit memory_write_failed event for UI feedback
			this._eventBus.emitSync({
				type: 'custom',
				source: 'memoryProvider',
				agentId,
				data: {
					event: 'memory_write_failed',
					noticeId,
					error: error instanceof Error ? error.message : String(error),
					memoryType,
				},
			});
			throw error;
		}
	}

	private async _writeMemoryInner(agentId: string, entry: IMemoryEntry): Promise<boolean> {
		await this._ensureLoaded(agentId);

		// Track observation count for session summary
		const session = this._activeSessions.get(agentId);
		if (session) session.observationCount++;

		// Privacy filter
		const sanitizedContent = stripPrivateData(stripUndefinedLiterals(entry.content));
		if (!sanitizedContent) return false;

		// BloomFilter pre-filter (fast probabilistic check before SHA-256)
		let bloom = this._bloomFilters.get(agentId);
		if (!bloom) {
			bloom = new BloomFilter(10000, 0.01);
			this._bloomFilters.set(agentId, bloom);
		}
		if (bloom.mightContain(sanitizedContent)) {
			// Possible duplicate, confirm with precise check
			const dedup = this._dedup.get(agentId) ?? new DedupManager();
			this._dedup.set(agentId, dedup);
			const isDup = await dedup.isDuplicate(sanitizedContent);
			if (isDup) {
				this._audit.record('dedup_skip', agentId, [entry.id], { contentLength: sanitizedContent.length });
				return false;
			}
		} else {
			// Definitely not a duplicate, add to bloom filter
			bloom.add(sanitizedContent);
		}

		// Infer role (like TdbAmMemoryProvider)
		const md = entry.metadata ?? {};
		const hasToolCalls = typeof md['toolCalls'] === 'number' || typeof md['toolCalls'] === 'object'
			|| typeof md['toolResults'] === 'number' || typeof md['toolResults'] === 'object';
		const role = (md['role'] as string) ?? (hasToolCalls ? 'assistant' : (this._pendingUser.has(agentId) ? 'assistant' : 'user'));

		if (entry.type === 'working') {
			if (role === 'user') {
				this._pendingUser.set(agentId, sanitizedContent);
				return false;
			}

			// Assistant: create short-term entry
			const internal: InternalMemoryEntry = {
				...entry,
				content: sanitizedContent,
				timestamp: entry.timestamp ?? Date.now(),
				strength: 1.0,
				accessCount: 0,
				lastAccessedAt: Date.now(),
			};

			const short = this._shortTerm.get(agentId) ?? [];
			short.push(internal);
			while (short.length > SHORT_TERM_LIMIT) short.shift();
			this._shortTerm.set(agentId, short);
			this._pendingUser.delete(agentId);

			// Record replay event
			const sessionId = this._activeSessions.get(agentId)?.sessionId ?? agentId;
			this._replay.recordEvent(sessionId, {
				type: role === 'user' ? 'user_prompt' : 'tool_call',
				toolName: (md['toolName'] as string) ?? undefined,
				content: sanitizedContent.slice(0, 200),
				success: md['toolResults'] !== undefined,
			});

			// Record file access if tool is file-related
			const toolName = (md['toolName'] as string) ?? '';
			if (this._isFileTool(toolName)) {
				const filePath = this._extractFilePath(md);
				if (filePath) {
					const mode: FileAccessMode = toolName.toLowerCase().includes('write') || toolName.toLowerCase().includes('edit')
						? 'modify' : 'read';
					this._fileIndex.record(agentId, filePath, mode, internal.id, md['error'] !== undefined);
				}
			}

			await this._persistShortTerm(agentId);

			// Emit memory_written for working memory with real content length
			const noticeIdW = (md['noticeId'] as string | undefined);
			this._eventBus.emitSync({ type: 'memory_written', source: 'memoryProvider', agentId, data: { memoryId: internal.id, type: entry.type, contentLength: sanitizedContent.length, noticeId: noticeIdW, memoryType: (md['memoryType'] as string | undefined) ?? entry.type } });
			return true;
		}

		// Long-term memory
		// Compress: extract structured fields (facts/concepts/files/title) from raw content
		let compressedContent = sanitizedContent;
		let compressedMeta: Record<string, unknown> = { ...md };
		if (sanitizedContent.length > 100) {
			try {
				const compressed = await compress(sanitizedContent, md);
				compressedContent = compressed.narrative || sanitizedContent;
				compressedMeta = {
					...compressedMeta,
					title: compressed.title,
					facts: compressed.facts,
					concepts: compressed.concepts,
					files: compressed.files,
					importance: compressed.importance,
					compressed: true,
				};
			} catch {
				// Compression failed, use raw content
				const synthetic = compressSynthetic(sanitizedContent, md);
				compressedMeta = { ...compressedMeta, title: synthetic.title, concepts: synthetic.concepts, files: synthetic.files, compressed: 'synthetic' };
			}
		}

		const internal: InternalMemoryEntry = {
			...entry,
			content: compressedContent,
			metadata: compressedMeta,
			timestamp: entry.timestamp ?? Date.now(),
			strength: 1.0,
			accessCount: 0,
			lastAccessedAt: Date.now(),
		};

		// Contradiction detection: check for similar existing memories
		await this._detectContradiction(agentId, internal);

		const long = this._longTerm.get(agentId) ?? [];
		long.push(internal);
		this._longTerm.set(agentId, long);

		// Update indexes
		const bm25 = this._bm25.get(agentId) ?? new BM25Index();
		bm25.add(internal.id, sanitizedContent);
		this._bm25.set(agentId, bm25);

		const vector = this._vector.get(agentId) ?? new VectorIndex();
		const vec = embedSyncCached(sanitizedContent);
		if (vec) vector.add(internal.id, vec);
		this._vector.set(agentId, vector);

		// Async: upgrade to real embedding
		const realVec = await embed(sanitizedContent);
		if (realVec) {
			vector.remove(internal.id);
			vector.add(internal.id, realVec);
		}

		// Extract entities into knowledge graph
		const graph = this._graphs.get(agentId) ?? new KnowledgeGraph();
		this._graphs.set(agentId, graph);
		graph.extractFromMemory(internal.id, sanitizedContent, agentId);

		// Record provenance (trace memory to source)
		const provenance = this._provenance.get(agentId) ?? new ProvenanceTracker();
		this._provenance.set(agentId, provenance);
		const sourceIds = (md['sourceIds'] as string[]) ?? [];
		provenance.record(internal.id, 'long_term', sourceIds.length > 0 ? sourceIds : [internal.id]);
		graph.extractFromMemory(internal.id, sanitizedContent, agentId);

		// Extract temporal relationships into temporal graph
		const temporalGraph = this._temporalGraphs.get(agentId) ?? new TemporalGraph();
		this._temporalGraphs.set(agentId, temporalGraph);
		const concepts = (compressedMeta['concepts'] as string[]) ?? [];
		const files = (compressedMeta['files'] as string[]) ?? [];
		for (const concept of concepts) {
			temporalGraph.addNode(concept, 'concept');
		}
		for (const file of files) {
			temporalGraph.addNode(file, 'file');
		}
		// Add edges between co-occurring concepts/files
		const allEntities = [...concepts, ...files];
		for (let i = 0; i < allEntities.length; i++) {
			for (let j = i + 1; j < allEntities.length; j++) {
				const srcNode = temporalGraph.findNode(allEntities[i]);
				const tgtNode = temporalGraph.findNode(allEntities[j]);
				if (srcNode && tgtNode) {
					temporalGraph.addEdge(srcNode.id, tgtNode.id, 'related_to', {
						sourceMemoryIds: [internal.id],
					});
				}
			}
		}

		// Invalidate cached profile (will regenerate on next loadContext)
		this._profiles.delete(agentId);

		// Record in sliding window
		this._getSlidingWindow(agentId).access({
			id: internal.id,
			content: compressedContent,
			type: entry.type,
			timestamp: internal.timestamp ?? Date.now(),
			score: (compressedMeta['importance'] as number) ?? 5,
			source: 'write' as const,
		});

		await this._persistLongTerm(agentId);

		this._audit.record('write', agentId, [internal.id], {
			type: entry.type,
			contentLength: compressedContent.length,
			role,
			compressed: compressedMeta['compressed'] ?? false,
		});

		// Fire observation trigger + post_tool_use hook + memory_written event
		this._triggerSystem.fireSync('observation', { agentId, sessionId: this._activeSessions.get(agentId)?.sessionId ?? agentId, data: { memoryId: internal.id, type: entry.type } });
		const hasTool = typeof md['toolName'] === 'string';
		if (hasTool) {
			this._hooks.triggerAndCollect('post_tool_use', { agentId, sessionId: this._activeSessions.get(agentId)?.sessionId ?? agentId, timestamp: Date.now(), toolName: md['toolName'] as string, toolResult: sanitizedContent.slice(0, 2000) }).catch(() => {});
		}
		// Include noticeId in event data for UI card correlation (pending → saved)
		const noticeId = (md['noticeId'] as string | undefined);
		this._eventBus.emitSync({ type: 'memory_written', source: 'memoryProvider', agentId, data: { memoryId: internal.id, type: entry.type, contentLength: compressedContent.length, noticeId, memoryType: (md['memoryType'] as string | undefined) ?? entry.type } });
		return true;
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		await this._ensureLoaded(agentId);

		// P3-3: Check search cache first (skip for empty queries — list-all is cheap)
		if (query && query.trim().length > 0) {
			const cached = this._searchCache.get(agentId, query);
			if (cached) {
				return cached;
			}
		}

		if (!query || query.trim().length === 0) {
			// List all — include BOTH short-term (working) and long-term memories
			const long = this._longTerm.get(agentId) ?? [];
			const short = this._shortTerm.get(agentId) ?? [];
			const allEntries = [
				...long.filter(e => !e.supersededBy),
				...short.filter(e => !e.supersededBy),
			];
			return allEntries
				.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
				.slice(0, 100)
				.map(e => this._toPublicEntry(e));
		}

		const startTime = Date.now();
		const results = await this._hybridSearch(agentId, query, 20);

		// P3-3: Cache the search results
		this._searchCache.set(agentId, query, results);

		// Record search history
		this._recentSearches.record({
			agentId,
			query,
			resultCount: results.length,
			resultIds: results.map(r => r.id),
			durationMs: Date.now() - startTime,
			source: 'manual',
		});

		// Fire memory_searched event
		this._eventBus.emitSync({ type: 'memory_searched', source: 'memoryProvider', agentId, data: { query: query.slice(0, 80), resultCount: results.length, durationMs: Date.now() - startTime } });

		return results;
	}

	// ─── Hybrid search (BM25 + Vector + substring, RRF fusion) ───────────────

	private async _hybridSearch(agentId: string, query: string, limit: number): Promise<IMemoryEntry[]> {
		const bm25 = this._bm25.get(agentId);
		const vector = this._vector.get(agentId);
		const graph = this._graphs.get(agentId);
		const longEntries = this._longTerm.get(agentId) ?? [];
		const shortEntries = this._shortTerm.get(agentId) ?? [];
		// Include both short-term (working) and long-term in the entryMap
		// so substring search and result mapping can find working memories
		const entryMap = new Map([
			...longEntries.map(e => [e.id, e] as const),
			...shortEntries.map(e => [e.id, e] as const),
		]);

		// 0. Query expansion: synonyms + entity extraction
		const expansion = expandQuery(query);
		const allQueries = [query, ...expansion.reformulations];
		const entityNames = expansion.entityExtractions.length > 0
			? expansion.entityExtractions
			: KnowledgeGraph.extractEntityNames(query);

		// 1. BM25 search (across original + expanded queries)
		const bm25Raw = new Map<string, { id: string; score: number }>();
		for (const q of allQueries) {
			for (const r of bm25?.search(q, limit * 2) ?? []) {
				const existing = bm25Raw.get(r.id);
				if (!existing || r.score > existing.score) {
					bm25Raw.set(r.id, r);
				}
			}
		}
		const bm25Results = Array.from(bm25Raw.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit * 2);

		// 2. Vector search (original query only — expansion doesn't help vector)
		const vectorResults = await vector?.search(query, limit * 2) ?? [];

		// 3. Graph search (3rd stream — BFS from entities in query)
		let graphResults: GraphRetrievalResult[] = [];
		if (graph && entityNames.length > 0) {
			graphResults = graph.searchByEntities(entityNames, 2, limit * 2);
		}

		// 4. Substring fallback — search both long-term and short-term (working) memories
		const textQuery = query.toLowerCase();
		const allEntries = [...longEntries, ...shortEntries];
		const textResults = allEntries
			.filter(e => !e.supersededBy && e.content.toLowerCase().includes(textQuery))
			.slice(0, limit * 2)
			.map(e => ({ id: e.id, score: 0 }));

		// 5. RRF fusion (4 streams: BM25 + Vector + Graph + substring)
		// Uses config-derived weights (hot-reloadable via ConfigManager.onChange)
		const bm25Weight = this._searchWeights.bm25;
		const vectorWeight = vector && vector.size > 0 ? this._searchWeights.vector : 0;
		const graphWeight = graphResults.length > 0 ? this._searchWeights.graph : 0;
		const textWeight = this._searchWeights.text;
		const totalW = bm25Weight + vectorWeight + graphWeight + textWeight || 1;
		const rrfK = this._rrfK;

		const scores = new Map<string, number>();

		bm25Results.forEach((r, i) => {
			scores.set(r.id, (bm25Weight / totalW) * (1 / (rrfK + i + 1)));
		});

		vectorResults.forEach((r, i) => {
			const existing = scores.get(r.id) ?? 0;
			scores.set(r.id, existing + (vectorWeight / totalW) * (1 / (rrfK + i + 1)));
		});

		graphResults.forEach((r, i) => {
			const existing = scores.get(r.obsId) ?? 0;
			scores.set(r.obsId, existing + (graphWeight / totalW) * (1 / (rrfK + i + 1)));
		});

		textResults.forEach((r, i) => {
			const existing = scores.get(r.id) ?? 0;
			scores.set(r.id, existing + (textWeight / totalW) * (1 / (rrfK + i + 1)));
		});

		// Sort + session diversify (max 3 per session) + convert
		const sortedAll = Array.from(scores.entries())
			.sort((a, b) => b[1] - a[1]);

		// Session diversification: max 3 results per sessionKey
		const MAX_PER_SESSION = this._searchWeights.maxPerSession;
		const sessionCounts = new Map<string, number>();
		const sorted: [string, number][] = [];
		const overflow: [string, number][] = [];
		for (const [id, score] of sortedAll) {
			const entry = entryMap.get(id);
			const sessionKey = (entry?.metadata?.['sessionKey'] as string) ?? 'default';
			const count = sessionCounts.get(sessionKey) ?? 0;
			if (count < MAX_PER_SESSION) {
				sorted.push([id, score]);
				sessionCounts.set(sessionKey, count + 1);
			} else {
				overflow.push([id, score]);
			}
		}
		// If not enough after diversification, add overflow
		while (sorted.length < limit && overflow.length > 0) {
			sorted.push(overflow.shift()!);
		}
		const finalSorted = sorted.slice(0, limit);

		const results: IMemoryEntry[] = [];
		for (const [id, score] of finalSorted) {
			const entry = entryMap.get(id);
			if (!entry) continue;
			reinforce(entry);
			// Track access in AccessTracker for pattern analysis
			this._accessTracker.record(agentId, entry.id);
			results.push(this._toPublicEntry(entry, score));
		}

		// Persist reinforcement (async, best-effort)
		this._persistLongTerm(agentId).catch(() => { /* best effort */ });

		this._audit.record('search', agentId, results.map(r => r.id), {
			mode: 'hybrid',
			query: query.slice(0, 80),
			resultCount: results.length,
			bm25Size: bm25?.size ?? 0,
			vectorSize: vector?.size ?? 0,
		});

		return results;
	}

	// ─── Contradiction detection ────────────────────────────────────────────

	private async _detectContradiction(agentId: string, newEntry: InternalMemoryEntry): Promise<void> {
		const vector = this._vector.get(agentId);
		if (!vector || vector.size === 0) return;

		const newVec = await embed(newEntry.content);
		if (!newVec) return;

		const longEntries = this._longTerm.get(agentId) ?? [];
		for (const existing of longEntries) {
			if (existing.supersededBy) continue;
			if (existing.id === newEntry.id) continue;

			// Check similarity via vector
			const existingVec = await embed(existing.content);
			if (!existingVec) continue;

			const sim = cosineSim(newVec, existingVec);
			if (sim > 0.85) {
				// Mark existing as superseded
				existing.supersededBy = newEntry.id;
				this._audit.record('contradiction', agentId, [existing.id, newEntry.id], { similarity: sim });
				console.log(`[AgentMemory] contradiction detected: ${existing.id} superseded by ${newEntry.id} (sim=${sim.toFixed(2)})`);

				// Cascade: mark related graph nodes/edges/sibling memories as stale
				const graph = this._graphs.get(agentId);
				const allEntries = this._longTerm.get(agentId) ?? [];
				const cascadeResult = this._cascade.cascadeFromSupersede(
					{
						id: existing.id,
						content: existing.content,
						concepts: (existing.metadata?.['concepts'] as string[]) ?? [],
						sourceObservationIds: [existing.id],
					},
					allEntries.map(e => ({
						id: e.id,
						content: e.content,
						concepts: (e.metadata?.['concepts'] as string[]) ?? [],
						sourceObservationIds: [e.id],
						supersededBy: e.supersededBy,
						metadata: e.metadata,
					})),
					graph,
				);
				if (cascadeResult.total > 0) {
					this._audit.record('cascade', agentId, [existing.id], { ...cascadeResult });
				}
			}
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _toPublicEntry(entry: InternalMemoryEntry, score?: number): IMemoryEntry {
		return {
			id: entry.id,
			type: entry.type,
			content: entry.content,
			metadata: {
				...entry.metadata,
				strength: entry.strength,
				accessCount: entry.accessCount,
				lastAccessedAt: entry.lastAccessedAt,
				supersededBy: entry.supersededBy,
			},
			timestamp: entry.timestamp,
			importance: entry.importance,
			score,
		};
	}

	private _buildSystemPrompt(longTerm: IMemoryEntry[], shortTerm: IMemoryEntry[]): string {
		const out: string[] = [];
		if (longTerm.length > 0) {
			out.push('## Long-term memory');
			for (const e of longTerm.slice(0, 10)) {
				const imp = e.importance ? ` [${e.importance}/10]` : '';
				out.push(`-${imp} ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		if (shortTerm.length > 0) {
			out.push('');
			out.push('## Recent context');
			for (const e of shortTerm.slice(-15)) {
				out.push(`- ${e.content.replace(/\s+/g, ' ').slice(0, 240)}`);
			}
		}
		return out.join('\n');
	}

	// ─── Sketches API ────────────────────────────────────────────────────────

	/** Create a temporary sketch (action graph) */
	createSketch(opts: SketchCreateOptions): Sketch {
		return this._sketchManager.create(opts);
	}

	/** Add an action to a sketch */
	addSketchAction(opts: SketchAddActionOptions): { action: import('./sketches.js').SketchAction; edges: ActionEdge[] } {
		return this._sketchManager.addAction(opts);
	}

	/** Promote a sketch to permanent actions */
	promoteSketch(sketchId: string, project?: string): SketchPromoteResult {
		return this._sketchManager.promote(sketchId, project);
	}

	/** Discard a sketch and all its actions */
	discardSketch(sketchId: string): SketchDiscardResult {
		return this._sketchManager.discard(sketchId);
	}

	/** List sketches (optionally filtered) */
	listSketches(filter?: { status?: SketchStatus; project?: string }): Array<Sketch & { actionCount: number }> {
		return this._sketchManager.list(filter);
	}

	/** Get a sketch by ID */
	getSketch(sketchId: string): Sketch | undefined {
		return this._sketchManager.get(sketchId);
	}

	/** Get actions in a sketch */
	getSketchActions(sketchId: string): import('./sketches.js').SketchAction[] {
		return this._sketchManager.getActions(sketchId);
	}

	/** GC expired sketches */
	gcSketches(): SketchGcResult {
		return this._sketchManager.gc();
	}

	/** Get sketch stats */
	getSketchStats(): { total: number; active: number; promoted: number; discarded: number; totalActions: number; totalEdges: number } {
		return this._sketchManager.getStats();
	}

	// ─── Obsidian Export API ─────────────────────────────────────────────────

	/** Export memories to Obsidian vault format (returns file list for caller to write) */
	exportToObsidian(dataSources: ObsidianExportDataSources, types?: string[]): {
		files: Array<{ path: string; content: string }>;
		stats: { memories: number; lessons: number; crystals: number; sessions: number };
		errors: Array<{ id: string; error: string }>;
	} {
		return exportToObsidian(dataSources, types);
	}

	/** Export current agent's memories to Obsidian format */
	exportAgentToObsidian(agentId: string, types?: string[]): {
		files: Array<{ path: string; content: string }>;
		stats: { memories: number; lessons: number; crystals: number; sessions: number };
		errors: Array<{ id: string; error: string }>;
	} {
		const longEntries = this._longTerm.get(agentId) ?? [];
		const memories = longEntries
			.filter(e => !e.supersededBy && e.isLatest !== false)
			.map(e => ({
				id: e.id, type: e.type, title: (e.metadata?.title as string) ?? '', content: e.content,
				concepts: e.metadata?.concepts as string[] ?? [],
				files: e.metadata?.files as string[] ?? [],
				createdAt: e.timestamp ? new Date(e.timestamp).toISOString() : undefined,
				strength: e.strength, isLatest: true,
			}));
		const lessons = this._lessons.getLessons(agentId);
		return exportToObsidian({ memories, lessons }, types);
	}

	// ─── Synonyms API ────────────────────────────────────────────────────────

	/** Get synonyms for a stemmed term */
	getSynonyms(stemmedTerm: string): string[] {
		return getSynonyms(stemmedTerm);
	}

	/** Add a custom synonym group at runtime */
	addSynonymGroup(words: string[]): void {
		addSynonymGroup(words);
	}

	// ─── Embedding Provider API ──────────────────────────────────────────────

	/** Get the active external embedding provider (null = local xenova or BM25-only) */
	getExternalEmbeddingProvider(): import('./noopProvider.js').EmbeddingProvider | null {
		return this._externalEmbeddingProvider;
	}

	/** Get the name of the active embedding provider */
	getEmbeddingProviderName(): string {
		return this._externalEmbeddingProvider?.name ?? 'local-xenova';
	}
}

// ─── Sync embedding cache (for initial load before @xenova loads) ──────────

// LRU-bounded embed cache — prevents unbounded memory growth from unique content strings
const _embedCache = new Map<string, Float32Array>();
const _EMBED_CACHE_MAX = 500;

function embedSyncCached(text: string): Float32Array | null {
	const cached = _embedCache.get(text);
	if (cached) {
		// LRU: move to end (Map preserves insertion order)
		_embedCache.delete(text);
		_embedCache.set(text, cached);
		return cached;
	}
	// Simple trigram-based pseudo embedding
	const vec = new Float32Array(384);
	const normalized = text.toLowerCase();
	for (let i = 0; i < normalized.length - 2; i++) {
		const hash = normalized.charCodeAt(i) + normalized.charCodeAt(i + 1) * 31 + normalized.charCodeAt(i + 2) * 961;
		vec[Math.abs(hash) % 384] += 1;
	}
	let norm = 0;
	for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < 384; i++) vec[i] /= norm;
	// LRU eviction: remove oldest entry if at capacity
	if (_embedCache.size >= _EMBED_CACHE_MAX) {
		const oldestKey = _embedCache.keys().next().value;
		if (oldestKey) _embedCache.delete(oldestKey);
	}
	_embedCache.set(text, vec);
	return vec;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
